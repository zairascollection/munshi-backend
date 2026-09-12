const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireDeletePermission } = require("../middleware/auth");
const { scrubForRole, isManagerOrAbove } = require("../utils/permissions");
const { logChanges } = require("../utils/auditLog");

const router = express.Router();
router.use(requireAuth);

const MANUAL_COLUMNS = [
  "order_no", "customer", "phone", "product", "qty", "sell", "cost",
  "courier", "tracking", "status", "amount_paid", "due_date", "method", "date",
  "billed_by", "return_reason", "city", "channel",
  "delivery_charge", "return_charge", "refund_amount", "restocked",
  "returned_at", "delivered_at",
];

// Staff can't write cost. Managers and owners can (they can see it too).
const writableColumns = (req) =>
  isManagerOrAbove(req.user) ? MANUAL_COLUMNS : MANUAL_COLUMNS.filter((c) => c !== "cost");

router.get("/", async (req, res) => {
  const { status, source, from, to } = req.query;
  const clauses = [];
  const values = [];
  if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
  if (source) { values.push(source); clauses.push(`source = $${values.length}`); }
  if (from) { values.push(from); clauses.push(`date >= $${values.length}`); }
  if (to) { values.push(to); clauses.push(`date <= $${values.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(`SELECT * FROM orders ${where} ORDER BY date DESC, created_at DESC`, values);
  res.json(rows.map((r) => scrubForRole(req.user, "orders", r)));
});

router.get("/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(scrubForRole(req.user, "orders", rows[0]));
});

// Manually-entered order (POS sale, or a parcel added by hand before
// courier API integration exists). WooCommerce orders arrive via the
// webhook handler instead — see routes/webhooks.js.
// billed_by defaults to whoever is logged in, so every manual/POS bill
// carries the name of the person who made it even if the UI omits it.
router.post("/", async (req, res) => {
  const cols = writableColumns(req);
  const body = { ...req.body };
  if (!body.billed_by) body.billed_by = req.user.name;
  const values = cols.map((c) => body[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `INSERT INTO orders (${cols.join(", ")}, source)
     VALUES (${placeholders}, 'manual') RETURNING *`,
    values
  );
  res.status(201).json(scrubForRole(req.user, "orders", rows[0]));
});

router.put("/:id", async (req, res) => {
  const cols = writableColumns(req);
  const { rows: beforeRows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const before = beforeRows[0];
  if (!before) return res.status(404).json({ error: "Not found" });

  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
  const values = cols.map((c) => req.body[c]);
  const { rows } = await pool.query(
    `UPDATE orders SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
    [...values, req.params.id]
  );

  await logChanges({
    resource: "orders",
    recordId: req.params.id,
    recordLabel: `${before.order_no} — ${before.customer}`,
    before,
    after: rows[0],
    user: req.user,
    columns: cols,
  });

  res.json(scrubForRole(req.user, "orders", rows[0]));
});

// ---------------------------------------------------------------
// POST /orders/:id/return   { reason, refundAmount, returnCharge, restock }
// One call does everything a return needs: marks the order Returned,
// records the courier's return charge and any refund given, optionally
// puts the stock back into inventory, and writes it all to the audit log
// so the owner can see who processed the return and when.
// ---------------------------------------------------------------
router.post("/:id/return", async (req, res) => {
  const { reason, refundAmount = 0, returnCharge, restock = true } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: "Return reason is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    const before = beforeRows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }
    if (before.status === "Returned") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "This order is already marked Returned" });
    }

    // Fall back to the configured default return charge if none was given.
    let charge = returnCharge;
    if (charge === undefined || charge === null || charge === "") {
      const { rows: s } = await client.query("SELECT value FROM settings WHERE key = 'default_return_charge'");
      charge = s[0] ? Number(s[0].value) : 0;
    }

    const { rows: afterRows } = await client.query(
      `UPDATE orders
         SET status = 'Returned',
             return_reason = $1,
             refund_amount = $2,
             return_charge = $3,
             restocked = $4,
             returned_at = CURRENT_DATE,
             updated_at = now()
       WHERE id = $5
       RETURNING *`,
      [String(reason).trim(), Number(refundAmount) || 0, Number(charge) || 0, !!restock, req.params.id]
    );
    const after = afterRows[0];

    // Put the units back on the shelf. Products are stored as a summary
    // string ("Lawn Suit x2, Dupatta x1") by both POS and the WooCommerce
    // sync, so we parse that and match on inventory name.
    const restocked = [];
    if (restock && before.product) {
      for (const seg of String(before.product).split(",")) {
        const m = seg.trim().match(/^(.*)\s+x(\d+(?:\.\d+)?)$/i);
        const name = m ? m[1].trim() : seg.trim();
        const qty = m ? Number(m[2]) : Number(before.qty) || 1;
        if (!name) continue;
        const { rows: upd } = await client.query(
          `UPDATE inventory SET quantity = quantity + $1, updated_at = now()
            WHERE lower(name) = lower($2) RETURNING name, quantity`,
          [qty, name]
        );
        if (upd[0]) restocked.push({ name: upd[0].name, added: qty, newQty: Number(upd[0].quantity) });
      }
    }

    await client.query("COMMIT");

    await logChanges({
      resource: "orders",
      recordId: req.params.id,
      recordLabel: `${before.order_no} — ${before.customer}`,
      before,
      after,
      user: req.user,
      columns: ["status", "return_reason", "refund_amount", "return_charge", "restocked"],
    });

    res.json({ order: scrubForRole(req.user, "orders", after), restocked });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Return failed:", err);
    res.status(500).json({ error: "Return failed", detail: err.message });
  } finally {
    client.release();
  }
});

router.delete("/:id", requireDeletePermission, async (req, res) => {
  await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

module.exports = router;
