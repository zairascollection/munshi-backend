const pool = require("../db/pool");

/**
 * Fetch YITH affiliates from WordPress REST API
 * NO authentication required - open endpoint
 */
async function fetchYithAffiliates() {
  if (!process.env.YITH_SYNC_URL) {
    console.log("YITH_SYNC_URL not configured - skipping affiliate sync");
    return null;
  }

  try {
    const res = await fetch(process.env.YITH_SYNC_URL, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        // No auth header needed
      },
    });

    if (!res.ok) {
      throw new Error(`YITH endpoint returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Error fetching YITH affiliates:", err.message);
    throw err;
  }
}

/**
 * Upsert a single YITH affiliate into Munshi database
 */
async function upsertYithAffiliate(a) {
  // Calculate commission status
  const commission = Number(a.commission || 0);
  const payment = commission > 0 ? "Pending" : "Paid";

  try {
    const { rows } = await pool.query(
      `INSERT INTO affiliates 
       (name, email, platform, rate, sales, commission, status, payment, wc_affiliate_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (wc_affiliate_id)
       DO UPDATE SET 
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         rate = EXCLUDED.rate,
         sales = EXCLUDED.sales,
         commission = EXCLUDED.commission,
         payment = EXCLUDED.payment,
         updated_at = now()
       RETURNING *`,
      [
        a.name || a.email,
        a.email || "",
        a.platform || "Website",
        Number(a.rate || 10),
        Number(a.sales || 0),
        commission,
        a.status || "Active",
        payment,
        a.id || a.affiliate_id || Math.random(), // Unique ID
      ]
    );

    return rows[0];
  } catch (err) {
    console.error("Error upserting affiliate:", err.message);
    throw err;
  }
}

/**
 * Sync all YITH affiliates from WordPress to Munshi database
 */
async function syncYithAffiliates() {
  try {
    const list = await fetchYithAffiliates();

    if (!list || list.length === 0) {
      console.log("No affiliates to sync");
      return { synced: 0, skipped: false, message: "No affiliates found" };
    }

    let synced = 0;
    let errors = 0;

    for (const affiliate of list) {
      try {
        await upsertYithAffiliate(affiliate);
        synced++;
      } catch (err) {
        console.error(`Failed to sync affiliate ${affiliate.name}:`, err.message);
        errors++;
      }
    }

    console.log(`Affiliate sync complete: ${synced} synced, ${errors} errors`);
    return {
      synced,
      failed: errors,
      skipped: false,
      message: `Synced ${synced} affiliates${errors > 0 ? `, ${errors} failed` : ""}`,
    };
  } catch (err) {
    console.error("Affiliate sync failed:", err.message);
    throw err;
  }
}

module.exports = { syncYithAffiliates, fetchYithAffiliates };
