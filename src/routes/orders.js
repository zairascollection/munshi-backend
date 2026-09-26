const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireDeletePermission } = require("../middleware/auth");
const { scrubForRole, isManagerOrAbove } = require("../utils/permissions");
const { logChanges, logCreate, logDelete } = require("../utils/auditLog");
const { handleDbError } = require("../utils/dbErrors");

const { attachItems } = require("../utils/orderItems");

// Everything needed to identify a product and show it, without dragging
// a single base64 photo across the wire.
const STOCK_FOR_MATCHING =
  "SELECT id, name, price, cost, size, color, parent_name, updated_at, (image IS NOT NULL) AS has_image FROM inventory";

const router = express.Router();
router.use(requireAuth);

const MANUAL_COLUMNS = [
  "order_no", "customer", "phone", "product", "qty", "sell", "cost",
  "courier", "tracking", "status", "amount_paid", "due_date", "method", "date",
  "billed_by", "return_reason", "city", "channel",
  // Who the sale actually came through (staff member or affiliate), as
  // opposed to billed_by which is just whoever typed it in.
  "sold_by", "sold_by_type", "consignment_id",
  "delivery_charge", "return_charge", "refund_amount", "restocked",
  "returned_at", "delivered_at",
];

// `items` is writable ONLY when the bill is created, or through
// PUT /orders/:id/items which validates every id against stock. The
// generic PUT must never touch it: the client holds an enriched copy of
// this column (photo urls, match flags), and a routine save would write
// that decoration back over the real record and lose the products.
const CREATE_COLUMNS = [...MANUAL_COLUMNS, "items"];

// Only the fields a line item is allowed to carry into the database.
function cleanItems(value) {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((it) => it && it.id)
    .map((it) => ({
      id: String(it.id),
      name: String(it.name || ""),
      qty: Math.max(1, Number(it.qty) || 1),
      price: Number(it.price) || 0,
    }));
  return items.length > 0 ? items : null;
}

// Staff can't write cost. Managers and owners can (they can see it too).
const writableColumns = (req, list = MANUAL_COLUMNS) =>
  isManagerOrAbove(req.user) ? list : list.filter((c) => c !== "cost");

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

  // One extra query for the whole list, not one per order. `image IS NOT
  // NULL` is read as a boolean so a hundred base64 photos never travel
  // just to decide whether a thumbnail exists.
  const { rows: stock } = await pool.query(
    STOCK_FOR_MATCHING
  );
  res.json(attachItems(rows, stock).map((r) => scrubForRole(req.user, "orders", r)));
});

router.get("/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const { rows: stock } = await pool.query(
    STOCK_FOR_MATCHING
  );
  res.json(scrubForRole(req.user, "orders", attachItems(rows, stock)[0]));
});

// Manually-entered order (POS sale, or a parcel added by hand before
// courier API integration exists). WooCommerce orders arrive via the
// webhook handler instead — see routes/webhooks.js.
// billed_by defaults to whoever is logged in, so every manual/POS bill
// carries the name of the person who made it even if the UI omits it.
router.post("/", async (req, res) => {
  const body = { ...req.body };
  if (!body.billed_by) body.billed_by = req.user.name;
  // Strip the line items down to what belongs in the column. The client
  // reads this field back decorated with photo urls and match flags, and
  // none of that should ever be stored.
  if ("items" in body) {
    const items = cleanItems(body.items);
    if (items) body.items = JSON.stringify(items);
    else delete body.items;
  }
  // Only write what the client sent; anything else takes its DB default.
  const cols = writableColumns(req, CREATE_COLUMNS).filter((c) => Object.prototype.hasOwnProperty.call(body, c));
  if (cols.length === 0) return res.status(400).json({ error: "Nothing to insert" });
  const values = cols.map((c) => body[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO orders (${cols.join(", ")}, source)
       VALUES (${placeholders}, 'manual') RETURNING *`,
      values
    ));
  } catch (err) {
    return handleDbError(err, res, "Bill save nahi hua");
  }

  // Writing a bill is the most common action in the shop — it belongs in
  // the history as much as editing one does.
  await logCreate({
    resource: "orders", recordId: rows[0].id,
    recordLabel: `${rows[0].order_no} — ${rows[0].customer}`,
    row: rows[0], user: req.user,
  });

  // Same shape as the list: the client merges this straight into its
  // state, so the new bill must already carry its resolved line items.
  const { rows: stock } = await pool.query(
    STOCK_FOR_MATCHING
  );
  res.status(201).json(scrubForRole(req.user, "orders", attachItems(rows, stock)[0]));
});

router.put("/:id", async (req, res) => {
  const { rows: beforeRows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const before = beforeRows[0];
  if (!before) return res.status(404).json({ error: "Not found" });

  const cols = writableColumns(req).filter((c) => Object.prototype.hasOwnProperty.call(req.body, c));
  if (cols.length === 0) return res.json(scrubForRole(req.user, "orders", before));

  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
  const values = cols.map((c) => req.body[c]);
  let rows;
  try {
    ({ rows } = await pool.query(
      `UPDATE orders SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...values, req.params.id]
    ));
  } catch (err) {
    return handleDbError(err, res, "Bill update nahi hua");
  }

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
// PUT /orders/:id/items   { items: [{ id, qty, price }], updateTotals }
//
// Corrects which products a bill was for. Bills used to record only a
// name, and this shop gives many different dresses the same name ("3PC",
// "2pc"), so older bills cannot be traced to the dress that was actually
// sold. This lets the owner say which one it was — after that the bill
// carries real inventory ids and always shows the right picture.
//
// Money is left alone unless `updateTotals` is asked for: correcting a
// photo must never quietly change what a customer was charged.
// ---------------------------------------------------------------
router.put("/:id/items", async (req, res) => {
  const { items, updateTotals } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Kam az kam ek item chunein" });
  }

  const { rows: beforeRows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const before = beforeRows[0];
  if (!before) return res.status(404).json({ error: "Not found" });

  const ids = items.map((it) => String(it.id)).filter(Boolean);
  const { rows: stock } = await pool.query(
    `${STOCK_FOR_MATCHING} WHERE id = ANY($1::uuid[])`, [ids]
  );
  const byId = new Map(stock.map((r) => [String(r.id), r]));

  // Every line must point at a product that exists, or the bill would end
  // up storing an id that resolves to nothing — the same silent breakage
  // in a new disguise.
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return res.status(400).json({ error: "Koi item ab stock mein maujood nahi — dobara chunein." });
  }

  const clean = items.map((it) => {
    const row = byId.get(String(it.id));
    const qty = Math.max(1, Number(it.qty) || 1);
    const price = it.price === undefined || it.price === null || it.price === ""
      ? Number(row.price) || 0
      : Number(it.price) || 0;
    return { id: row.id, name: row.name, qty, price };
  });

  const product = clean.map((it) => `${it.name} x${it.qty}`).join(", ");
  const totalQty = clean.reduce((t, it) => t + it.qty, 0);

  const sets = ["items = $1", "product = $2", "qty = $3"];
  const values = [JSON.stringify(clean), product, totalQty];
  if (updateTotals) {
    values.push(clean.reduce((t, it) => t + it.price * it.qty, 0));
    sets.push(`sell = $${values.length}`);
    values.push(clean.reduce((t, it) => t + (Number(byId.get(String(it.id)).cost) || 0) * it.qty, 0));
    sets.push(`cost = $${values.length}`);
  }
  values.push(req.params.id);

  let updated;
  try {
    ({ rows: updated } = await pool.query(
      `UPDATE orders SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values
    ));
  } catch (err) {
    return handleDbError(err, res, "Bill update nahi hua");
  }

  await logChanges({
    resource: "orders",
    recordId: req.params.id,
    recordLabel: before.order_no || "",
    before, after: updated[0], user: req.user,
    // "items" is the one that matters: when a bill is corrected from one
    // "3PC" to a different "3PC", the summary text does not change at
    // all, so without this the correction would leave no trace.
    columns: updateTotals ? ["items", "product", "qty", "sell", "cost"] : ["items", "product", "qty"],
  });

  const { rows: allStock } = await pool.query(STOCK_FOR_MATCHING);
  res.json(scrubForRole(req.user, "orders", attachItems(updated, allStock)[0]));
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
  const { rows: before } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  if (!before[0]) return res.status(204).end();

  await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);

  // A deleted bill is money that left the books. It must be traceable.
  await logDelete({
    resource: "orders", recordId: req.params.id,
    recordLabel: `${before[0].order_no} — ${before[0].customer}`,
    row: before[0], user: req.user,
  });
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
