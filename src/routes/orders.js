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
  const body = { ...req.body };
  if (!body.billed_by) body.billed_by = req.user.name;
  // Only write what the client sent; anything else takes its DB default.
  const cols = writableColumns(req).filter((c) => Object.prototype.hasOwnProperty.call(body, c));
  if (cols.length === 0) return res.status(400).json({ error: "Nothing to insert" });
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
  const { rows: beforeRows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const before = beforeRows[0];
  if (!before) return res.status(404).json({ error: "Not found" });

  const cols = writableColumns(req).filter((c) => Object.prototype.hasOwnProperty.call(req.body, c));
  if (cols.length === 0) return res.json(scrubForRole(req.user, "orders", before));

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

// ---------------------------------------------------------------
// Payments against an order — the udhaar that gets cleared later.
//
// Recording a payment does three things in one transaction: saves the
// instalment, adds it to the order's running total, and puts the cash
// into the chosen account. Nothing here ever overwrites amount_paid
// directly, so the instalments and the total can't drift apart.
// ---------------------------------------------------------------

// GET /orders/:id/payments — the instalment history for one order
router.get("/:id/payments", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, a.name AS account_name
       FROM payments p LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.order_id = $1 ORDER BY p.date ASC, p.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
});

// POST /orders/:id/payment  { amount, method, accountId, date, note }
router.post("/:id/payment", async (req, res) => {
  const { amount, method, accountId, date, note } = req.body || {};
  const value = Number(amount);
  if (!value || value <= 0) return res.status(400).json({ error: "Amount 0 se zyada hona chahiye" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    const order = orderRows[0];
    if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Order not found" }); }

    const due = Number(order.sell || 0) - Number(order.amount_paid || 0);
    if (value > due + 0.01) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Baqaya sirf ${Math.round(due)} hai` });
    }

    const { rows: paymentRows } = await client.query(
      `INSERT INTO payments (order_id, amount, method, account_id, date, received_by, note)
       VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7) RETURNING *`,
      [req.params.id, value, method || order.method || "Cash", accountId || null, date || null, req.user.name, note || null]
    );

    const { rows: updated } = await client.query(
      "UPDATE orders SET amount_paid = COALESCE(amount_paid, 0) + $1, updated_at = now() WHERE id = $2 RETURNING *",
      [value, req.params.id]
    );

    if (accountId) {
      await client.query(
        "UPDATE accounts SET balance = COALESCE(balance, 0) + $1, updated_at = now() WHERE id = $2",
        [value, accountId]
      );
    }

    await client.query("COMMIT");

    await logChanges({
      resource: "orders",
      recordId: req.params.id,
      recordLabel: `${order.order_no} — ${order.customer}`,
      before: order,
      after: updated[0],
      user: req.user,
      columns: ["amount_paid"],
    });

    res.status(201).json({ payment: paymentRows[0], order: scrubForRole(req.user, "orders", updated[0]) });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Payment failed:", err);
    res.status(500).json({ error: "Payment save nahi hui", detail: err.message });
  } finally {
    client.release();
  }
});

// DELETE /orders/:orderId/payment/:paymentId — undo a wrongly entered
// instalment; reverses the order total and the account balance too.
router.delete("/:orderId/payment/:paymentId", requireDeletePermission, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 AND order_id = $2", [req.params.paymentId, req.params.orderId]);
    const payment = rows[0];
    if (!payment) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Payment not found" }); }

    await client.query("DELETE FROM payments WHERE id = $1", [payment.id]);
    await client.query(
      "UPDATE orders SET amount_paid = GREATEST(COALESCE(amount_paid,0) - $1, 0), updated_at = now() WHERE id = $2",
      [Number(payment.amount), req.params.orderId]
    );
    if (payment.account_id) {
      await client.query(
        "UPDATE accounts SET balance = COALESCE(balance,0) - $1, updated_at = now() WHERE id = $2",
        [Number(payment.amount), payment.account_id]
      );
    }
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Payment delete failed:", err);
    res.status(500).json({ error: "Delete failed", detail: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// POST /orders/:id/undo-return  { status }
// Returns get marked by mistake. This puts the order back the way it
// was: clears the return fields, takes the restocked units out of
// inventory again, and records the reversal in the change history.
// ---------------------------------------------------------------
router.post("/:id/undo-return", async (req, res) => {
  const nextStatus = ["Pending", "Shipped", "Delivered"].includes(req.body?.status) ? req.body.status : "Delivered";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: beforeRows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    const before = beforeRows[0];
    if (!before) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    if (before.status !== "Returned") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ye order returned hai hi nahi" });
    }

    // Only pull stock back out if the return actually put it in.
    const removed = [];
    if (before.restocked && before.product) {
      for (const seg of String(before.product).split(",")) {
        const m = seg.trim().match(/^(.*)\s+x(\d+(?:\.\d+)?)$/i);
        const name = m ? m[1].trim() : seg.trim();
        const qty = m ? Number(m[2]) : Number(before.qty) || 1;
        if (!name) continue;
        const { rows: upd } = await client.query(
          `UPDATE inventory SET quantity = GREATEST(quantity - $1, 0), updated_at = now()
            WHERE lower(name) = lower($2) RETURNING name, quantity`,
          [qty, name]
        );
        if (upd[0]) removed.push({ name: upd[0].name, removed: qty, newQty: Number(upd[0].quantity) });
      }
    }

    const { rows: afterRows } = await client.query(
      `UPDATE orders
          SET status = $1, return_reason = NULL, refund_amount = 0, return_charge = 0,
              restocked = false, returned_at = NULL, updated_at = now()
        WHERE id = $2 RETURNING *`,
      [nextStatus, req.params.id]
    );
    await client.query("COMMIT");

    await logChanges({
      resource: "orders",
      recordId: req.params.id,
      recordLabel: `${before.order_no} — ${before.customer}`,
      before,
      after: afterRows[0],
      user: req.user,
      columns: ["status", "return_reason", "refund_amount", "return_charge", "restocked"],
    });

    res.json({ order: scrubForRole(req.user, "orders", afterRows[0]), removed });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Undo return failed:", err);
    res.status(500).json({ error: "Undo failed", detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
