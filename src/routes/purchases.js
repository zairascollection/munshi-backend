const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess, requireDeletePermission } = require("../middleware/auth");
const { logChanges, logCreate, logDelete } = require("../utils/auditLog");

const router = express.Router();
router.use(requireAuth);
router.use(requireResourceAccess("purchases"));

// GET /purchases — every PO with its supplier name and item count
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT po.*, s.name AS supplier_name,
            COALESCE(i.item_count, 0)::int AS item_count
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN (SELECT po_id, COUNT(*) AS item_count FROM purchase_order_items GROUP BY po_id) i
              ON i.po_id = po.id
      ORDER BY po.date DESC, po.created_at DESC`
  );
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const { rows: items } = await pool.query(
    "SELECT * FROM purchase_order_items WHERE po_id = $1 ORDER BY name",
    [req.params.id]
  );
  res.json({ ...rows[0], items });
});

// POST /purchases  { po_no, supplier_id, date, notes, items: [...] }
router.post("/", async (req, res) => {
  const { po_no, supplier_id, date, notes, amount_paid = 0, items = [] } = req.body || {};
  if (!po_no) return res.status(400).json({ error: "PO number required" });

  const total = items.reduce((t, it) => t + (Number(it.qty) || 0) * (Number(it.unit_cost) || 0), 0);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO purchase_orders (po_no, supplier_id, date, notes, total, amount_paid, created_by)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7) RETURNING *`,
      [po_no, supplier_id || null, date || null, notes || null, total, Number(amount_paid) || 0, req.user.name]
    );
    const po = rows[0];
    for (const it of items) {
      await client.query(
        `INSERT INTO purchase_order_items (po_id, inventory_id, name, sku, qty, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [po.id, it.inventory_id || null, it.name, it.sku || null, Number(it.qty) || 0, Number(it.unit_cost) || 0]
      );
    }
    await client.query("COMMIT");
    await logCreate({
      resource: "purchases", recordId: po.id,
      recordLabel: po.po_no || "", row: po, user: req.user,
    });
    res.status(201).json(po);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create PO failed:", err);
    res.status(500).json({ error: "Could not create purchase order", detail: err.message });
  } finally {
    client.release();
  }
});

router.put("/:id", async (req, res) => {
  const { po_no, supplier_id, date, notes, status, amount_paid } = req.body || {};
  const { rows: beforeRows } = await pool.query("SELECT * FROM purchase_orders WHERE id = $1", [req.params.id]);
  if (!beforeRows[0]) return res.status(404).json({ error: "Not found" });
  if (beforeRows[0].status === "Received") {
    return res.status(400).json({ error: "Received PO edit nahi ho sakta — stock already add ho chuka hai" });
  }
  const { rows } = await pool.query(
    `UPDATE purchase_orders
        SET po_no = COALESCE($1, po_no), supplier_id = $2, date = COALESCE($3, date),
            notes = $4, status = COALESCE($5, status), amount_paid = COALESCE($6, amount_paid),
            updated_at = now()
      WHERE id = $7 RETURNING *`,
    [po_no, supplier_id || null, date || null, notes || null, status, amount_paid, req.params.id]
  );
  await logChanges({
    resource: "purchase_orders", recordId: req.params.id, recordLabel: beforeRows[0].po_no,
    before: beforeRows[0], after: rows[0], user: req.user,
    columns: ["po_no", "supplier_id", "date", "notes", "status", "amount_paid"],
  });
  res.json(rows[0]);
});

// ---------------------------------------------------------------
// POST /purchases/:id/receive
// This is the point of the whole module: receiving a PO raises stock
// and writes the real purchase cost onto the inventory row, so cost
// stops being a number typed from memory. Existing items get a
// weighted-average cost; unknown items are created.
// ---------------------------------------------------------------
router.post("/:id/receive", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: poRows } = await client.query("SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    const po = poRows[0];
    if (!po) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    if (po.status === "Received") { await client.query("ROLLBACK"); return res.status(400).json({ error: "Ye PO pehle hi receive ho chuka hai" }); }

    const { rows: items } = await client.query("SELECT * FROM purchase_order_items WHERE po_id = $1", [req.params.id]);
    const applied = [];

    for (const it of items) {
      const qty = Number(it.qty) || 0;
      const unitCost = Number(it.unit_cost) || 0;
      if (qty <= 0) continue;

      let inv = null;
      if (it.inventory_id) {
        const { rows } = await client.query("SELECT * FROM inventory WHERE id = $1", [it.inventory_id]);
        inv = rows[0];
      }
      if (!inv && it.sku) {
        const { rows } = await client.query("SELECT * FROM inventory WHERE lower(sku) = lower($1)", [it.sku]);
        inv = rows[0];
      }
      if (!inv) {
        const { rows } = await client.query("SELECT * FROM inventory WHERE lower(name) = lower($1)", [it.name]);
        inv = rows[0];
      }

      if (inv) {
        // Weighted average so old stock bought cheaper isn't silently
        // revalued at the new price (and vice versa).
        const oldQty = Number(inv.quantity) || 0;
        const oldCost = Number(inv.cost) || 0;
        const newQty = oldQty + qty;
        const avgCost = newQty > 0 ? (oldQty * oldCost + qty * unitCost) / newQty : unitCost;
        const { rows: upd } = await client.query(
          "UPDATE inventory SET quantity = $1, cost = $2, supplier_id = COALESCE($3, supplier_id), updated_at = now() WHERE id = $4 RETURNING *",
          [newQty, Math.round(avgCost * 100) / 100, po.supplier_id || null, inv.id]
        );
        applied.push({ name: inv.name, added: qty, newQty, newCost: Number(upd[0].cost) });
        await logChanges({
          resource: "inventory", recordId: inv.id, recordLabel: inv.name,
          before: inv, after: upd[0], user: req.user, columns: ["quantity", "cost"],
        });
      } else {
        const { rows: created } = await client.query(
          `INSERT INTO inventory (name, sku, quantity, cost, price, supplier_id)
           VALUES ($1, $2, $3, $4, $4, $5) RETURNING *`,
          [it.name, it.sku || null, qty, unitCost, po.supplier_id || null]
        );
        applied.push({ name: it.name, added: qty, newQty: qty, newCost: unitCost, created: true });
        await client.query("UPDATE purchase_order_items SET inventory_id = $1 WHERE id = $2", [created[0].id, it.id]);
      }
    }

    const { rows: updated } = await client.query(
      "UPDATE purchase_orders SET status = 'Received', received_at = CURRENT_DATE, updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    await client.query("COMMIT");
    res.json({ po: updated[0], applied });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Receive PO failed:", err);
    res.status(500).json({ error: "Receive failed", detail: err.message });
  } finally {
    client.release();
  }
});

router.delete("/:id", requireDeletePermission, async (req, res) => {
  // Managers can delete purchase orders now, so what was deleted — and by
  // whom — has to survive the delete.
  const { rows: before } = await pool.query("SELECT * FROM purchase_orders WHERE id = $1", [req.params.id]);
  if (!before[0]) return res.status(204).end();
  await pool.query("DELETE FROM purchase_orders WHERE id = $1", [req.params.id]);
  await logDelete({
    resource: "purchases", recordId: req.params.id,
    recordLabel: before[0].po_no || "",
    row: before[0], user: req.user,
  });
  res.status(204).end();
});

module.exports = router;
