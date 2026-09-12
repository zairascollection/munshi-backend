const pool = require("../db/pool");

// YITH WooCommerce Affiliates doesn't expose a public REST API the way
// WooCommerce core does, so this relies on a small custom endpoint added
// to the WordPress site (see /wordpress-snippets/munshi-yith-bridge.php in
// this project) that reads YITH's own database tables and returns a plain
// JSON summary per affiliate. This is best-effort: exact field names in
// YITH's tables can vary slightly by plugin version, so double-check the
// numbers here against YITH's own admin screens after the first sync.
async function fetchYithAffiliates() {
  if (!process.env.YITH_SYNC_URL || !process.env.YITH_SYNC_SECRET) {
    return null; // not configured — caller should skip silently
  }
  const res = await fetch(process.env.YITH_SYNC_URL, {
    headers: { "x-munshi-secret": process.env.YITH_SYNC_SECRET },
  });
  if (!res.ok) throw new Error(`YITH bridge error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Each YITH affiliate becomes one Munshi affiliate row (upserted by
// wc_affiliate_id). `commission` mirrors Munshi's existing single-total
// model: it's set to the sum of pending + paid commission, and the
// Paid/Pending flag reflects whether anything is still owed — matching
// how the manual Affiliates panel already works, just filled in automatically.
async function upsertYithAffiliate(a) {
  const commission = Number(a.commission_pending || 0) + Number(a.commission_paid || 0);
  const payment = Number(a.commission_pending || 0) > 0 ? "Pending" : "Paid";

  const { rows } = await pool.query(
    `INSERT INTO affiliates (name, platform, rate, sales, commission, status, payment, wc_affiliate_id)
     VALUES ($1, 'Website', $2, $3, $4, 'Active', $5, $6)
     ON CONFLICT (wc_affiliate_id)
     DO UPDATE SET rate = EXCLUDED.rate, sales = EXCLUDED.sales, commission = EXCLUDED.commission,
                    payment = EXCLUDED.payment, updated_at = now()
     RETURNING *`,
    [a.name, Number(a.rate || 0), Number(a.sales || 0), commission, payment, a.affiliate_id]
  );
  return rows[0];
}

async function syncYithAffiliates() {
  const list = await fetchYithAffiliates();
  if (list === null) return { synced: 0, skipped: true };
  let synced = 0;
  for (const a of list) {
    await upsertYithAffiliate(a);
    synced += 1;
  }
  return { synced, skipped: false };
}

module.exports = { syncYithAffiliates };
