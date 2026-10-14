// =====================================================================
// Agent API  —  /api/agent/*
//
// A separate, narrow door for the owner's personal AI agent.
//
//   * Auth: one secret key in the AGENT_API_KEY environment variable
//     (Authorization: Bearer <key>). Not a user login, not the JWT.
//     Remove the variable and the whole API switches off.
//   * Reading is always allowed once the key is set.
//   * Writing is OFF unless AGENT_API_WRITE=1 is also set.
//   * Every write needs an Idempotency-Key header. The same key sent
//     twice never creates a second entry — the first answer is replayed.
//   * No edit / delete endpoints exist, on purpose.
//   * Every write is recorded in audit_log as "AI Agent".
//
// Writes follow exactly what the Munshi screens do: a sale lowers stock,
// adds paid money to the chosen account and pushes stock to the website;
// a payment raises amount_paid and the account balance; an expense lowers
// the account balance.
// =====================================================================
const crypto = require("crypto");
const express = require("express");
const pool = require("../db/pool");
const { logChanges, logCreate } = require("../utils/auditLog");

let pushStockSafe = () => {};
try { ({ pushStockSafe } = require("../services/woocommerce")); }
catch (err) { console.error("[agent] services/woocommerce missing — website stock push disabled"); }

const router = express.Router();
const AGENT_USER = { name: "AI Agent", email: "agent-api" };

// The API description holds no data and no secrets, so it is public.
router.get("/openapi.json", (req, res) => res.json(require("./agent.openapi.json")));

// ---------------------------------------------------------------
// Auth + rate limit
// ---------------------------------------------------------------
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.use((req, res, next) => {
  const key = process.env.AGENT_API_KEY;
  if (!key || key.length < 24) {
    return res.status(503).json({ error: "Agent API band hai (AGENT_API_KEY set nahi, ya 24 characters se chhoti hai)." });
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, key)) return res.status(401).json({ error: "Invalid agent key" });
  next();
});

const hits = [];
router.use((req, res, next) => {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60000) hits.shift();
  if (hits.length >= 60) {
    res.set("Retry-After", "10");
    return res.status(429).json({ error: "Bahut zyada requests (60 per minute). Thori der baad dobara." });
  }
  hits.push(now);
  next();
});

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new ApiError(400, msg);
const num = (v) => (v === undefined || v === null || v === "" ? NaN : Number(v));
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const text = (v, max = 200) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
const limitOf = (v, def = 100) => Math.min(Math.max(parseInt(v, 10) || def, 1), 500);

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
      console.error("[agent] error:", err);
      res.status(500).json({ error: "Agent API error", detail: err.message });
    }
  };
}

// ---------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(
      `CREATE TABLE IF NOT EXISTS agent_idempotency (
         key TEXT PRIMARY KEY,
         endpoint TEXT NOT NULL,
         request_hash TEXT NOT NULL,
         response JSONB,
         status INT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    ).catch((err) => { tableReady = null; throw err; });
  }
  return tableReady;
}

function writesEnabled(req, res, next) {
  if (process.env.AGENT_API_WRITE !== "1") {
    return res.status(403).json({ error: "Agent API abhi sirf parhne ke liye hai. Likhne ke liye AGENT_API_WRITE=1 set karein." });
  }
  const k = req.headers["idempotency-key"];
  if (!k || String(k).length < 8 || String(k).length > 100) {
    return res.status(400).json({ error: "Idempotency-Key header lazmi hai (8 se 100 characters)." });
  }
  next();
}

// Runs `work(client)` in ONE transaction together with the idempotency
// record. Same key again -> the stored answer is returned and nothing new
// is written. Same key with a different body -> 422.
function writeEndpoint(name, work) {
  return [
    writesEnabled,
    wrap(async (req, res) => {
      await ensureTable();
      const key = String(req.headers["idempotency-key"]);
      const hash = crypto.createHash("sha256").update(name + JSON.stringify(req.body || {})).digest("hex");

      const client = await pool.connect();
      let after = null;
      try {
        await client.query("BEGIN");
        const ins = await client.query(
          `INSERT INTO agent_idempotency (key, endpoint, request_hash) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO NOTHING RETURNING key`,
          [key, name, hash]
        );
        if (ins.rowCount === 0) {
          const { rows } = await client.query("SELECT * FROM agent_idempotency WHERE key = $1", [key]);
          await client.query("ROLLBACK");
          const prev = rows[0];
          if (!prev || prev.request_hash !== hash) {
            return res.status(422).json({ error: "Ye Idempotency-Key pehle kisi aur request ke liye istemal ho chuki hai." });
          }
          res.set("Idempotent-Replay", "true");
          return res.status(prev.status || 200).json(prev.response || { ok: true });
        }

        const out = await work(client, req.body || {});
        after = out.after || null;
        await client.query(
          "UPDATE agent_idempotency SET response = $2, status = $3 WHERE key = $1",
          [key, JSON.stringify(out.body), out.status || 201]
        );
        await client.query("COMMIT");
        res.status(out.status || 201).json(out.body);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      if (after) {
        try { await after(); } catch (e) { console.error("[agent] after-write:", e.message); }
      }
    }),
  ];
}

// ---------------------------------------------------------------
// READ endpoints
// ---------------------------------------------------------------
router.get("/ping", (req, res) => {
  res.json({ ok: true, writes: process.env.AGENT_API_WRITE === "1" });
});

router.get("/summary", wrap(async (req, res) => {
  const { rows: [sales] } = await pool.query(
    `SELECT
       COALESCE(SUM(sell) FILTER (WHERE date = (now() AT TIME ZONE 'Asia/Karachi')::date), 0) AS today_sales,
       COUNT(*) FILTER (WHERE date = (now() AT TIME ZONE 'Asia/Karachi')::date)::int AS today_orders,
       COALESCE(SUM(sell - cost) FILTER (WHERE date = (now() AT TIME ZONE 'Asia/Karachi')::date), 0) AS today_gross_profit,
       COALESCE(SUM(sell) FILTER (WHERE date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)), 0) AS month_sales,
       COUNT(*) FILTER (WHERE date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date))::int AS month_orders,
       COALESCE(SUM(sell - cost) FILTER (WHERE date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)), 0) AS month_gross_profit,
       COALESCE(SUM(GREATEST(sell - amount_paid, 0)), 0) AS total_udhaar
     FROM orders WHERE status <> 'Returned'`
  );
  const { rows: [exp] } = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE date = (now() AT TIME ZONE 'Asia/Karachi')::date), 0) AS today_expenses,
            COALESCE(SUM(amount) FILTER (WHERE date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)), 0) AS month_expenses
       FROM expenses`
  );
  const { rows: [bal] } = await pool.query("SELECT COALESCE(SUM(balance), 0) AS total_balance FROM accounts");
  const { rows: [low] } = await pool.query(
    `SELECT COUNT(*)::int AS low_stock_items FROM inventory
      WHERE COALESCE(alert_enabled, false) AND quantity <= reorder`
  );
  const { rows: [pend] } = await pool.query(
    "SELECT COUNT(*)::int AS pending_orders FROM orders WHERE status IN ('Pending', 'Shipped')"
  );
  const n = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  res.json({ as_of: new Date().toISOString(), currency: "PKR", ...n(sales), ...n(exp), ...n(bal), ...n(low), ...n(pend) });
}));

router.get("/accounts", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT id, name, type, balance FROM accounts ORDER BY name");
  res.json(rows.map((r) => ({ ...r, balance: Number(r.balance) })));
}));

router.get("/inventory", wrap(async (req, res) => {
  const where = [];
  const vals = [];
  if (req.query.q) { vals.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(name) LIKE $${vals.length} OR lower(COALESCE(sku,'')) LIKE $${vals.length} OR lower(COALESCE(parent_name,'')) LIKE $${vals.length})`); }
  if (req.query.low === "1" || req.query.low === "true") where.push("quantity <= reorder");
  const { rows } = await pool.query(
    `SELECT id, name, sku, category, quantity, reorder, cost, price, parent_name, size, color,
            wc_product_id, wc_variation_id, COALESCE(alert_enabled,false) AS alert_enabled,
            (quantity <= reorder) AS is_low
       FROM inventory ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY parent_name NULLS LAST, name LIMIT ${limitOf(req.query.limit, 200)}`,
    vals
  );
  res.json(rows.map((r) => ({ ...r, quantity: Number(r.quantity), reorder: Number(r.reorder), cost: Number(r.cost), price: Number(r.price) })));
}));

router.get("/orders", wrap(async (req, res) => {
  const where = [];
  const vals = [];
  const { status, from, to, customer, unpaid } = req.query;
  if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
  if (from) { if (!isDate(from)) throw bad("from: YYYY-MM-DD"); vals.push(from); where.push(`date >= $${vals.length}`); }
  if (to) { if (!isDate(to)) throw bad("to: YYYY-MM-DD"); vals.push(to); where.push(`date <= $${vals.length}`); }
  if (customer) { vals.push(`%${String(customer).toLowerCase()}%`); where.push(`(lower(customer) LIKE $${vals.length} OR phone LIKE $${vals.length})`); }
  if (unpaid === "1" || unpaid === "true") where.push("sell > amount_paid AND status <> 'Returned'");
  const { rows } = await pool.query(
    `SELECT id, order_no, date, customer, phone, city, product, qty, sell, cost, amount_paid,
            GREATEST(sell - amount_paid, 0) AS due, status, method, channel, due_date, source, items
       FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY date DESC, created_at DESC LIMIT ${limitOf(req.query.limit)}`,
    vals
  );
  res.json(rows.map((r) => ({ ...r, qty: Number(r.qty), sell: Number(r.sell), cost: Number(r.cost), amount_paid: Number(r.amount_paid), due: Number(r.due) })));
}));

router.get("/customers", wrap(async (req, res) => {
  const where = ["status <> 'Returned'"];
  const vals = [];
  if (req.query.q) { vals.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(customer) LIKE $${vals.length} OR phone LIKE $${vals.length})`); }
  const having = req.query.owing === "1" || req.query.owing === "true" ? "HAVING SUM(GREATEST(sell - amount_paid, 0)) > 0" : "";
  const { rows } = await pool.query(
    `SELECT customer, MAX(phone) AS phone, MAX(city) AS city,
            COUNT(*)::int AS orders, SUM(sell) AS total_sales,
            SUM(GREATEST(sell - amount_paid, 0)) AS due,
            MIN(due_date) FILTER (WHERE sell > amount_paid) AS oldest_due_date,
            MAX(date) AS last_order
       FROM orders WHERE ${where.join(" AND ")}
      GROUP BY customer ${having}
      ORDER BY due DESC, customer LIMIT ${limitOf(req.query.limit, 200)}`,
    vals
  );
  res.json(rows.map((r) => ({ ...r, total_sales: Number(r.total_sales), due: Number(r.due) })));
}));

router.get("/payments", wrap(async (req, res) => {
  const where = [];
  const vals = [];
  const { from, to, order_id } = req.query;
  if (from) { if (!isDate(from)) throw bad("from: YYYY-MM-DD"); vals.push(from); where.push(`p.date >= $${vals.length}`); }
  if (to) { if (!isDate(to)) throw bad("to: YYYY-MM-DD"); vals.push(to); where.push(`p.date <= $${vals.length}`); }
  if (order_id) { if (!isUuid(order_id)) throw bad("order_id galat hai"); vals.push(order_id); where.push(`p.order_id = $${vals.length}`); }
  const { rows } = await pool.query(
    `SELECT p.id, p.order_id, o.order_no, o.customer, p.amount, p.method, a.name AS account, p.date, p.received_by, p.note
       FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN accounts a ON a.id = p.account_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.date DESC, p.created_at DESC LIMIT ${limitOf(req.query.limit)}`,
    vals
  );
  res.json(rows.map((r) => ({ ...r, amount: Number(r.amount) })));
}));

router.get("/consignments", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.ref_no, c.date, c.status, COALESCE(af.name, c.holder_name) AS holder, c.phone,
            COALESCE(json_agg(json_build_object(
              'name', i.name, 'qty_out', i.qty_out, 'qty_returned', i.qty_returned, 'qty_sold', i.qty_sold,
              'remaining', i.qty_out - i.qty_returned - i.qty_sold, 'unit_price', i.unit_price
            )) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
       FROM consignments c
       LEFT JOIN affiliates af ON af.id = c.affiliate_id
       LEFT JOIN consignment_items i ON i.consignment_id = c.id
      GROUP BY c.id, af.name ORDER BY c.date DESC LIMIT ${limitOf(req.query.limit)}`
  );
  res.json(rows);
}));

// ---------------------------------------------------------------
// WRITE endpoints
// ---------------------------------------------------------------

// POST /sale
// { customer, phone?, city?, items:[{inventory_id, qty, price?}], status,
//   amount_paid?, account_id? (required when amount_paid > 0), method?,
//   due_date?, channel?, note? }
router.post("/sale", ...writeEndpoint("sale", async (client, b) => {
  const customer = text(b.customer, 120);
  if (!customer) throw bad("customer lazmi hai");
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 50) throw bad("items: 1 se 50 lines");
  const status = b.status;
  if (!["Pending", "Shipped", "Delivered"].includes(status)) throw bad("status: Pending / Shipped / Delivered");

  const lines = new Map();
  for (const it of b.items) {
    if (!isUuid(it && it.inventory_id)) throw bad("har item mein sahi inventory_id chahiye");
    it.inventory_id = it.inventory_id.toLowerCase();
    const qty = num(it.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw bad("qty poora number aur 0 se zyada honi chahiye");
    const price = it.price === undefined || it.price === null ? null : num(it.price);
    if (price !== null && (!(price >= 0) || !Number.isFinite(price))) throw bad("price galat hai");
    const prev = lines.get(it.inventory_id);
    if (prev) { prev.qty += qty; if (price !== null && price !== prev.price) throw bad("ek hi item ki do alag qeematein"); }
    else lines.set(it.inventory_id, { id: it.inventory_id, qty, price });
  }

  // Lock in a fixed order so two sales never deadlock each other.
  const ids = [...lines.keys()].sort();
  const { rows: stock } = await client.query(
    "SELECT * FROM inventory WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]
  );
  const byId = new Map(stock.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw bad(`Ye inventory_id maujood nahi: ${missing.join(", ")}`);
  const short = [];
  for (const l of lines.values()) {
    const row = byId.get(l.id);
    if (Number(row.quantity) < l.qty) short.push(`${row.name} (stock ${Number(row.quantity)}, maanga ${l.qty})`);
  }
  if (short.length) throw bad(`Stock kam hai: ${short.join("; ")}`);

  const items = [];
  let sell = 0, cost = 0, totalQty = 0;
  for (const l of lines.values()) {
    const row = byId.get(l.id);
    const price = l.price === null ? Number(row.price) : l.price;
    items.push({ id: row.id, name: row.name, qty: l.qty, price });
    sell += price * l.qty; cost += Number(row.cost || 0) * l.qty; totalQty += l.qty;
  }

  const paid = b.amount_paid === undefined || b.amount_paid === null || b.amount_paid === "" ? 0 : num(b.amount_paid);
  if (!(paid >= 0) || !Number.isFinite(paid)) throw bad("amount_paid galat hai");
  if (paid > sell + 0.01) throw bad(`amount_paid (${paid}) bill (${sell}) se zyada hai`);
  let accountId = null;
  if (paid > 0) {
    if (!isUuid(b.account_id)) throw bad("amount_paid > 0 ho to account_id lazmi hai");
    const { rows } = await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [b.account_id]);
    if (!rows[0]) throw bad("account_id maujood nahi");
    accountId = b.account_id;
  }
  if (paid < sell - 0.01 && b.due_date && !isDate(b.due_date)) throw bad("due_date: YYYY-MM-DD");

  for (const l of lines.values()) {
    await client.query("UPDATE inventory SET quantity = quantity - $1, updated_at = now() WHERE id = $2", [l.qty, l.id]);
  }
  if (accountId) {
    await client.query("UPDATE accounts SET balance = COALESCE(balance, 0) + $1, updated_at = now() WHERE id = $2", [paid, accountId]);
  }

  const orderNo = `AG-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`;
  const summary = items.map((i) => `${i.name} x${i.qty}`).join(", ");
  const { rows: [order] } = await client.query(
    `INSERT INTO orders (order_no, customer, phone, city, product, qty, sell, cost, courier, status,
                         amount_paid, due_date, method, date, billed_by, sold_by, sold_by_type, channel,
                         delivery_charge, items, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'In-store',$9,$10,$11,$12,(now() AT TIME ZONE 'Asia/Karachi')::date,$13,$13,'Staff',$14,0,$15,'manual')
     RETURNING *`,
    [orderNo, customer, text(b.phone, 40), text(b.city, 80), summary, totalQty, sell, cost, status,
     paid, paid < sell - 0.01 ? (b.due_date || null) : null, text(b.method, 40) || "Cash",
     AGENT_USER.name, text(b.channel, 40) || "Other", JSON.stringify(items)]
  );

  const touched = stock.map((r) => ({ ...r, quantity: Number(r.quantity) - lines.get(r.id).qty }));
  return {
    status: 201,
    body: {
      ok: true,
      order: { id: order.id, order_no: order.order_no, customer, items, sell, amount_paid: paid, due: Math.max(sell - paid, 0), status },
      stock_after: touched.map((r) => ({ id: r.id, name: r.name, quantity: r.quantity })),
    },
    after: async () => {
      touched.forEach(pushStockSafe);
      await logCreate({ resource: "orders", recordId: order.id, recordLabel: `${order.order_no} — ${customer}`, row: order, user: AGENT_USER });
    },
  };
}));

// POST /payment  { order_id, amount, account_id, method?, date?, note? }
router.post("/payment", ...writeEndpoint("payment", async (client, b) => {
  if (!isUuid(b.order_id)) throw bad("order_id galat hai");
  const amount = num(b.amount);
  if (!(amount > 0) || !Number.isFinite(amount)) throw bad("amount 0 se zyada hona chahiye");
  if (!isUuid(b.account_id)) throw bad("account_id lazmi hai");
  if (b.date && !isDate(b.date)) throw bad("date: YYYY-MM-DD");

  const { rows: [order] } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [b.order_id]);
  if (!order) throw new ApiError(404, "Order nahi mila");
  if (order.status === "Returned") throw bad("Returned order par payment nahi li ja sakti");
  const { rows: [acct] } = await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [b.account_id]);
  if (!acct) throw bad("account_id maujood nahi");

  const due = Number(order.sell || 0) - Number(order.amount_paid || 0);
  if (amount > due + 0.01) throw bad(`Baqaya sirf ${Math.round(due)} hai`);

  const { rows: [pay] } = await client.query(
    `INSERT INTO payments (order_id, amount, method, account_id, date, received_by, note)
     VALUES ($1, $2, $3, $4, COALESCE($5, (now() AT TIME ZONE 'Asia/Karachi')::date), $6, $7) RETURNING *`,
    [order.id, amount, text(b.method, 40) || order.method || "Cash", b.account_id, b.date || null, AGENT_USER.name, text(b.note, 300)]
  );
  const { rows: [updated] } = await client.query(
    "UPDATE orders SET amount_paid = COALESCE(amount_paid, 0) + $1, updated_at = now() WHERE id = $2 RETURNING *",
    [amount, order.id]
  );
  await client.query("UPDATE accounts SET balance = COALESCE(balance, 0) + $1, updated_at = now() WHERE id = $2", [amount, b.account_id]);

  return {
    status: 201,
    body: { ok: true, payment_id: pay.id, order_no: order.order_no, customer: order.customer, paid_now: amount,
            amount_paid: Number(updated.amount_paid), due_left: Math.max(Number(updated.sell) - Number(updated.amount_paid), 0) },
    after: () => logChanges({
      resource: "orders", recordId: order.id, recordLabel: `${order.order_no} — ${order.customer}`,
      before: order, after: updated, user: AGENT_USER, columns: ["amount_paid"],
    }),
  };
}));

// POST /stock-adjust  { inventory_id, delta (+/-) , reason }
router.post("/stock-adjust", ...writeEndpoint("stock-adjust", async (client, b) => {
  if (!isUuid(b.inventory_id)) throw bad("inventory_id galat hai");
  const delta = num(b.delta);
  if (!Number.isInteger(delta) || delta === 0) throw bad("delta poora number ho, 0 na ho");
  const reason = text(b.reason, 200);
  if (!reason) throw bad("reason lazmi hai");

  const { rows: [before] } = await client.query("SELECT * FROM inventory WHERE id = $1 FOR UPDATE", [b.inventory_id]);
  if (!before) throw new ApiError(404, "Item nahi mila");
  const next = Number(before.quantity) + delta;
  if (next < 0) throw bad(`Stock manfi nahi ho sakta (abhi ${Number(before.quantity)})`);
  const { rows: [after] } = await client.query(
    "UPDATE inventory SET quantity = $1, updated_at = now() WHERE id = $2 RETURNING *", [next, before.id]
  );
  return {
    status: 201,
    body: { ok: true, name: after.name, quantity_before: Number(before.quantity), quantity_after: Number(after.quantity), reason },
    after: async () => {
      pushStockSafe(after);
      await logChanges({ resource: "inventory", recordId: before.id, recordLabel: `${before.name} (${reason})`, before, after, user: AGENT_USER, columns: ["quantity"] });
    },
  };
}));

// POST /inventory-rename  { inventory_id, name?, sku? }
// Sirf naam aur/ya SKU badalta hai. Stock, qeemat, tasveer aur website ka link (wc_product_id) wahi rehte hain.
router.post("/inventory-rename", ...writeEndpoint("inventory-rename", async (client, b) => {
  if (!isUuid(b.inventory_id)) throw bad("inventory_id galat hai");
  const name = b.name === undefined ? undefined : text(b.name, 150);
  const sku = b.sku === undefined ? undefined : text(b.sku, 64);
  if (name === undefined && sku === undefined) throw bad("name ya sku mein se kam az kam ek do");
  if (name === null) throw bad("name khali nahi ho sakta");
  if (sku !== undefined && (sku === null || !/^[A-Za-z0-9._-]+$/.test(sku))) {
    throw bad("sku mein sirf huroof, number, - . _ ho sakte hain (space nahi)");
  }

  const { rows: [before] } = await client.query("SELECT * FROM inventory WHERE id = $1 FOR UPDATE", [b.inventory_id]);
  if (!before) throw new ApiError(404, "Item nahi mila");
  if (sku !== undefined) {
    const { rows: clash } = await client.query(
      "SELECT name FROM inventory WHERE lower(sku) = lower($1) AND id <> $2 LIMIT 1", [sku, before.id]
    );
    if (clash[0]) throw bad(`Ye SKU pehle se kisi aur item (${clash[0].name}) ka hai`);
  }
  const newName = name === undefined ? before.name : name;
  const newSku = sku === undefined ? before.sku : sku;
  if (newName === before.name && newSku === before.sku) throw bad("Kuch badla nahi (naam aur SKU pehle jaise hi hain)");

  const { rows: [after] } = await client.query(
    "UPDATE inventory SET name = $1, sku = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [newName, newSku, before.id]
  );
  return {
    status: 201,
    body: { ok: true, name_before: before.name, name_after: after.name, sku_before: before.sku, sku_after: after.sku },
    after: () => logChanges({
      resource: "inventory", recordId: before.id, recordLabel: `${before.name} (naam/SKU tabdeel)`,
      before, after, user: AGENT_USER, columns: ["name", "sku"],
    }),
  };
}));

// POST /expense  { title, category?, amount, account_id?, date? }
router.post("/expense", ...writeEndpoint("expense", async (client, b) => {
  const title = text(b.title, 150);
  if (!title) throw bad("title lazmi hai");
  const amount = num(b.amount);
  if (!(amount > 0) || !Number.isFinite(amount)) throw bad("amount 0 se zyada hona chahiye");
  if (b.date && !isDate(b.date)) throw bad("date: YYYY-MM-DD");
  let accountId = null;
  if (b.account_id) {
    if (!isUuid(b.account_id)) throw bad("account_id galat hai");
    const { rows } = await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [b.account_id]);
    if (!rows[0]) throw bad("account_id maujood nahi");
    accountId = b.account_id;
  }
  const { rows: [exp] } = await client.query(
    `INSERT INTO expenses (title, category, amount, date, account_id)
     VALUES ($1, $2, $3, COALESCE($4, (now() AT TIME ZONE 'Asia/Karachi')::date), $5) RETURNING *`,
    [title, text(b.category, 60), amount, b.date || null, accountId]
  );
  if (accountId) {
    await client.query("UPDATE accounts SET balance = COALESCE(balance, 0) - $1, updated_at = now() WHERE id = $2", [amount, accountId]);
  }
  return {
    status: 201,
    body: { ok: true, expense_id: exp.id, title, amount, account_id: accountId },
    after: () => logCreate({ resource: "expenses", recordId: exp.id, recordLabel: title, row: exp, user: AGENT_USER }),
  };
}));

// Anything else under /api/agent is a clear 404 (no edit / delete exists).
router.use((req, res) => res.status(404).json({ error: "Agent API mein ye endpoint maujood nahi." }));

module.exports = router;
