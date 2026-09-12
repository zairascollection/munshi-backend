const pool = require("../db/pool");

// Compares `before` and `after` on the given columns and inserts one
// audit_log row per changed field. Values are stringified so the table can
// stay simple (one TEXT column each for old/new) regardless of the
// underlying column's real type (numeric, text, date, etc.).
async function logChanges({ resource, recordId, recordLabel, before, after, user, columns }) {
  const changes = [];
  for (const col of columns) {
    const oldVal = before[col];
    const newVal = after[col];
    const oldStr = oldVal === null || oldVal === undefined ? "" : String(oldVal);
    const newStr = newVal === null || newVal === undefined ? "" : String(newVal);
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

module.exports = { logChanges };
