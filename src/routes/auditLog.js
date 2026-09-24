const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------
// Change history.
//
// Covers three kinds of entry: a field edit (old -> new), an "Added" line
// when a record is created, and a "Deleted" line carrying a summary of
// what the record held. The last one matters most — it is the only record
// that a thing ever existed.
//
// Inventory entries carry the product photo so the owner can recognise the
// item at a glance rather than decoding a SKU.
// ---------------------------------------------------------------
router.get("/", requireAuth, requireResourceAccess("audit_log"), async (req, res) => {
  const { resource, changedBy, action, limit } = req.query;
  const clauses = [];
  const values = [];

  if (resource) { values.push(resource); clauses.push(`a.resource = $${values.length}`); }
  if (changedBy) { values.push(`%${changedBy}%`); clauses.push(`a.changed_by ILIKE $${values.length}`); }
  // "Added" / "Deleted" live in the field column; anything else is an edit.
  if (action === "added") clauses.push(`a.field = 'Added'`);
  if (action === "deleted") clauses.push(`a.field = 'Deleted'`);
  if (action === "edited") clauses.push(`a.field NOT IN ('Added', 'Deleted')`);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(Math.min(Number(limit) || 200, 1000));

  const { rows } = await pool.query(
    `SELECT a.*,
            CASE WHEN a.resource = 'inventory' AND inv.image IS NOT NULL
                 THEN '/inventory/' || inv.id::text || '/image?v=' || EXTRACT(EPOCH FROM inv.updated_at)::bigint::text
                 ELSE NULL END AS image_url
       FROM audit_log a
       LEFT JOIN inventory inv
              ON a.resource = 'inventory' AND inv.id = a.record_id
       ${where}
      ORDER BY a.changed_at DESC
      LIMIT $${values.length}`,
    values
  );
  res.json(rows);
});

// The distinct people who have made changes, for the filter dropdown.
router.get("/people", requireAuth, requireResourceAccess("audit_log"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT DISTINCT changed_by FROM audit_log ORDER BY changed_by"
  );
  res.json(rows.map((r) => r.changed_by).filter(Boolean));
});

module.exports = router;
