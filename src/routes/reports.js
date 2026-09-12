const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess } = require("../middleware/auth");

const router = express.Router();

// GET /reports/monthly?month=2024-09  — owner only
// Returns complete monthly report: revenue, expenses, commissions, profit, etc.
router.get("/monthly", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM format
    const monthStart = `${month}-01`;

    // Parse year and month first — needed before computing the month's last day
    const [year, monthNum] = month.split('-').map(Number);
    const lastDay = new Date(year, monthNum, 0).getDate();
    const actualEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

    // Total revenue from orders
    const { rows: revenueRow } = await pool.query(
      `SELECT COALESCE(SUM(sell), 0) as total_revenue FROM orders 
       WHERE date >= $1 AND date <= $2 AND status IN ('Shipped', 'Delivered')`,
      [monthStart, actualEnd]
    );
    const totalRevenue = parseFloat(revenueRow[0].total_revenue || 0);

    // Total cost
    const { rows: costRow } = await pool.query(
      `SELECT COALESCE(SUM(cost), 0) as total_cost FROM orders 
       WHERE date >= $1 AND date <= $2`,
      [monthStart, actualEnd]
    );
    const totalCost = parseFloat(costRow[0].total_cost || 0);

    // Affiliate commissions (pending + paid)
    const { rows: affiliateRow } = await pool.query(
      `SELECT 
        COALESCE(SUM(commission), 0) as total_commission,
        COALESCE(SUM(CASE WHEN payment = 'Pending' THEN commission ELSE 0 END), 0) as pending_commission,
        COALESCE(SUM(CASE WHEN payment = 'Paid' THEN commission ELSE 0 END), 0) as paid_commission
       FROM affiliates
       WHERE updated_at >= $1 AND updated_at <= $2`,
      [monthStart, actualEnd]
    );
    const totalCommission = parseFloat(affiliateRow[0].total_commission || 0);
    const pendingCommission = parseFloat(affiliateRow[0].pending_commission || 0);
    const paidCommission = parseFloat(affiliateRow[0].paid_commission || 0);

    // Employee salaries
    const { rows: salaryRow } = await pool.query(
      `SELECT COALESCE(SUM(salary), 0) as total_salary FROM employees 
       WHERE updated_at >= $1 AND updated_at <= $2`,
      [monthStart, actualEnd]
    );
    const totalSalary = parseFloat(salaryRow[0].total_salary || 0);

    // Expenses
    const { rows: expensesRow } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total_expenses FROM expenses 
       WHERE date >= $1 AND date <= $2`,
      [monthStart, actualEnd]
    );
    const totalExpenses = parseFloat(expensesRow[0].total_expenses || 0);

    // Calculate profit
    const netProfit = totalRevenue - totalCost - totalCommission - totalSalary - totalExpenses;

    // Breakdown by category
    const { rows: expensesByCategory } = await pool.query(
      `SELECT category, COALESCE(SUM(amount), 0) as amount FROM expenses 
       WHERE date >= $1 AND date <= $2
       GROUP BY category ORDER BY amount DESC`,
      [monthStart, actualEnd]
    );

    const { rows: ordersByStatus } = await pool.query(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(sell), 0) as revenue FROM orders 
       WHERE date >= $1 AND date <= $2
       GROUP BY status`,
      [monthStart, actualEnd]
    );

    const { rows: affiliateStats } = await pool.query(
      `SELECT 
        COUNT(*) as total_affiliates,
        COALESCE(SUM(sales), 0) as total_affiliate_sales,
        COALESCE(SUM(commission), 0) as total_affiliate_commission
       FROM affiliates
       WHERE updated_at >= $1 AND updated_at <= $2`,
      [monthStart, actualEnd]
    );

    res.json({
      month,
      summary: {
        totalRevenue,
        totalCost,
        totalCommission,
        totalSalary,
        totalExpenses,
        netProfit,
        margin: totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(2) : 0,
      },
      affiliates: {
        totalAffiliates: parseInt(affiliateStats[0].total_affiliates || 0),
        totalSales: parseFloat(affiliateStats[0].total_affiliate_sales || 0),
        totalCommission: parseFloat(affiliateStats[0].total_affiliate_commission || 0),
        pendingCommission,
        paidCommission,
      },
      orders: ordersByStatus.map(o => ({
        status: o.status,
        count: parseInt(o.count),
        revenue: parseFloat(o.revenue),
      })),
      expenses: expensesByCategory.map(e => ({
        category: e.category || "Uncategorized",
        amount: parseFloat(e.amount),
      })),
    });
  } catch (err) {
    console.error("Monthly report error:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// GET /reports/monthly-list  — list available months with data
router.get("/monthly-list", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT TO_CHAR(date, 'YYYY-MM') as month FROM orders
       UNION
       SELECT DISTINCT TO_CHAR(date, 'YYYY-MM') as month FROM expenses
       ORDER BY month DESC
       LIMIT 12`
    );
    res.json(rows.map(r => r.month));
  } catch (err) {
    console.error("Monthly list error:", err);
    res.status(500).json({ error: "Failed to fetch months" });
  }
});

// =====================================================================
// Month-end analysis sheet — the "khud he ban jaye" part.
//
// generateMonthlySheet() freezes a full month of analytics into
// monthly_reports so the owner has a permanent record even if orders are
// edited later. It runs automatically from the cron endpoint below, and
// the UI can also ask for any month on demand.
// =====================================================================
const { buildAnalytics } = require("./analytics");

function monthBounds(month) {
  const [year, monthNum] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNum, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

async function generateMonthlySheet(month) {
  const { from, to } = monthBounds(month);
  const analytics = await buildAnalytics({ from, to });

  const { rows: lowStock } = await pool.query(
    "SELECT name, sku, quantity, reorder FROM inventory WHERE quantity <= reorder ORDER BY quantity ASC"
  );
  const { rows: stockRow } = await pool.query(
    "SELECT COALESCE(SUM(quantity * cost),0) AS invested, COALESCE(SUM(quantity * price),0) AS retail FROM inventory"
  );
  const { rows: returnReasons } = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(return_reason),''),'Not specified') AS reason,
            COUNT(*)::int AS count
       FROM orders
      WHERE status = 'Returned' AND date >= $1 AND date <= $2
      GROUP BY 1 ORDER BY 2 DESC`,
    [from, to]
  );

  const sheet = {
    ...analytics,
    month,
    stock: {
      invested: Number(stockRow[0].invested),
      retailValue: Number(stockRow[0].retail),
      lowStock,
    },
    returnReasons,
  };

  await pool.query(
    `INSERT INTO monthly_reports (month, data, generated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (month) DO UPDATE SET data = EXCLUDED.data, generated_at = now()`,
    [month, sheet]
  );

  return sheet;
}

// GET /reports/sheet?month=2026-09 — build (and save) the analysis sheet
router.get("/sheet", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    res.json(await generateMonthlySheet(month));
  } catch (err) {
    console.error("Monthly sheet failed:", err);
    res.status(500).json({ error: "Failed to build monthly sheet", detail: err.message });
  }
});

// GET /reports/saved — list every frozen month-end sheet
router.get("/saved", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT month, generated_at FROM monthly_reports ORDER BY month DESC LIMIT 24"
  );
  res.json(rows);
});

// GET /reports/saved/:month — read one back exactly as it was frozen
router.get("/saved/:month", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  const { rows } = await pool.query("SELECT data, generated_at FROM monthly_reports WHERE month = $1", [req.params.month]);
  if (!rows[0]) return res.status(404).json({ error: "No saved sheet for that month" });
  res.json({ ...rows[0].data, generatedAt: rows[0].generated_at });
});

// GET /reports/month-end/cron?secret=... — point a Railway Cron Job at this
// with schedule "5 0 1 * *" (00:05 on the 1st of every month). It freezes
// LAST month automatically, so the owner never has to remember to run it.
router.get("/month-end/cron", async (req, res) => {
  if (!process.env.ALERTS_CRON_SECRET || req.query.secret !== process.env.ALERTS_CRON_SECRET) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }
  try {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const month = req.query.month || `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    const sheet = await generateMonthlySheet(month);
    console.log(`Month-end sheet generated for ${month}: net profit ${sheet.summary.netProfit}`);
    res.json({ ok: true, month, summary: sheet.summary });
  } catch (err) {
    console.error("Month-end cron failed:", err);
    res.status(500).json({ error: "Month-end job failed", detail: err.message });
  }
});

module.exports = router;
module.exports.generateMonthlySheet = generateMonthlySheet;
