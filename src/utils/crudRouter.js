const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess, requireDeletePermission } = require("../middleware/auth");
const { scrubForRole } = require("./permissions");

// Builds a basic REST router for a table: GET list, GET one, POST, PUT, DELETE.
// `columns` is the ordered list of DB column names accepted on create/update
// (excluding id/created_at/updated_at, which are handled automatically).
function buildCrudRouter({ table, resource, columns, ownerOnly = false }) {
  const router = express.Router();
  router.use(requireAuth);
  if (ownerOnly) router.use(requireResourceAccess(resource));

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
    const values = columns.map((c) => req.body[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await pool.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    res.status(201).json(scrubForRole(req.user, resource, rows[0]));
  });

  router.put("/:id", async (req, res) => {
    const sets = columns.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const values = columns.map((c) => req.body[c]);
    const { rows } = await pool.query(
      `UPDATE ${table} SET ${sets}, updated_at = now() WHERE id = $${columns.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(scrubForRole(req.user, resource, rows[0]));
  });

  router.delete("/:id", requireDeletePermission, async (req, res) => {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  });

  return router;
}

module.exports = buildCrudRouter;
