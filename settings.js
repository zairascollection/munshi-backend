const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess } = require("../middleware/auth");
const { isOwner } = require("../utils/permissions");
const { logChanges } = require("../utils/auditLog");

const router = express.Router();
router.use(requireAuth);

const NUMERIC_KEYS = [
  "default_delivery_charge",
  "default_return_charge",
  "cash_handling_pct",
  "tax_pct",
  "packaging_cost",
];

// Everyone logged in can READ settings — POS/Orders need the default
// delivery charge to pre-fill a new order. Only the owner can change them.
router.get("/", async (req, res) => {
  const { rows } = await pool.query("SELECT key, value FROM settings");
  const out = {};
  rows.forEach((r) => {
    out[r.key] = NUMERIC_KEYS.includes(r.key) ? Number(r.value || 0) : r.value;
  });
  res.json(out);
});

// PUT /settings  { default_delivery_charge: 250, ... }  — owner only,
// and every change lands in the audit log like any other edit.
router.put("/", requireResourceAccess("settings"), async (req, res) => {
  if (!isOwner(req.user)) {
    return res.status(403).json({ error: "Only the owner can change settings" });
  }
  const entries = Object.entries(req.body || {});
  if (entries.length === 0) return res.status(400).json({ error: "Nothing to update" });

  const { rows: currentRows } = await pool.query("SELECT key, value FROM settings");
  const before = Object.fromEntries(currentRows.map((r) => [r.key, r.value]));

  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, String(value)]
    );
  }

  const after = Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
  await logChanges({
    resource: "settings",
    recordId: "00000000-0000-0000-0000-000000000000",
    recordLabel: "App settings",
    before,
    after,
    user: req.user,
    columns: entries.map(([k]) => k),
  });

  const { rows } = await pool.query("SELECT key, value FROM settings");
  const out = {};
  rows.forEach((r) => {
    out[r.key] = NUMERIC_KEYS.includes(r.key) ? Number(r.value || 0) : r.value;
  });
  res.json(out);
});

module.exports = router;
