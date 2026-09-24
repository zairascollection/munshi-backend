const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireDeletePermission } = require("../middleware/auth");
const { logChanges, logCreate, logDelete } = require("../utils/auditLog");
const { pushStockSafe } = require("../services/woocommerce");

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------
// Consignment stock — goods handed to an affiliate to sell for us.
//
// The stock leaves the shop but is still ours, so:
//   giving out  -> inventory goes DOWN, a consignment records who has it
//   coming back -> inventory goes UP again
//   sold        -> nothing returns to inventory; it's just no longer owed
//
// What's still with the holder is always qty_out - qty_returned - qty_sold,
// so the numbers can't drift no matter how many part-returns happen.
// ---------------------------------------------------------------

const withRemaining = (item) => {
  const out = Number(item.qty_out) || 0;
  const returned = Number(item.qty_returned) || 0;
  const sold = Number(item.qty_sold) || 0;
  return { ...item, qty_out: out, qty_returned: returned, qty_sold: sold, remaining: out - returned - sold };
};

// Recomputes the header status from the items, inside an open transaction.
async function refreshStatus(client, consignmentId) {
  const { rows } = await client.query(
    "SELECT qty_out, qty_returned, qty_sold FROM consignment_items WHERE consignment_id = $1",
    [consignmentId]
  );
  const totalOut = rows.reduce((t, r) => t + Number(r.qty_out || 0), 0);
  const settled = rows.reduce((t, r) => t + Number(r.qty_returned || 0) + Number(r.qty_sold || 0), 0);
  const status = settled <= 0 ? "Out" : settled >= totalOut ? "Settled" : "Partial";
  await client.query("UPDATE consignments SET status = $1, updated_at = now() WHERE id = $2", [status, consignmentId]);
  return status;
}

// GET /consignments/sellers — names only, for the "sold by" dropdown and
// the consignment holder picker. Any logged-in user can read this: staff
// need the names to record who made a sale, but commission and sales
// figures stay behind the manager-only /affiliates route.
router.get("/sellers", async (req, res) => {
  const { rows: affiliates } = await pool.query(
    "SELECT id, name FROM affiliates WHERE status = 'Active' ORDER BY name"
  );
  const { rows: staff } = await pool.query(
    "SELECT name FROM employees ORDER BY name"
  );
  const { rows: users } = await pool.query("SELECT name FROM users ORDER BY name");
  res.json({
    affiliates,
    staff: [...new Set([...staff.map((s) => s.name), ...users.map((u) => u.name)])].filter(Boolean),
  });
});

// GET /consignments — every consignment with its holder and totals
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE(a.name, c.holder_name) AS holder,
            COALESCE(i.items, 0)::int       AS item_count,
            COALESCE(i.total_out, 0)        AS total_out,
            COALESCE(i.total_returned, 0)   AS total_returned,
            COALESCE(i.total_sold, 0)       AS total_sold,
            COALESCE(i.value_out, 0)        AS value_out
       FROM consignments c
       LEFT JOIN affiliates a ON a.id = c.affiliate_id
       LEFT JOIN (
         SELECT consignment_id,
                COUNT(*) AS items,
                SUM(qty_out) AS total_out,
                SUM(qty_returned) AS total_returned,
                SUM(qty_sold) AS total_sold,
                SUM((qty_out - qty_returned - qty_sold) * unit_price) AS value_out
           FROM consignment_items GROUP BY consignment_id
       ) i ON i.consignment_id = c.id
      ORDER BY c.date DESC, c.created_at DESC`
  );
  res.json(rows.map((r) => ({
    ...r,
    total_out: Number(r.total_out),
    total_returned: Number(r.total_returned),
    total_sold: Number(r.total_sold),
    value_out: Number(r.value_out),
    remaining: Number(r.total_out) - Number(r.total_returned) - Number(r.total_sold),
  })));
});

// GET /consignments/:id — one consignment with its item lines
router.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(a.name, c.holder_name) AS holder
       FROM consignments c LEFT JOIN affiliates a ON a.id = c.affiliate_id
      WHERE c.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const { rows: items } = await pool.query(
    `SELECT ci.*,
            CASE WHEN inv.image IS NOT NULL
                 THEN '/inventory/' || inv.id::text || '/image?v=' || EXTRACT(EPOCH FROM inv.updated_at)::bigint::text
                 ELSE NULL END AS image_url
       FROM consignment_items ci
       LEFT JOIN inventory inv ON inv.id = ci.inventory_id
      WHERE ci.consignment_id = $1
      ORDER BY ci.name`,
    [req.params.id]
  );
  res.json({ ...rows[0], items: items.map(withRemaining) });
});

// POST /consignments  { refNo, affiliateId, holderName, phone, date, notes, items: [...] }
// Deducts every line from inventory in one transaction — a consignment can
// never exist for stock the shop doesn't actually have.
router.post("/", async (req, res) => {
  const { refNo, affiliateId, holderName, phone, date, notes, items = [] } = req.body || {};
  const clean = items.filter((it) => String(it.name || "").trim() && Number(it.qty) > 0);
  if (clean.length === 0) return res.status(400).json({ error: "Kam az kam ek item add karein" });
  if (!affiliateId && !String(holderName || "").trim()) {
    return res.status(400).json({ error: "Affiliate chunein ya holder ka naam likhein" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: created } = await client.query(
      `INSERT INTO consignments (ref_no, affiliate_id, holder_name, phone, date, notes, given_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7) RETURNING *`,
      [
        refNo || `CN-${Math.floor(1000 + Math.random() * 9000)}`,
        affiliateId || null,
        holderName || null,
        phone || null,
        date || null,
        notes || null,
        req.user.name,
      ]
    );
    const consignment = created[0];
    const touched = [];

    for (const it of clean) {
      const qty = Number(it.qty);
      let inv = null;

      if (it.inventoryId) {
        const { rows } = await client.query("SELECT * FROM inventory WHERE id = $1 FOR UPDATE", [it.inventoryId]);
        inv = rows[0];
      }
      if (!inv && it.sku) {
        const { rows } = await client.query("SELECT * FROM inventory WHERE lower(sku) = lower($1) FOR UPDATE", [it.sku]);
        inv = rows[0];
      }

      // Refusing to go negative is the point: if the shop doesn't have it,
      // the affiliate can't be holding it either.
      if (inv && Number(inv.quantity) < qty) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `${inv.name} ka stock sirf ${Number(inv.quantity)} hai, ${qty} nahi de sakte` });
      }

      await client.query(
        `INSERT INTO consignment_items (consignment_id, inventory_id, name, sku, qty_out, unit_cost, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          consignment.id,
          inv ? inv.id : null,
          it.name,
          it.sku || (inv ? inv.sku : null),
          qty,
          Number(it.unitCost) || (inv ? Number(inv.cost) : 0) || 0,
          Number(it.unitPrice) || (inv ? Number(inv.price) : 0) || 0,
        ]
      );

      if (inv) {
        const { rows: upd } = await client.query(
          "UPDATE inventory SET quantity = quantity - $1, updated_at = now() WHERE id = $2 RETURNING *",
          [qty, inv.id]
        );
        touched.push(upd[0]);
        await logChanges({
          resource: "inventory",
          recordId: inv.id,
          recordLabel: inv.name,
          before: inv,
          after: upd[0],
          user: req.user,
          columns: ["quantity"],
        });
      }
    }

    await client.query("COMMIT");
    touched.forEach(pushStockSafe);
    await logCreate({
      resource: "consignments", recordId: consignment.id,
      recordLabel: consignment.ref_no || consignment.holder_name || "",
      row: consignment, user: req.user,
    });
    res.status(201).json(consignment);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create consignment failed:", err);
    res.status(500).json({ error: "Consignment save nahi hua", detail: err.message });
  } finally {
    client.release();
  }
});

// POST /consignments/:id/settle
// { lines: [{ itemId, returned, sold }] }
// One call handles both outcomes: what came back goes to inventory, what
// sold just stops being owed. Amounts are increments, not totals.
router.post("/:id/settle", async (req, res) => {
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (lines.length === 0) return res.status(400).json({ error: "Kuch bhi record karne ko nahi" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: headRows } = await client.query("SELECT * FROM consignments WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!headRows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }

    const applied = [];
    const touched = [];

    for (const line of lines) {
      const returned = Number(line.returned) || 0;
      const sold = Number(line.sold) || 0;
      if (returned <= 0 && sold <= 0) continue;

      const { rows: itemRows } = await client.query(
        "SELECT * FROM consignment_items WHERE id = $1 AND consignment_id = $2 FOR UPDATE",
        [line.itemId, req.params.id]
      );
      const item = itemRows[0];
      if (!item) continue;

      const remaining = Number(item.qty_out) - Number(item.qty_returned) - Number(item.qty_sold);
      if (returned + sold > remaining + 0.001) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `${item.name}: sirf ${remaining} baqi hain` });
      }

      await client.query(
        "UPDATE consignment_items SET qty_returned = qty_returned + $1, qty_sold = qty_sold + $2 WHERE id = $3",
        [returned, sold, item.id]
      );

      // Only the returned units go back on the shelf. Sold units left for
      // good — they were deducted when the consignment was created.
      if (returned > 0 && item.inventory_id) {
        const { rows: before } = await client.query("SELECT * FROM inventory WHERE id = $1", [item.inventory_id]);
        const { rows: upd } = await client.query(
          "UPDATE inventory SET quantity = quantity + $1, updated_at = now() WHERE id = $2 RETURNING *",
          [returned, item.inventory_id]
        );
        if (upd[0]) {
          touched.push(upd[0]);
          await logChanges({
            resource: "inventory",
            recordId: item.inventory_id,
            recordLabel: item.name,
            before: before[0],
            after: upd[0],
            user: req.user,
            columns: ["quantity"],
          });
        }
      }

      applied.push({ name: item.name, returned, sold });
    }

    const status = await refreshStatus(client, req.params.id);
    await client.query("COMMIT");
    touched.forEach(pushStockSafe);
    res.json({ ok: true, status, applied });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Settle consignment failed:", err);
    res.status(500).json({ error: "Settle nahi hua", detail: err.message });
  } finally {
    client.release();
  }
});

// PUT /consignments/:id — notes, holder, phone, ref. Item lines are
// changed through settle, never edited by hand.
router.put("/:id", async (req, res) => {
  const { refNo, holderName, phone, notes, date } = req.body || {};
  // Read it first — without the old values there is nothing to compare
  // against, and the history line would say "changed" without saying from what.
  const { rows: beforeRows } = await pool.query("SELECT * FROM consignments WHERE id = $1", [req.params.id]);
  const before = beforeRows[0] || null;
  if (!before) return res.status(404).json({ error: "Not found" });
  const { rows } = await pool.query(
    `UPDATE consignments
        SET ref_no = COALESCE($1, ref_no), holder_name = COALESCE($2, holder_name),
            phone = COALESCE($3, phone), notes = $4, date = COALESCE($5, date),
            updated_at = now()
      WHERE id = $6 RETURNING *`,
    [refNo, holderName, phone, notes || null, date || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  // Managers can edit these now, so the edit has to be traceable.
  await logChanges({
    resource: "consignments", recordId: req.params.id,
    recordLabel: rows[0].ref_no || rows[0].holder_name || "",
    before, after: rows[0], user: req.user,
    columns: ["ref_no", "holder_name", "phone", "notes", "date"],
  });
  res.json(rows[0]);
});

// DELETE /consignments/:id. Puts every unsettled unit back
// into inventory so deleting a mistake doesn't lose stock.
router.delete("/:id", requireDeletePermission, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: items } = await client.query(
      "SELECT * FROM consignment_items WHERE consignment_id = $1",
      [req.params.id]
    );
    const touched = [];
    for (const item of items) {
      const remaining = Number(item.qty_out) - Number(item.qty_returned) - Number(item.qty_sold);
      if (remaining > 0 && item.inventory_id) {
        const { rows: upd } = await client.query(
          "UPDATE inventory SET quantity = quantity + $1, updated_at = now() WHERE id = $2 RETURNING *",
          [remaining, item.inventory_id]
        );
        if (upd[0]) touched.push(upd[0]);
      }
    }
    // Read the record before it is gone — after the DELETE there is
    // nothing left to describe, and "who removed this and what was on it"
    // is exactly what the owner needs when stock goes missing.
    const { rows: head } = await client.query("SELECT * FROM consignments WHERE id = $1", [req.params.id]);
    await client.query("DELETE FROM consignments WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    touched.forEach(pushStockSafe);
    if (head[0]) {
      await logDelete({
        resource: "consignments", recordId: req.params.id,
        recordLabel: head[0].ref_no || head[0].holder_name || "",
        row: { ...head[0], quantity: items.reduce((t, i) => t + Number(i.qty_out || 0), 0) },
        user: req.user,
      });
    }
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete consignment failed:", err);
    res.status(500).json({ error: "Delete failed", detail: err.message });
  } finally {
    client.release();
  }
});

// GET /consignments/holder/:name/summary — everything one person is
// holding right now, across all their consignments.
router.get("/holder/:name/summary", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ci.name, ci.sku,
            SUM(ci.qty_out - ci.qty_returned - ci.qty_sold) AS remaining,
            SUM(ci.qty_sold) AS sold
       FROM consignment_items ci
       JOIN consignments c ON c.id = ci.consignment_id
       LEFT JOIN affiliates a ON a.id = c.affiliate_id
      WHERE lower(COALESCE(a.name, c.holder_name)) = lower($1)
      GROUP BY ci.name, ci.sku
     HAVING SUM(ci.qty_out - ci.qty_returned - ci.qty_sold) > 0
      ORDER BY ci.name`,
    [req.params.name]
  );
  res.json(rows.map((r) => ({ ...r, remaining: Number(r.remaining), sold: Number(r.sold) })));
});

module.exports = router;
