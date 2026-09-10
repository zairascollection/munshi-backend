const pool = require("../db/pool");

/**
 * Fetch YITH affiliates from standalone WordPress endpoint
 */
async function fetchYithAffiliates() {
  if (!process.env.YITH_SYNC_URL) {
    console.log("YITH_SYNC_URL not configured - skipping affiliate sync");
    return null;
  }

  try {
    console.log("Fetching affiliates from:", process.env.YITH_SYNC_URL);
    
    const res = await fetch(process.env.YITH_SYNC_URL, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Response status:", res.status);
      console.error("Response body:", text);
      throw new Error(`Endpoint returned ${res.status}: ${text}`);
    }

    const data = await res.json();
    console.log(`✅ Fetched ${Array.isArray(data) ? data.length : 0} affiliates`);
    
    if (!Array.isArray(data)) {
      throw new Error("Response is not an array");
    }
    
    return data;
  } catch (err) {
    console.error("❌ Error fetching YITH affiliates:", err.message);
    throw err;
  }
}

/**
 * Upsert a single affiliate into database
 */
async function upsertYithAffiliate(a) {
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
        a.name || a.email || "Unknown",
        a.email || "",
        a.platform || "Website",
        Number(a.rate || 10),
        Number(a.sales || 0),
        commission,
        a.status || "Active",
        payment,
        a.id || a.affiliate_id || `aff_${Date.now()}_${Math.random()}`,
      ]
    );

    return rows[0];
  } catch (err) {
    console.error("Error upserting affiliate:", err.message);
    return null;
  }
}

/**
 * Sync all affiliates
 */
async function syncYithAffiliates() {
  try {
    console.log("🔄 Starting affiliate sync...");
    
    const list = await fetchYithAffiliates();

    if (!list || list.length === 0) {
      console.log("⚠️ No affiliates to sync");
      return { 
        synced: 0, 
        skipped: false, 
        message: "No affiliates found" 
      };
    }

    console.log(`📊 Syncing ${list.length} affiliates...`);

    let synced = 0;
    let errors = 0;

    for (const affiliate of list) {
      try {
        const result = await upsertYithAffiliate(affiliate);
        if (result) {
          synced++;
          console.log(`  ✅ ${affiliate.name}`);
        }
      } catch (err) {
        errors++;
        console.error(`  ❌ Failed to sync ${affiliate.name}:`, err.message);
      }
    }

    console.log(`✅ Sync complete: ${synced} synced, ${errors} errors`);
    
    return {
      synced,
      failed: errors,
      skipped: false,
      message: `Synced ${synced} affiliates${errors > 0 ? `, ${errors} failed` : ""}`,
    };
  } catch (err) {
    console.error("❌ Affiliate sync failed:", err.message);
    return {
      synced: 0,
      failed: 0,
      skipped: false,
      error: err.message,
    };
  }
}

module.exports = { syncYithAffiliates, fetchYithAffiliates };
