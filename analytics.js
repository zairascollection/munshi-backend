const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------
// Shared profit engine — used by /analytics and by the month-end
// snapshot job in routes/reports.js so both always agree.
//
// The model follows how a COD store actually loses money:
//   revenue        = sales of orders that were NOT returned
//   COGS           = product cost of those orders
//   delivery       = courier fee on every dispatched order
//   return charges = courier fee on returned orders (money gone,
//                    with no revenue to show for it)
//   refunds        = cash handed back to the customer
//   packaging      = per-order packing cost
//   cash handling  = % the courier keeps on COD collections
//   ad spend       = marketing
//   opex           = salaries + affiliate commissions + expenses
// ---------------------------------------------------------------
async function buildAnalytics({ from, to }) {
  const { rows: settingRows } = await pool.query("SELECT key, value FROM settings");
  const s = Object.fromEntries(settingRows.map((r) => [r.key, Number(r.value) || 0]));
  const packagingCost = s.packaging_cost || 0;
  const cashHandlingPct = s.cash_handling_pct || 0;
  const taxPct = s.tax_pct || 0;

  const { rows: orders } = await pool.query(
    "SELECT * FROM orders WHERE date >= $1 AND date <= $2 ORDER BY date ASC",
    [from, to]
  );
  const { rows: ads } = await pool.query(
    "SELECT * FROM ad_spend WHERE date >= $1 AND date <= $2",
    [from, to]
  );
  const { rows: expenseRows } = await pool.query(
    "SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE date >= $1 AND date <= $2",
    [from, to]
  );
  const { rows: salaryRows } = await pool.query(
    "SELECT COALESCE(SUM(salary),0) AS total FROM employees WHERE status = 'Paid'"
  );
  const { rows: commRows } = await pool.query(
    "SELECT COALESCE(SUM(commission),0) AS total FROM affiliates"
  );
  const { rows: expenseByCat } = await pool.query(
    `SELECT COALESCE(category,'Uncategorized') AS category, COALESCE(SUM(amount),0) AS amount
       FROM expenses WHERE date >= $1 AND date <= $2 GROUP BY 1 ORDER BY 2 DESC`,
    [from, to]
  );

  const n = (v) => Number(v) || 0;
  const sold = orders.filter((o) => o.status !== "Returned");
  const returned = orders.filter((o) => o.status === "Returned");
  const delivered = orders.filter((o) => o.status === "Delivered");

  const revenue = sold.reduce((t, o) => t + n(o.sell), 0);
  const cogs = sold.reduce((t, o) => t + n(o.cost), 0);
  const deliveredRevenue = delivered.reduce((t, o) => t + n(o.sell), 0);
  const cashCollected = orders.reduce((t, o) => t + n(o.amount_paid), 0);

  const deliveryCharges = orders
    .filter((o) => o.status !== "Pending")
    .reduce((t, o) => t + n(o.delivery_charge), 0);
  const returnCharges = returned.reduce((t, o) => t + n(o.return_charge), 0);
  const refunds = returned.reduce((t, o) => t + n(o.refund_amount), 0);
  const packaging = orders.length * packagingCost;
  const cashHandling = (cashCollected * cashHandlingPct) / 100;
  const tax = (revenue * taxPct) / 100;

  const adSpend = ads.reduce((t, a) => t + n(a.amount), 0);

  // employees.salary is a MONTHLY figure, so for any window that isn't a
  // full month it gets pro-rated by days — otherwise a 7-day view would
  // subtract a whole month's payroll and show a fake loss.
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5) + 1);
  const salaries = n(salaryRows[0].total) * Math.min(1, days / 30);
  const commissions = n(commRows[0].total);
  const otherExpenses = n(expenseRows[0].total);

  const grossProfit = revenue - cogs;
  const codCosts = deliveryCharges + returnCharges + refunds + packaging + cashHandling;
  const contributionProfit = grossProfit - codCosts - adSpend;
  const netProfit = contributionProfit - salaries - commissions - otherExpenses - tax;

  const group = (keyFn, filterFn = () => true) => {
    const map = {};
    orders.filter(filterFn).forEach((o) => {
      const k = (keyFn(o) || "Unknown").toString().trim() || "Unknown";
      if (!map[k]) map[k] = { key: k, orders: 0, delivered: 0, returned: 0, revenue: 0, cost: 0, charges: 0 };
      const g = map[k];
      g.orders += 1;
      if (o.status === "Delivered") g.delivered += 1;
      if (o.status === "Returned") {
        g.returned += 1;
        g.charges += n(o.return_charge) + n(o.refund_amount);
      } else {
        g.revenue += n(o.sell);
        g.cost += n(o.cost);
      }
      g.charges += n(o.delivery_charge);
    });
    return Object.values(map)
      .map((g) => ({
        ...g,
        profit: g.revenue - g.cost - g.charges,
        returnRate: g.orders ? Math.round((g.returned / g.orders) * 1000) / 10 : 0,
        deliveryRate: g.orders ? Math.round((g.delivered / g.orders) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  };

  // Product-level P&L. POS and the WooCommerce sync both write the product
  // column as "Name x2, Other x1", so parse that into per-item units.
  const productMap = {};
  orders.forEach((o) => {
    if (!o.product) return;
    const segs = String(o.product).split(",").map((x) => x.trim()).filter(Boolean);
    const totalUnits = segs.reduce((t, seg) => {
      const m = seg.match(/\sx(\d+(?:\.\d+)?)$/i);
      return t + (m ? Number(m[1]) : 1);
    }, 0) || 1;
    segs.forEach((seg) => {
      const m = seg.match(/^(.*)\s+x(\d+(?:\.\d+)?)$/i);
      const name = (m ? m[1] : seg).trim();
      const units = m ? Number(m[2]) : 1;
      const share = units / totalUnits;
      if (!productMap[name]) productMap[name] = { name, units: 0, returnedUnits: 0, revenue: 0, cost: 0 };
      const p = productMap[name];
      if (o.status === "Returned") {
        p.returnedUnits += units;
      } else {
        p.units += units;
        p.revenue += n(o.sell) * share;
        p.cost += n(o.cost) * share;
      }
    });
  });
  const byProduct = Object.values(productMap)
    .map((p) => ({
      ...p,
      revenue: Math.round(p.revenue),
      cost: Math.round(p.cost),
      profit: Math.round(p.revenue - p.cost),
      margin: p.revenue > 0 ? Math.round(((p.revenue - p.cost) / p.revenue) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.profit - a.profit);

  const dailyMap = {};
  orders.forEach((o) => {
    const d = (o.date instanceof Date ? o.date.toISOString().slice(0, 10) : String(o.date)).slice(0, 10);
    if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, cost: 0, orders: 0, adSpend: 0 };
    dailyMap[d].orders += 1;
    if (o.status !== "Returned") {
      dailyMap[d].revenue += n(o.sell);
      dailyMap[d].cost += n(o.cost);
    }
  });
  ads.forEach((a) => {
    const d = (a.date instanceof Date ? a.date.toISOString().slice(0, 10) : String(a.date)).slice(0, 10);
    if (!dailyMap[d]) dailyMap[d] = { date: d, revenue: 0, cost: 0, orders: 0, adSpend: 0 };
    dailyMap[d].adSpend += n(a.amount);
  });
  const daily = Object.values(dailyMap)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, profit: d.revenue - d.cost - d.adSpend }));

  const adByChannel = {};
  ads.forEach((a) => {
    const k = a.channel || "Other";
    adByChannel[k] = (adByChannel[k] || 0) + n(a.amount);
  });

  const round = (v) => Math.round(v * 100) / 100;

  return {
    period: { from, to },
    summary: {
      orders: orders.length,
      deliveredOrders: delivered.length,
      returnedOrders: returned.length,
      returnRate: orders.length ? Math.round((returned.length / orders.length) * 1000) / 10 : 0,
      revenue: round(revenue),
      deliveredRevenue: round(deliveredRevenue),
      cogs: round(cogs),
      grossProfit: round(grossProfit),
      deliveryCharges: round(deliveryCharges),
      returnCharges: round(returnCharges),
      refunds: round(refunds),
      packaging: round(packaging),
      cashHandling: round(cashHandling),
      codCosts: round(codCosts),
      adSpend: round(adSpend),
      contributionProfit: round(contributionProfit),
      salaries: round(salaries),
      commissions: round(commissions),
      otherExpenses: round(otherExpenses),
      tax: round(tax),
      netProfit: round(netProfit),
      margin: revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0,
      aov: sold.length ? Math.round(revenue / sold.length) : 0,
    },
    // Purchase ROAS counts every order the ads produced; post-delivery ROAS
    // only counts the ones that actually delivered — in COD markets these
    // two numbers are very different, and only the second one is real.
    roas: {
      purchase: adSpend > 0 ? Math.round((revenue / adSpend) * 100) / 100 : null,
      postDelivery: adSpend > 0 ? Math.round((deliveredRevenue / adSpend) * 100) / 100 : null,
      cac: delivered.length > 0 && adSpend > 0 ? Math.round(adSpend / delivered.length) : null,
      cashCollected: round(cashCollected),
    },
    byCity: group((o) => o.city),
    byCourier: group((o) => o.courier),
    byChannel: group((o) => o.channel || (o.source === "woocommerce" ? "Website" : "Manual / POS")),
    byStaff: group((o) => o.billed_by),
    byProduct: byProduct.slice(0, 30),
    adByChannel: Object.entries(adByChannel).map(([channel, amount]) => ({ channel, amount: round(amount) })),
    expensesByCategory: expenseByCat.map((e) => ({ category: e.category, amount: n(e.amount) })),
    settings: { packagingCost, cashHandlingPct, taxPct },
  };
}

// GET /analytics?from=2026-09-01&to=2026-09-30  — manager + owner
router.get("/", requireAuth, requireResourceAccess("analytics"), async (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = `${today.toISOString().slice(0, 7)}-01`;
    const from = req.query.from || defaultFrom;
    const to = req.query.to || today.toISOString().slice(0, 10);
    res.json(await buildAnalytics({ from, to }));
  } catch (err) {
    console.error("Analytics failed:", err);
    res.status(500).json({ error: "Analytics failed", detail: err.message });
  }
});

module.exports = router;
module.exports.buildAnalytics = buildAnalytics;
