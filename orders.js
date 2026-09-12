const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireDeletePermission } = require("../middleware/auth");
const { scrubForRole, isOwner } = require("../utils/permissions");

const router = express.Router();
router.use(requireAuth);

const MANUAL_COLUMNS = [
  "order_no", "customer", "phone", "product", "qty", "sell", "cost",
  "courier", "tracking", "status", "amount_paid", "due_date", "method", "date",
  "billed_by", "return_reason", "city",
];

const writableColumns = (req) => (isOwner(req.user) ? MANUAL_COLUMNS : MANUAL_COLUMNS.filter((c) => c !== "cost"));

router.get("/", async (req, res) => {
  const { status, source } = req.query;
  const clauses = [];
  const values = [];
  if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
  if (source) { values.push(source); clauses.push(`source = $${values.length}`); }
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
router.post("/", async (req, res) => {
  const cols = writableColumns(req);
  const values = cols.map((c) => req.body[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `INSERT INTO orders (${cols.join(", ")}, source)
     VALUES (${placeholders}, 'manual') RETURNING *`,
    values
  );
  res.status(201).json(scrubForRole(req.user, "orders", rows[0]));
});

router.put("/:id", async (req, res) => {
  const cols = writableColumns(req);
  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
  const values = cols.map((c) => req.body[c]);
  const { rows } = await pool.query(
    `UPDATE orders SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
    [...values, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(scrubForRole(req.user, "orders", rows[0]));
});

router.delete("/:id", requireDeletePermission, async (req, res) => {
  await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

module.exports = router;
