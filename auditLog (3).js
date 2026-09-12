const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess } = require("../middleware/auth");

const router = express.Router();

// Owner-only: history of field-level edits (currently tracked for inventory).
router.get("/", requireAuth, requireResourceAccess("audit_log"), async (req, res) => {
  const { resource, limit } = req.query;
  const clauses = [];
  const values = [];
  if (resource) { values.push(resource); clauses.push(`resource = $${values.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await pool.query(
    `SELECT * FROM audit_log ${where} ORDER BY changed_at DESC LIMIT $${values.length}`,
    values
  );
  res.json(rows);
});

module.exports = router;
