// Maal wholesaler ko wapis.
//
// This is neither a sale nor a purchase: stock leaves the shop and money
// comes back from the supplier (or sits as credit with them). Without a
// place to record it, returned stock either stays on the books as stock
// the shop no longer has, or gets deleted — and then nobody can prove
// what went back or what the supplier still owes.
//
// Stock comes off the shelf the moment the return is saved, because that
// is when the goods physically leave.
const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireDeletePermission } = require("../middleware/auth");
const { logChanges, logCreate, logDelete } = require("../utils/auditLog");
const { handleDbError } = require("../utils/dbErrors");

let pushStockSafe = () => {};
try { ({ pushStockSafe } = require("../services/woocommerce")); }
catch { console.error("[startup] services/woocommerce missing — website stock push disabled"); }

const router = express.Router();
router.use(requireAuth);

const n = (v) => Number(v) || 0;

// GET /supplier-returns — list, with each item's photo for recognition.
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*,
            COALESCE(s.name, r.supplier_name)  AS supplier,
            COALESCE(i.items, 0)::int          AS item_count,
            COALESCE(i.total_qty, 0)           AS total_qty,
            COALESCE(p.images, '{}')           AS item_images
       FROM supplier_returns r
       LEFT JOIN suppliers s ON s.id = r.supplier_id
       LEFT JOIN (
         SELECT return_id, COUNT(*) AS items, SUM(qty) AS total_qty
           FROM supplier_return_items GROUP BY return_id
       ) i ON i.return_id = r.id
       LEFT JOIN (
         SELECT sri.return_id,
                ARRAY_AGG('/inventory/' || inv.id::text || '/image?v=' ||
                          EXTRACT(EPOCH FROM inv.updated_at)::bigint::text
                          ORDER BY sri.name) AS images
           FROM supplier_return_items sri
           JOIN inventory inv ON inv.id = sri.inventory_id AND inv.image IS NOT NULL
          GROUP BY sri.return_id
       ) p ON p.return_id = r.id
      ORDER BY r.date DESC, r.created_at DESC`
  );
  res.json(rows.map((r) => ({
    ...r,
    total: n(r.total),
    refund_amount: n(r.refund_amount),
    total_qty: n(r.total_qty),
    item_images: (r.item_images || []).slice(0, 3),
  })));
});

// GET /supplier-returns/:id — one return with its lines.
router.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, COALESCE(s.name, r.supplier_name) AS supplier
       FROM supplier_returns r
       LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE r.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });

  const { rows: items } = await pool.query(
    `SELECT sri.*,
            CASE WHEN inv.image IS NOT NULL
                 THEN '/inventory/' || inv.id::text || '/image?v=' || EXTRACT(EPOCH FROM inv.updated_at)::bigint::text
                 ELSE NULL END AS image_url
       FROM supplier_return_items sri
       LEFT JOIN inventory inv ON inv.id = sri.inventory_id
      WHERE sri.return_id = $1 ORDER BY sri.name`,
    [req.params.id]
  );
  res.json({ ...rows[0], total: n(rows[0].total), refund_amount: n(rows[0].refund_amount), items });
});

// POST /supplier-returns  { supplierId|supplierName, date, reason, notes,
//                           refundAmount, items: [{ inventoryId, name, sku, qty, unitCost }] }
router.post("/", async (req, res) => {
  const { refNo, supplierId, supplierName, date, reason, notes, refundAmount, items = [] } = req.body || {};
  const clean = items.filter((it) => String(it.name || "").trim() && n(it.qty) > 0);
  if (clean.length === 0) return res.status(400).json({ error: "Kam az kam ek item chunein" });
  if (!supplierId && !String(supplierName || "").trim()) {
    return res.status(400).json({ error: "Supplier chunein ya naam likhein" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const total = clean.reduce((t, it) => t + n(it.qty) * n(it.unitCost), 0);
    const { rows: created } = await client.query(
      `INSERT INTO supplier_returns (ref_no, supplier_id, supplier_name, date, reason, notes, total, refund_amount, created_by)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8, $9) RETURNING *`,
      [
        refNo || `SR-${Math.floor(1000 + Math.random() * 9000)}`,
        supplierId || null, supplierName || null, date || null,
        reason || null, notes || null, total, n(refundAmount), req.user.name,
      ]
    );
    const ret = created[0];

    const touched = [];
    for (const it of clean) {
      await client.query(
        `INSERT INTO supplier_return_items (return_id, inventory_id, name, sku, qty, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ret.id, it.inventoryId || null, it.name, it.sku || null, n(it.qty), n(it.unitCost)]
      );

      // The goods have physically gone back, so the shelf count drops now.
      if (it.inventoryId) {
        const { rows: before } = await client.query("SELECT * FROM inventory WHERE id = $1", [it.inventoryId]);
        if (before[0]) {
          const { rows: after } = await client.query(
            "UPDATE inventory SET quantity = GREATEST(0, quantity - $1), updated_at = now() WHERE id = $2 RETURNING *",
            [n(it.qty), it.inventoryId]
          );
          touched.push(after[0]);
          await logChanges({
            resource: "inventory", recordId: it.inventoryId, recordLabel: before[0].name,
            before: before[0], after: after[0], user: req.user, columns: ["quantity"],
          });
        }
      }
    }

    await client.query("COMMIT");
    touched.forEach(pushStockSafe);
    await logCreate({
      resource: "supplier_returns", recordId: ret.id,
      recordLabel: ret.ref_no || "", row: { ...ret, quantity: clean.reduce((t, i) => t + n(i.qty), 0) },
      user: req.user,
    });
    res.status(201).json({ ...ret, total: n(ret.total), refund_amount: n(ret.refund_amount) });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleDbError(err, res, "Return save nahi hua");
  } finally {
    client.release();
  }
});

// PUT /supplier-returns/:id — status, refund received, notes.
router.put("/:id", async (req, res) => {
  const { status, refundAmount, notes, reason } = req.body || {};
  const { rows: beforeRows } = await pool.query("SELECT * FROM supplier_returns WHERE id = $1", [req.params.id]);
  const before = beforeRows[0];
  if (!before) return res.status(404).json({ error: "Not found" });

  let rows;
  try {
    ({ rows } = await pool.query(
      `UPDATE supplier_returns
          SET status = COALESCE($1, status),
              refund_amount = COALESCE($2, refund_amount),
              notes = COALESCE($3, notes),
              reason = COALESCE($4, reason),
              updated_at = now()
        WHERE id = $5 RETURNING *`,
      [status || null, refundAmount === undefined ? null : n(refundAmount), notes ?? null, reason ?? null, req.params.id]
    ));
  } catch (err) {
    return handleDbError(err, res, "Update nahi hua");
  }

  await logChanges({
    resource: "supplier_returns", recordId: req.params.id,
    recordLabel: before.ref_no || "", before, after: rows[0], user: req.user,
    columns: ["status", "refund_amount", "notes", "reason"],
  });
  res.json({ ...rows[0], total: n(rows[0].total), refund_amount: n(rows[0].refund_amount) });
});

// DELETE /supplier-returns/:id — undoing a mistake puts the stock back.
router.delete("/:id", requireDeletePermission, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: head } = await client.query("SELECT * FROM supplier_returns WHERE id = $1", [req.params.id]);
    if (!head[0]) { await client.query("ROLLBACK"); return res.status(204).end(); }

    const { rows: items } = await client.query("SELECT * FROM supplier_return_items WHERE return_id = $1", [req.params.id]);
    const touched = [];
    for (const it of items) {
      if (!it.inventory_id) continue;
      const { rows: back } = await client.query(
        "UPDATE inventory SET quantity = quantity + $1, updated_at = now() WHERE id = $2 RETURNING *",
        [n(it.qty), it.inventory_id]
      );
      if (back[0]) touched.push(back[0]);
    }
    await client.query("DELETE FROM supplier_returns WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    touched.forEach(pushStockSafe);

    await logDelete({
      resource: "supplier_returns", recordId: req.params.id,
      recordLabel: head[0].ref_no || "",
      row: { ...head[0], quantity: items.reduce((t, i) => t + n(i.qty), 0) },
      user: req.user,
    });
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    return handleDbError(err, res, "Delete nahi hua");
  } finally {
    client.release();
  }
});

module.exports = router;
