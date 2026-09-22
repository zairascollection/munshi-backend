const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess } = require("../middleware/auth");
const { isOwner } = require("../utils/permissions");

const router = express.Router();

// ---------------------------------------------------------------
// Backup & restore.
//
// Everything this business has lives in one Postgres database on one
// hosting account. This route makes that survivable: the owner can pull
// the whole thing down as a single JSON file, keep it wherever they like,
// and put it back if the database is ever lost.
//
// Deliberately plain JSON rather than a pg_dump: it can be opened and
// read by a human, restored by this same app on any host, and doesn't
// depend on the Postgres version matching.
// ---------------------------------------------------------------

// Order matters on restore — a table's parents must exist before its
// rows can reference them.
const TABLES = [
  "users",
  "accounts",
  "suppliers",
  "inventory",
  "affiliates",
  "employees",
  "customers",
  "orders",
  "payments",
  "expenses",
  "ad_spend",
  "purchase_orders",
  "purchase_order_items",
  "consignments",
  "consignment_items",
  "settings",
  "audit_log",
  "monthly_reports",
  "whatsapp_log",
];

// Password hashes are the one thing a backup should not carry around: the
// file gets emailed, copied to a laptop, put on a pen drive. Logins are
// restored as accounts without passwords, and the owner resets them.
const STRIP_COLUMNS = { users: ["password_hash"] };

async function tableExists(name) {
  const { rows } = await pool.query("SELECT to_regclass($1) AS t", [`public.${name}`]);
  return Boolean(rows[0].t);
}

async function buildBackup({ includeImages = true } = {}) {
  const data = {};
  const counts = {};

  for (const table of TABLES) {
    if (!(await tableExists(table))) continue;
    const { rows } = await pool.query(`SELECT * FROM ${table}`);
    const strip = STRIP_COLUMNS[table] || [];

    data[table] = rows.map((row) => {
      const out = { ...row };
      strip.forEach((c) => delete out[c]);
      // Images are base64 blobs — they dominate the file size. Dropping
      // them makes a backup small enough to email or message.
      if (!includeImages && (table === "inventory" || table === "employees")) out.image = null;
      return out;
    });
    counts[table] = data[table].length;
  }

  return {
    munshi_backup: true,
    version: 5,
    generated_at: new Date().toISOString(),
    includes_images: includeImages,
    note: "Login passwords are not included. After a restore, set each user's password again.",
    counts,
    data,
  };
}

// GET /backup/export?images=0 — the whole database as one JSON file.
// Owner only: this file contains every customer and every figure.
router.get("/export", requireAuth, requireResourceAccess("audit_log"), async (req, res) => {
  try {
    const includeImages = req.query.images !== "0";
    const backup = await buildBackup({ includeImages });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="munshi-backup-${stamp}.json"`);
    res.send(JSON.stringify(backup));
  } catch (err) {
    console.error("Backup export failed:", err);
    res.status(500).json({ error: "Backup nahi bana", detail: err.message });
  }
});

// GET /backup/status — row counts and rough size, so the owner can see at
// a glance that a backup would actually contain something.
router.get("/status", requireAuth, requireResourceAccess("audit_log"), async (req, res) => {
  try {
    const counts = {};
    for (const table of TABLES) {
      if (!(await tableExists(table))) continue;
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
      counts[table] = rows[0].c;
    }
    const { rows: imgRows } = await pool.query(
      "SELECT COALESCE(SUM(length(image)), 0)::bigint AS bytes FROM inventory WHERE image IS NOT NULL"
    );
    res.json({
      counts,
      totalRows: Object.values(counts).reduce((t, c) => t + c, 0),
      imageBytes: Number(imgRows[0].bytes),
    });
  } catch (err) {
    console.error("Backup status failed:", err);
    res.status(500).json({ error: "Status nahi mila", detail: err.message });
  }
});

// GET /backup/cron?secret=... — a scheduled reminder, not a scheduled
// backup. Nothing here can push a file off this server on its own, so the
// honest thing is to nag the owner to take one rather than pretend.
router.get("/cron", async (req, res) => {
  if (!process.env.ALERTS_CRON_SECRET || req.query.secret !== process.env.ALERTS_CRON_SECRET) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }
  try {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM orders");
    const { sendText, configured } = require("../services/whatsapp");
    if (!configured() || !process.env.OWNER_WHATSAPP) {
      return res.json({ sent: false, reason: "WhatsApp not configured", orders: rows[0].c });
    }
    await sendText(
      process.env.OWNER_WHATSAPP,
      [
        "*Munshi — backup reminder*",
        "",
        `Abhi database mein ${rows[0].c} orders hain.`,
        "",
        "App kholein → Cost settings → Backup → *Backup download karein*,",
        "aur file Google Drive ya apne phone mein save kar lein.",
      ].join("\n")
    );
    res.json({ sent: true, orders: rows[0].c });
  } catch (err) {
    console.error("Backup reminder failed:", err);
    res.status(502).json({ error: "Reminder failed", detail: err.message });
  }
});

// ---------------------------------------------------------------
// POST /backup/restore  { backup, confirm: "RESTORE" }
//
// Merges a backup file back in: every row is upserted by its id, so
// running it twice changes nothing and existing rows are updated rather
// than duplicated. It never deletes — anything added since the backup
// stays. That makes it safe to run on a live database when a chunk of
// data went missing, not just on an empty one.
// ---------------------------------------------------------------
router.post("/restore", requireAuth, requireResourceAccess("audit_log"), async (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: "Sirf owner restore kar sakta hai" });

  const { backup, confirm } = req.body || {};
  if (confirm !== "RESTORE") return res.status(400).json({ error: 'Confirm field "RESTORE" hona chahiye' });
  if (!backup || backup.munshi_backup !== true || !backup.data) {
    return res.status(400).json({ error: "Ye Munshi ka backup file nahi lag raha" });
  }

  const client = await pool.connect();
  const restored = {};
  const skipped = {};

  try {
    await client.query("BEGIN");

    for (const table of TABLES) {
      const rows = backup.data[table];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      if (!(await tableExists(table))) { skipped[table] = "table missing"; continue; }

      // Only write columns this database actually has, so a backup taken
      // from an older or newer version still restores what it can.
      const { rows: colRows } = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [table]
      );
      const known = new Set(colRows.map((c) => c.column_name));
      const hasId = known.has("id");
      const conflictKey = hasId ? "id" : table === "settings" ? "key" : table === "monthly_reports" ? "month" : null;
      if (!conflictKey) { skipped[table] = "no key to merge on"; continue; }

      let count = 0;
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => known.has(c) && row[c] !== undefined);
        if (cols.length === 0) continue;

        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const updates = cols
          .filter((c) => c !== conflictKey)
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", ");

        await client.query(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})
           ON CONFLICT (${conflictKey}) DO ${updates ? `UPDATE SET ${updates}` : "NOTHING"}`,
          cols.map((c) => row[c])
        );
        count += 1;
      }
      restored[table] = count;
    }

    await client.query("COMMIT");
    res.json({ ok: true, restored, skipped, note: "Logins ke passwords restore nahi hote — Team mein dobara set karein." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Restore failed:", err);
    res.status(500).json({ error: "Restore fail ho gaya, database waise ka waisa hai", detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.buildBackup = buildBackup;
