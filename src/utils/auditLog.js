const pool = require("../db/pool");

// Compares `before` and `after` on the given columns and inserts one
// audit_log row per changed field. Values are stringified so the table can
// stay simple (one TEXT column each for old/new) regardless of the
// underlying column's real type (numeric, text, date, etc.).
// A photo is a 150 KB base64 string. Writing two of those into the audit
// table on every edit makes the history unreadable and the table enormous,
// and the owner only ever needs to know THAT the photo changed. Long values
// are summarised; everything else is stored as-is.
const MAX_LEN = 300;

// Short content fingerprint. Summarising a photo by size alone was wrong:
// two different photos of similar size produced identical summaries, so the
// comparison saw no change and the edit never reached the history at all.
function fingerprint(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

function readable(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.startsWith("data:image")) {
    return `(photo · ${Math.max(1, Math.round(s.length / 1024))} KB · ${fingerprint(s)})`;
  }
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}… (+${s.length - MAX_LEN} chars)` : s;
}

// Never let a history write break the save that triggered it. The edit has
// already been committed by this point; losing the audit line is annoying,
// losing the edit is not acceptable.
async function logChanges(args) {
  try {
    await writeChanges(args);
  } catch (err) {
    console.error("[audit] could not record change:", err.message);
  }
}

async function writeChanges({ resource, recordId, recordLabel, before, after, user, columns }) {
  const changes = [];
  for (const col of columns) {
    const oldVal = before[col];
    const newVal = after[col];
    const oldStr = readable(oldVal);
    const newStr = readable(newVal);
    if (oldStr !== newStr) {
      changes.push({ field: col, oldVal: oldStr, newVal: newStr });
    }
  }
  if (changes.length === 0) return;

  const values = [];
  const rows = [];
  changes.forEach((c, i) => {
    const base = i * 7;
    rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
    values.push(resource, recordId, recordLabel || "", c.field, c.oldVal, c.newVal, `${user.name} (${user.email})`);
  });

  await pool.query(
    `INSERT INTO audit_log (resource, record_id, record_label, field, old_value, new_value, changed_by)
     VALUES ${rows.join(", ")}`,
    values
  );
}


// ---------------------------------------------------------------
// Creates and deletes were never recorded — only edits. So adding an item
// or writing a bill left no trace at all, and a deleted record simply
// disappeared with no way to find out who removed it. For a business the
// owner does not personally run, those are the two entries that matter
// most.
// ---------------------------------------------------------------

// Fields worth showing on a "added" / "deleted" line. Anything else is
// noise, and photos would bloat the table.
const SUMMARY_FIELDS = [
  "name", "title", "order_no", "customer", "sku", "quantity",
  "price", "sell", "amount", "salary", "channel", "po_no", "ref_no",
];

function summarise(row) {
  if (!row) return "";
  return SUMMARY_FIELDS
    .filter((f) => row[f] !== null && row[f] !== undefined && row[f] !== "")
    .map((f) => `${f}: ${readable(row[f])}`)
    .join(" · ");
}

async function logLifecycle({ resource, recordId, recordLabel, row, user, action }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (resource, record_id, record_label, field, old_value, new_value, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        resource,
        recordId,
        recordLabel || "",
        action,                                   // "Added" or "Deleted"
        action === "Deleted" ? summarise(row) : "",
        action === "Added" ? summarise(row) : "",
        `${user.name} (${user.email})`,
      ]
    );
  } catch (err) {
    console.error(`[audit] could not record ${action}:`, err.message);
  }
}

const logCreate = (args) => logLifecycle({ ...args, action: "Added" });
const logDelete = (args) => logLifecycle({ ...args, action: "Deleted" });

module.exports = { logChanges, logCreate, logDelete };
