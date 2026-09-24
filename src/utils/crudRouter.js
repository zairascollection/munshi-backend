const { logChanges, logCreate, logDelete } = require("./auditLog");
const { handleDbError } = require("./dbErrors");

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
function buildCrudRouter({ table, resource, columns, ownerOnly = false, ownerOnlyFields = [], auditLog = false, labelField = "name", afterWrite = null, transformRow = null }) {
  const router = express.Router();
  router.use(requireAuth);
  if (ownerOnly) router.use(requireResourceAccess(resource));

  const writableColumns = (req) =>
    isManagerOrAbove(req.user) ? columns : columns.filter((c) => !ownerOnlyFields.includes(c));

  // Every response for this resource goes through the same shaping, so a
  // row from a create or an update looks exactly like a row from the list.
  // They used not to: the list stripped the photo and sent a cacheable
  // image_url, while POST/PUT returned the raw base64. The client merges
  // the response into its state, so one edit could silently swap a light
  // row for a megabyte of base64 with no image_url on it at all.
  const shape = (req, row) => {
    const scrubbed = scrubForRole(req.user, resource, row);
    return transformRow ? transformRow(scrubbed) : scrubbed;
  };

  router.get("/", async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY created_at DESC`);
    res.json(rows.map((r) => shape(req, r)));
  });

  router.get("/:id", async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(shape(req, rows[0]));
  });

  router.post("/", async (req, res) => {
    // Only the columns actually present in the request are written. An older
    // client that doesn't know about a newly added column then gets the
    // column's DEFAULT instead of a NULL that breaks a NOT NULL constraint.
    const cols = writableColumns(req).filter((c) => Object.prototype.hasOwnProperty.call(req.body, c));
    if (cols.length === 0) return res.status(400).json({ error: "Nothing to insert" });
    const values = cols.map((c) => req.body[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`,
        values
      ));
    } catch (err) {
      // A duplicate SKU used to come back as "Internal server error", so the
      // row sat on screen looking saved and vanished on the next refresh.
      return handleDbError(err, res, "Add nahi hua");
    }

    if (auditLog) {
      await logCreate({
        resource, recordId: rows[0].id,
        recordLabel: rows[0][labelField] || rows[0].name || "",
        row: rows[0], user: req.user,
      });
    }
    if (afterWrite) afterWrite(rows[0], null);
    res.status(201).json(shape(req, rows[0]));
  });

  router.put("/:id", async (req, res) => {
    // Only the columns the client actually sent get written. Without this
    // filter every untouched column is written as undefined — which reaches
    // Postgres as NULL — so editing a price would blank the item's name,
    // photo and stock, and any NOT NULL column would make the whole save
    // fail. The client sends a patch, so this is not optional.
    const { rows: beforeRows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    const before = beforeRows[0] || null;
    if (!before) return res.status(404).json({ error: "Not found" });

    const cols = writableColumns(req).filter((c) => Object.prototype.hasOwnProperty.call(req.body, c));
    // Nothing writable in the body — answer with the record unchanged
    // rather than running an UPDATE with an empty SET clause.
    if (cols.length === 0) return res.json(shape(req, before));

    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const values = cols.map((c) => req.body[c]);
    let rows;
    try {
      ({ rows } = await pool.query(
        `UPDATE ${table} SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
        [...values, req.params.id]
      ));
    } catch (err) {
      return handleDbError(err, res, "Update nahi hua");
    }
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    if (auditLog && before) {
      await logChanges({ resource, recordId: req.params.id, recordLabel: before[labelField] || before.name || "", before, after: rows[0], user: req.user, columns: cols });
    }
    if (afterWrite) afterWrite(rows[0], before);
    res.json(shape(req, rows[0]));
  });

  router.delete("/:id", requireDeletePermission, async (req, res) => {
    // Read it first: once the row is gone there is nothing left to record,
    // and "who deleted this and what was in it" is exactly what the owner
    // needs when something goes missing.
    const { rows: before } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    if (!before[0]) return res.status(204).end();

    try {
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    } catch (err) {
      return handleDbError(err, res, "Delete nahi hua");
    }

    await logDelete({
      resource, recordId: req.params.id,
      recordLabel: before[0][labelField] || before[0].name || "",
      row: before[0], user: req.user,
    });
    res.status(204).end();
  });

  return router;
}

module.exports = buildCrudRouter;
