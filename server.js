require("dotenv").config();

// Teaches Express 4 to catch async handler rejections instead of letting
// them kill the process. Must come before the route files below.
require("./utils/asyncErrors");

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
const { inventoryRouter, employeesRouter, affiliatesRouter, accountsRouter, expensesRouter, adSpendRouter, suppliersRouter, imageRouter } = require("./routes/resources");
const { requireAuth, requireResourceAccess } = require("./middleware/auth");
const { syncRecentOrders } = require("./services/woocommerce");
const { syncYithAffiliates } = require("./services/yith");
const { sendLowStockAlert } = require("./services/alerts");
const { pushAllStock } = require("./services/woocommerce");
const { sendDailyDigest } = require("./services/whatsapp");

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
app.use(express.json({ limit: "60mb" }));

// Deliberately 200 whenever the process is alive, with the database state
// in the body. Railway checks this during a deploy, and a two-second blip
// on the database should not mark an otherwise good deploy as failed.
app.get("/health", async (req, res) => {
  const dbOk = await pool.isHealthy();
  res.json({ ok: true, db: dbOk ? "up" : "down", uptime: Math.round(process.uptime()) });
});

// The strict version, for monitoring rather than deploys: 503 when the
// database cannot be reached, so an uptime checker can actually alert.
app.get("/health/db", async (req, res) => {
  const dbOk = await pool.isHealthy();
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: dbOk ? "up" : "down" });
});

app.use("/auth", authRoutes);
// Image route first: it is public and must not hit the auth middleware.
app.use("/inventory", imageRouter);
app.use("/inventory", inventoryRouter);
app.use("/orders", ordersRoutes);
app.use("/employees", employeesRouter);
app.use("/affiliates", affiliatesRouter);
app.use("/accounts", accountsRouter);
app.use("/expenses", expensesRouter);
app.use("/finance", financeRoutes);
app.use("/audit-log", require("./routes/auditLog"));
app.use("/reports", reportsRoutes);
app.use("/ad-spend", adSpendRouter);
app.use("/settings", require("./routes/settings"));
app.use("/analytics", require("./routes/analytics"));
app.use("/suppliers", suppliersRouter);
app.use("/purchases", require("./routes/purchases"));
app.use("/customers", require("./routes/customers"));
app.use("/consignments", require("./routes/consignments"));
app.use("/backup", require("./routes/backup"));
app.use("/whatsapp", require("./routes/whatsapp"));

// Push every linked inventory row's quantity back to WooCommerce.
// Manual button in the UI, and a safety net if a single push was missed.
app.post("/sync/stock", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  try {
    const result = await pushAllStock();
    if (result.skipped) return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    console.error("Stock push failed:", err);
    res.status(502).json({ error: "Stock push failed", detail: err.message });
  }
});

// Daily WhatsApp digest to the owner. Manual trigger...
app.post("/alerts/digest", requireAuth, requireResourceAccess("finance"), async (req, res) => {
  try {
    const result = await sendDailyDigest();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Digest failed", detail: err.message });
  }
});

// ...and the scheduled one. Railway Cron Job:
//   GET https://<backend>/alerts/digest/cron?secret=<ALERTS_CRON_SECRET>
// with schedule "0 4 * * *" (9am PKT, since Railway cron runs in UTC).
app.get("/alerts/digest/cron", async (req, res) => {
  if (!process.env.ALERTS_CRON_SECRET || req.query.secret !== process.env.ALERTS_CRON_SECRET) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }
  try {
    const result = await sendDailyDigest();
    console.log("Daily digest:", JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error("Digest cron failed:", err);
    res.status(502).json({ error: "Digest failed", detail: err.message });
  }
});

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
  const server = app.listen(PORT, () => {
    console.log(`Munshi backend listening on port ${PORT}`);
  });

  // A request that hangs longer than this is never coming back; freeing
  // the socket stops slow requests piling up until the container dies.
  server.requestTimeout = 60000;
  server.headersTimeout = 65000;
  // Must exceed the platform proxy's idle timeout, or the proxy hands a
  // connection to a socket Node has already closed and the user sees a
  // random 502.
  server.keepAliveTimeout = 72000;

  // ---------- Last-resort safety net ----------
  // With the pool listener and the async-route patch in place these should
  // stay quiet. If one does fire, the reason is logged with a stack rather
  // than the process vanishing and leaving nothing in the logs.
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection] server staying up:", reason instanceof Error ? reason.stack : reason);
  });

  process.on("uncaughtException", (err) => {
    // Unlike a rejection, an uncaught throw leaves state unknown. Log it,
    // stop taking new requests, let the platform start a clean container.
    console.error("[uncaughtException] shutting down cleanly:", err.stack || err);
    server.close(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
  });

  // Railway sends SIGTERM on every redeploy. Finishing in-flight requests
  // before exiting is the difference between a clean deploy and a handful
  // of failed saves each time.
  const shutdown = (signal) => {
    console.log(`[${signal}] draining requests before exit...`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
