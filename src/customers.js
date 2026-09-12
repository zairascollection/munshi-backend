const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { isManagerOrAbove } = require("../utils/permissions");

const router = express.Router();
router.use(requireAuth);

// Phone numbers get typed inconsistently (0300-1234567, 03001234567,
// +923001234567), so every match uses the last 10 digits as the key.
const KEY = `RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10)`;

// GET /customers — ledger with lifetime value and return history.
// A customer is "risky" once their refused/returned parcels reach the
// threshold in settings (cod_block_after_returns, default 2).
router.get("/", async (req, res) => {
  try {
    const { rows: setting } = await pool.query("SELECT value FROM settings WHERE key = 'cod_block_after_returns'");
    const threshold = Number(setting[0]?.value) || 2;

    const { rows } = await pool.query(
      `WITH agg AS (
         SELECT ${KEY} AS phone_key,
                MAX(customer) AS name,
                MAX(phone) AS phone,
                MAX(city) AS city,
                COUNT(*)::int AS orders,
                COUNT(*) FILTER (WHERE status = 'Returned')::int AS returned,
                COUNT(*) FILTER (WHERE status = 'Delivered')::int AS delivered,
                COALESCE(SUM(CASE WHEN status <> 'Returned' THEN sell ELSE 0 END), 0) AS lifetime_value,
                COALESCE(SUM(CASE WHEN status <> 'Returned' THEN GREATEST(sell - amount_paid, 0) ELSE 0 END), 0) AS outstanding,
                COALESCE(SUM(CASE WHEN status = 'Returned' THEN return_charge + refund_amount + delivery_charge ELSE 0 END), 0) AS return_cost,
                MAX(date) AS last_order
           FROM orders
          WHERE COALESCE(phone, '') <> ''
          GROUP BY ${KEY}
       )
       SELECT agg.*,
              c.id AS customer_id, c.notes, c.cod_blocked
         FROM agg
         LEFT JOIN customers c ON RIGHT(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10) = agg.phone_key
        ORDER BY agg.lifetime_value DESC`
    );

    const out = rows.map((r) => {
      const returnRate = r.orders ? Math.round((r.returned / r.orders) * 1000) / 10 : 0;
      const risky = r.returned >= threshold;
      return {
        ...r,
        lifetime_value: Number(r.lifetime_value),
        outstanding: Number(r.outstanding),
        return_cost: Number(r.return_cost),
        returnRate,
        risky,
        // Only managers and owners see what a customer has cost the business.
        ...(isManagerOrAbove(req.user) ? {} : { return_cost: undefined }),
      };
    });
    res.json({ threshold, customers: out });
  } catch (err) {
    console.error("Customers failed:", err);
    res.status(500).json({ error: "Could not load customers", detail: err.message });
  }
});

// GET /customers/risk/:phone — quick lookup used while writing an order,
// so a repeat refuser is flagged before the parcel is booked.
router.get("/risk/:phone", async (req, res) => {
  const digits = String(req.params.phone).replace(/[^0-9]/g, "").slice(-10);
  if (digits.length < 7) return res.json({ found: false });

  const { rows: setting } = await pool.query("SELECT value FROM settings WHERE key = 'cod_block_after_returns'");
  const threshold = Number(setting[0]?.value) || 2;

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE status = 'Returned')::int AS returned,
            COALESCE(SUM(CASE WHEN status <> 'Returned' THEN sell ELSE 0 END),0) AS lifetime_value
       FROM orders
      WHERE ${KEY} = $1`,
    [digits]
  );
  const { rows: c } = await pool.query(
    "SELECT notes, cod_blocked FROM customers WHERE RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1",
    [digits]
  );

  const stats = rows[0];
  res.json({
    found: stats.orders > 0 || Boolean(c[0]),
    orders: stats.orders,
    returned: stats.returned,
    lifetimeValue: Number(stats.lifetime_value),
    codBlocked: Boolean(c[0]?.cod_blocked),
    notes: c[0]?.notes || null,
    risky: stats.returned >= threshold || Boolean(c[0]?.cod_blocked),
    threshold,
  });
});

// PUT /customers/:phone  { name, city, notes, cod_blocked }
// Upserts on phone — the ledger row may not exist until someone flags them.
router.put("/:phone", async (req, res) => {
  const { name, city, notes, cod_blocked } = req.body || {};
  const phone = String(req.params.phone);
  const { rows } = await pool.query(
    `INSERT INTO customers (phone, name, city, notes, cod_blocked)
     VALUES ($1, $2, $3, $4, COALESCE($5, false))
     ON CONFLICT (phone) DO UPDATE
        SET name = COALESCE(EXCLUDED.name, customers.name),
            city = COALESCE(EXCLUDED.city, customers.city),
            notes = EXCLUDED.notes,
            cod_blocked = COALESCE(EXCLUDED.cod_blocked, customers.cod_blocked),
            updated_at = now()
     RETURNING *`,
    [phone, name || null, city || null, notes || null, cod_blocked]
  );
  res.json(rows[0]);
});

module.exports = router;
