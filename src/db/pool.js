const { Pool } = require("pg");

// ---------------------------------------------------------------
// Postgres connection pool.
//
// The settings below matter more than they look. Railway restarts its
// Postgres service for maintenance, and idle TCP connections get dropped
// by the network anyway. When that happens node-postgres emits an 'error'
// event on the idle client — and an EventEmitter 'error' with no listener
// does not warn, it THROWS and kills the whole process. That is the
// classic "it crashed again overnight and I had to restart it".
// ---------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,

  // Railway's Postgres plans allow a limited number of connections and the
  // pg default of 10 plus a redeploy overlapping the old container can trip
  // "too many clients". Eight is plenty for this app's traffic.
  max: Number(process.env.PG_POOL_MAX) || 8,

  // Drop connections that have been idle for half a minute rather than
  // holding them open until something else severs them.
  idleTimeoutMillis: 30000,

  // Fail fast when the database is unreachable instead of hanging the
  // request until the platform's own timeout kills the container.
  connectionTimeoutMillis: 10000,

  // TCP keepalive stops middleboxes silently dropping a quiet connection.
  keepAlive: true,
});

// THE important line. Without this listener, a dropped idle connection
// takes the whole server down. With it, the bad client is discarded and
// the pool quietly opens a fresh one on the next query.
pool.on("error", (err) => {
  console.error("[pg] idle client error (connection dropped, pool will recover):", err.message);
});

pool.on("connect", () => {
  if (process.env.PG_DEBUG === "true") console.log("[pg] new client connected");
});

// Used by /health so the platform's health check tests the database, not
// just whether Node is still answering.
pool.isHealthy = async function isHealthy() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    console.error("[pg] health check failed:", err.message);
    return false;
  }
};

module.exports = pool;
