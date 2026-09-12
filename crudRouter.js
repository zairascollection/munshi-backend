const { logChanges } = require("./auditLog");

const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess, requireDeletePermission } = require("../middleware/auth");
const { scrubForRole, isManagerOrAbove } = require("./permissions");

// Builds a basic REST router for a table: GET list, GET one, POST, PUT, DELETE.
// `columns` is the ordered list of DB column names accepted on create/update
// (excluding id/created_at/updated_at, which are handled automatically).
// `ownerOnlyFields` are excluded from POST/PUT for staff entirely (not just
// set to blank) so a staff edit can never overwrite a salary-type field
// they can't even see. Managers and owners can write these fields.
// `auditLog: true` records who changed which field (old → new) whenever an
// existing record is edited, so the owner can review changes later even
// though everyone can now edit e.g. inventory cost directly.
function buildCrudRouter({ table, resource, columns, ownerOnly = false, ownerOnlyFields = [], auditLog = false }) {
  const router = express.Router();
  router.use(requireAuth);
  if (ownerOnly) router.use(requireResourceAccess(resource));

  const writableColumns = (req) =>
    isManagerOrAbove(req.user) ? columns : columns.filter((c) => !ownerOnlyFields.includes(c));

  router.get("/", async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY created_at DESC`);
    res.json(rows.map((r) => scrubForRole(req.user, resource, r)));
  });

  router.get("/:id", async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(scrubForRole(req.user, resource, rows[0]));
  });

  router.post("/", async (req, res) => {
    const cols = writableColumns(req);
    const values = cols.map((c) => req.body[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await pool.query(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    res.status(201).json(scrubForRole(req.user, resource, rows[0]));
  });

  router.put("/:id", async (req, res) => {
    const cols = writableColumns(req);
    let before = null;
    if (auditLog) {
      const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      before = rows[0] || null;
    }
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const values = cols.map((c) => req.body[c]);
    const { rows } = await pool.query(
      `UPDATE ${table} SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (auditLog && before) {
      await logChanges({ resource, recordId: req.params.id, recordLabel: before.name, before, after: rows[0], user: req.user, columns: cols });
    }
    res.json(scrubForRole(req.user, resource, rows[0]));
  });

  router.delete("/:id", requireDeletePermission, async (req, res) => {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  });

  return router;
}

module.exports = buildCrudRouter;
