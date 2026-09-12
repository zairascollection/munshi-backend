const pool = require("../db/pool");

// --- Status mapping: WooCommerce order status -> Munshi order status ---
// WC statuses: pending, processing, on-hold, completed, cancelled, refunded, failed, trash
function mapStatus(wcStatus) {
  switch (wcStatus) {
    case "processing":
    case "on-hold":
      return "Pending";
    case "completed":
      return "Delivered";
    case "refunded":
    case "cancelled":
      return "Returned";
    default:
      return "Pending";
  }
}

// WooCommerce doesn't have a native "Shipped" concept out of the box —
// stores usually add it via a shipment-tracking plugin or a custom status
// like "wc-shipped". If the store uses one, map it here explicitly:
const CUSTOM_STATUS_OVERRIDES = {
  shipped: "Shipped",
  "wc-shipped": "Shipped",
};

function resolveStatus(wcStatus) {
  return CUSTOM_STATUS_OVERRIDES[wcStatus] || mapStatus(wcStatus);
}

function isPaid(wcOrder) {
  // WooCommerce sets date_paid once payment is captured (works for
  // prepaid methods; COD orders are usually "processing" and unpaid
  // until marked completed/paid on delivery).
  return Boolean(wcOrder.date_paid);
}

function mapWooOrderToMunshi(wcOrder) {
  const lineItemNames = (wcOrder.line_items || []).map((li) => `${li.name} x${li.quantity}`).join(", ");
  const qty = (wcOrder.line_items || []).reduce((s, li) => s + Number(li.quantity || 0), 0);
  const sell = Number(wcOrder.total || 0);
  const billing = wcOrder.billing || {};
  const customer = [billing.first_name, billing.last_name].filter(Boolean).join(" ") || "Unknown";

  return {
    order_no: `WC-${wcOrder.number || wcOrder.id}`,
    customer,
    phone: billing.phone || null,
    city: billing.city || null,
    product: lineItemNames,
    qty: qty || 1,
    sell,
    courier: null, // manual for now, per Phase 1 scope
    tracking: null,
    status: resolveStatus(wcOrder.status),
    amount_paid: isPaid(wcOrder) ? sell : 0,
    due_date: null,
    method: wcOrder.payment_method_title || wcOrder.payment_method || null,
    date: (wcOrder.date_created || "").slice(0, 10) || null,
    source: "woocommerce",
    wc_order_id: wcOrder.id,
    wc_status: wcOrder.status,
    wc_payment_method: wcOrder.payment_method,
  };
}

// Matches each line item to an inventory row by SKU (case/whitespace
// insensitive) and sums cost * quantity. Line items with no SKU, or no
// matching inventory row, contribute 0 — same as before matching existed —
// so partially-stocked orders still get a partial, useful cost figure
// rather than failing outright.
async function computeCostFromLineItems(lineItems) {
  let totalCost = 0;
  let matched = 0;
  for (const li of lineItems || []) {
    const sku = (li.sku || "").trim();
    if (!sku) continue;
    const { rows } = await pool.query(
      "SELECT cost FROM inventory WHERE lower(sku) = lower($1) LIMIT 1",
      [sku]
    );
    if (rows[0]) {
      totalCost += Number(rows[0].cost) * Number(li.quantity || 1);
      matched += 1;
    }
  }
  return { totalCost, matched, total: (lineItems || []).length };
}

// Upsert by wc_order_id. Never overwrites amount_paid/status if the order
// was already hand-edited in Munshi in a way that would look like data
// loss — instead this always trusts WooCommerce as the source of truth
// for orders that originated there. If the store owner wants Munshi edits
// (e.g. marking Shipped by hand) to stick, switch this to a partial update.
async function upsertWooOrder(wcOrder) {
  const mapped = mapWooOrderToMunshi(wcOrder);
  const { totalCost } = await computeCostFromLineItems(wcOrder.line_items);
  const m = { ...mapped, cost: totalCost };
  const columns = Object.keys(m);
  const values = Object.values(m);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const updateSet = columns
    .filter((c) => c !== "wc_order_id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  const { rows } = await pool.query(
    `INSERT INTO orders (${columns.join(", ")}, synced_at)
     VALUES (${placeholders}, now())
     ON CONFLICT (wc_order_id)
     DO UPDATE SET ${updateSet}, synced_at = now(), updated_at = now()
     RETURNING *`,
    values
  );
  return rows[0];
}

// --- REST client, used for the first backfill and as a polling fallback ---
async function fetchWooOrders({ page = 1, perPage = 50, afterISO } = {}) {
  const base = process.env.WC_STORE_URL.replace(/\/$/, "");
  const url = new URL(`${base}/wp-json/wc/v3/orders`);
  url.searchParams.set("consumer_key", process.env.WC_CONSUMER_KEY);
  url.searchParams.set("consumer_secret", process.env.WC_CONSUMER_SECRET);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");
  if (afterISO) url.searchParams.set("after", afterISO);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`WooCommerce API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Pulls recent orders and upserts them. Used for: (a) initial backfill on
// first deploy, (b) a polling fallback if webhooks aren't reachable yet.
async function syncRecentOrders({ days } = {}) {
  const backfillDays = days || Number(process.env.WC_BACKFILL_DAYS || 30);
  const after = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000).toISOString();
  let page = 1;
  let total = 0;
  // WooCommerce returns up to 100 per page; loop until an empty page.
  while (true) {
    const orders = await fetchWooOrders({ page, perPage: 100, afterISO: after });
    if (!orders.length) break;
    for (const o of orders) {
      await upsertWooOrder(o);
      total += 1;
    }
    page += 1;
  }
  return total;
}

// ---------------------------------------------------------------
// Munshi -> WooCommerce stock push (the other half of the sync).
//
// Without this, a POS sale never reduces website stock and the shop
// oversells. Inventory rows already carry wc_product_id / wc_variation_id
// from the order sync, so we just PUT the new quantity back.
// Failures are logged, never thrown: a website hiccup must not stop a
// sale from being recorded in Munshi.
// ---------------------------------------------------------------
function wcConfigured() {
  return Boolean(process.env.WC_STORE_URL && process.env.WC_CONSUMER_KEY && process.env.WC_CONSUMER_SECRET);
}

function wcUrl(path) {
  const base = process.env.WC_STORE_URL.replace(/\/$/, "");
  const url = new URL(`${base}/wp-json/wc/v3/${path}`);
  url.searchParams.set("consumer_key", process.env.WC_CONSUMER_KEY);
  url.searchParams.set("consumer_secret", process.env.WC_CONSUMER_SECRET);
  return url.toString();
}

async function pushStockForRow(row) {
  if (!wcConfigured()) return { skipped: true, reason: "WooCommerce not configured" };
  if (!row || !row.wc_product_id) return { skipped: true, reason: "Item website se linked nahi hai" };

  const qty = Math.max(0, Math.round(Number(row.quantity) || 0));
  const path = row.wc_variation_id
    ? `products/${row.wc_product_id}/variations/${row.wc_variation_id}`
    : `products/${row.wc_product_id}`;

  const res = await fetch(wcUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      manage_stock: true,
      stock_quantity: qty,
      stock_status: qty > 0 ? "instock" : "outofstock",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WooCommerce stock push failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return { ok: true, qty };
}

// Fire-and-forget wrapper used from the inventory routes.
function pushStockSafe(row) {
  pushStockForRow(row).catch((err) => console.error("Stock push:", err.message));
}

// Manual "push all stock to website" button — also useful as a nightly
// reconcile if a single push was ever missed.
async function pushAllStock() {
  if (!wcConfigured()) return { skipped: true, reason: "WooCommerce not configured" };
  const { rows } = await pool.query("SELECT * FROM inventory WHERE wc_product_id IS NOT NULL");
  let pushed = 0;
  const failed = [];
  for (const row of rows) {
    try {
      await pushStockForRow(row);
      pushed += 1;
    } catch (err) {
      failed.push({ name: row.name, error: err.message });
    }
  }
  return { pushed, linked: rows.length, failed };
}

module.exports = { mapWooOrderToMunshi, upsertWooOrder, fetchWooOrders, syncRecentOrders, pushStockForRow, pushStockSafe, pushAllStock, wcConfigured };
