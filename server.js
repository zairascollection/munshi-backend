require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const pool = require("./db/pool");

const authRoutes = require("./routes/auth");
const ordersRoutes = require("./routes/orders");
const webhookRoutes = require("./routes/webhooks");
const financeRoutes = require("./routes/finance");
const reportsRoutes = require("./routes/reports");
const { inventoryRouter, employeesRouter, affiliatesRouter, accountsRouter, expensesRouter } = require("./routes/resources");
const { requireAuth, requireResourceAccess } = require("./middleware/auth");
const { syncRecentOrders } = require("./services/woocommerce");
const { syncYithAffiliates } = require("./services/yith");
const { sendLowStockAlert } = require("./services/alerts");

const app = express();

// Logs every incoming request's method and path to Railway's Deploy Logs —
// useful for confirming requests are actually reaching this process.
app.use((req, res, next) => {
  console.log(`[req] ${req.method} ${req.originalUrl} — origin: ${req.headers.origin || "(none)"}`);
  next();
});

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : "*";

// Manual CORS handling (instead of the `cors` package) so preflight
// (OPTIONS) requests are answered directly by this middleware, with no
// dependency on how any library internally matches request methods.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (corsOrigin === "*") {
    res.header("Access-Control-Allow-Origin", "*");
  } else if (Array.isArray(corsOrigin) && origin && corsOrigin.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-wc-webhook-signature, x-wc-webhook-topic, x-wc-webhook-delivery-id");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// The webhook route needs the raw request body to verify WooCommerce's
// HMAC signature, so it's mounted BEFORE express.json() and given its
// own raw body parser, scoped to just this path.
app.use("/webhooks", express.raw({ type: "application/json" }), webhookRoutes);

// Everything else gets normal JSON body parsing. Limit raised from the
// 100kb default since inventory photos are sent as base64 in the JSON body.
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/inventory", inventoryRouter);
app.use("/orders", ordersRoutes);
app.use("/employees", employeesRouter);
app.use("/affiliates", affiliatesRouter);
app.use("/accounts", accountsRouter);
app.use("/expenses", expensesRouter);
app.use("/finance", financeRoutes);
app.use("/audit-log", require("./routes/auditLog"));
app.use("/reports", reportsRoutes);

// Manual "sync now" button for the UI, and a fallback if webhooks are
// ever missed. Owner-only since it touches store-wide order data.
app.post("/sync/woocommerce", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  try {
    const count = await syncRecentOrders({ days: req.body?.days });
    let affiliates = null;
    try {
      affiliates = await syncYithAffiliates();
    } catch (err) {
      console.error("Affiliate sync failed (orders sync still succeeded):", err);
    }
    res.json({ ok: true, ordersSynced: count, affiliates });
  } catch (err) {
    console.error("Manual sync failed:", err);
    res.status(502).json({ error: "WooCommerce sync failed", detail: err.message });
  }
});

app.post("/sync/affiliates", requireAuth, requireResourceAccess("affiliates"), async (req, res) => {
  try {
    const result = await syncYithAffiliates();
    if (result.skipped) {
      return res.status(400).json({ error: "YITH_SYNC_URL / YITH_SYNC_SECRET not configured yet" });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Affiliate sync failed:", err);
    res.status(502).json({ error: "Affiliate sync failed", detail: err.message });
  }
});

// Manual "send low stock alert now" button (owner only).
app.post("/alerts/low-stock", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  try {
    const result = await sendLowStockAlert();
    res.json(result);
  } catch (err) {
    console.error("Low stock alert failed:", err);
    res.status(502).json({ error: "Alert failed", detail: err.message });
  }
});

// Scheduled version for Railway's Cron Job feature — not JWT-protected since
// a cron job can't log in, guarded by a shared secret instead. Set up a Cron
// Job service in Railway pointing at:
//   GET https://<your-backend-domain>/alerts/low-stock/cron?secret=<ALERTS_CRON_SECRET>
// with a schedule like "0 9 * * *" (9am daily).
app.get("/alerts/low-stock/cron", async (req, res) => {
  if (!process.env.ALERTS_CRON_SECRET || req.query.secret !== process.env.ALERTS_CRON_SECRET) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }
  try {
    const result = await sendLowStockAlert();
    res.json(result);
  } catch (err) {
    console.error("Scheduled low stock alert failed:", err);
    res.status(502).json({ error: "Alert failed", detail: err.message });
  }
});

// Centralized error handler so a thrown error in any route doesn't crash the process
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// --- Startup: run the schema migration, and create the first owner login ---
// This runs in the same environment the app actually serves requests from,
// which sidesteps platforms (like some Railway console sessions) where an
// interactive shell doesn't get the service's environment variables.
// Both steps are safe to run on every boot: schema.sql only uses
// CREATE TABLE IF NOT EXISTS, and the owner bootstrap only inserts if no
// users exist yet.
async function runMigration() {
  const sql = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Schema migration applied.");
}

async function bootstrapOwner() {
  const { name, email, password } = {
    name: process.env.OWNER_NAME,
    email: process.env.OWNER_EMAIL,
    password: process.env.OWNER_PASSWORD,
  };
  if (!name || !email || !password) return; // not configured, skip silently

  const { rows } = await pool.query("SELECT 1 FROM users LIMIT 1");
  if (rows.length > 0) return; // someone already exists, don't touch it

  const password_hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'owner')
     ON CONFLICT (email) DO NOTHING`,
    [name, email.toLowerCase(), password_hash]
  );
  console.log(`Owner login bootstrapped for ${email}.`);
}

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await runMigration();
    await bootstrapOwner();
  } catch (err) {
    console.error("Startup migration/bootstrap failed:", err);
    // Don't crash the whole app over this — the API can still come up and
    // the error will be visible in the logs for debugging.
  }
  app.listen(PORT, () => {
    console.log(`Munshi backend listening on port ${PORT}`);
  });
})();
