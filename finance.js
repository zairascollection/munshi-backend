const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireResourceAccess } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireResourceAccess("finance"));

// GET /finance/summary — same shape as the `metrics` useMemo in munshi.jsx
router.get("/summary", async (req, res) => {
  const [orders, employees, affiliates, expenses, accounts] = await Promise.all([
    pool.query("SELECT * FROM orders WHERE status != 'Returned'"),
    pool.query("SELECT * FROM employees"),
    pool.query("SELECT * FROM affiliates"),
    pool.query("SELECT * FROM expenses"),
    pool.query("SELECT * FROM accounts"),
  ]);

  const activeOrders = orders.rows;
  const revenue = activeOrders.reduce((s, o) => s + Number(o.sell || 0), 0);
  const cogs = activeOrders.reduce((s, o) => s + Number(o.cost || 0), 0);
  const grossProfit = revenue - cogs;
  const salaries = employees.rows.reduce((s, e) => s + Number(e.salary || 0), 0);
  const commissions = affiliates.rows.reduce((s, a) => s + Number(a.commission || 0), 0);
  const totalExpenses = expenses.rows.reduce((s, x) => s + Number(x.amount || 0), 0);
  const netProfit = grossProfit - salaries - commissions - totalExpenses;
  const totalBalance = accounts.rows.reduce((s, a) => s + Number(a.balance || 0), 0);

  const amountDue = (o) => Math.max(0, Number(o.sell || 0) - Number(o.amount_paid || 0));
  const receivable = activeOrders.reduce((s, o) => s + amountDue(o), 0);
  const payable =
    employees.rows.filter((e) => e.status === "Pending").reduce((s, e) => s + Number(e.salary || 0), 0) +
    affiliates.rows.filter((a) => a.payment === "Pending").reduce((s, a) => s + Number(a.commission || 0), 0);

  res.json({ revenue, cogs, grossProfit, salaries, commissions, totalExpenses, netProfit, receivable, payable, totalBalance });
});

// GET /finance/ledger — customer khata: who owes what, grouped by customer
router.get("/ledger", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT customer,
            SUM(GREATEST(sell - amount_paid, 0)) AS due,
            MIN(due_date) FILTER (WHERE due_date IS NOT NULL) AS next_due
     FROM orders
     WHERE status != 'Returned' AND sell > amount_paid
     GROUP BY customer
     ORDER BY due DESC`
  );
  res.json(rows);
});

module.exports = router;
