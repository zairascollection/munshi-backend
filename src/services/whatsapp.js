const pool = require("../db/pool");

// ---------------------------------------------------------------
// WhatsApp Cloud API (Meta). Everything here degrades gracefully:
// if the env vars aren't set the app keeps working and just reports
// { skipped: true } — same pattern as the YITH sync.
//
// Required env vars:
//   WHATSAPP_TOKEN          — permanent access token from Meta
//   WHATSAPP_PHONE_ID       — phone number ID (not the phone number)
//   WHATSAPP_VERIFY_TOKEN   — any string you choose, used by the webhook
//   OWNER_WHATSAPP          — owner's number for the daily digest
// ---------------------------------------------------------------

const GRAPH = "https://graph.facebook.com/v20.0";

function configured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

// Pakistani numbers get typed as 03001234567 locally but the API wants
// full international format with no plus sign: 923001234567.
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^\d]/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = `92${p.slice(1)}`;
  if (p.length === 10 && p.startsWith("3")) p = `92${p}`;
  return p.length >= 11 ? p : null;
}

async function logMessage({ orderId, phone, direction, body, status }) {
  try {
    await pool.query(
      `INSERT INTO whatsapp_log (order_id, phone, direction, body, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId || null, phone, direction, body, status || null]
    );
  } catch (err) {
    console.error("whatsapp_log insert failed:", err.message);
  }
}

async function sendText(rawPhone, body, { orderId } = {}) {
  if (!configured()) return { skipped: true, reason: "WhatsApp not configured" };
  const phone = normalizePhone(rawPhone);
  if (!phone) return { skipped: true, reason: "Invalid phone number" };

  const res = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body },
    }),
  });

  const data = await res.json().catch(() => ({}));
  await logMessage({ orderId, phone, direction: "out", body, status: res.ok ? "sent" : "failed" });

  if (!res.ok) {
    const detail = data?.error?.message || `HTTP ${res.status}`;
    // 24-hour window errors are the usual cause outside an active chat —
    // surface it plainly instead of failing silently.
    throw new Error(detail);
  }
  return { ok: true, id: data?.messages?.[0]?.id };
}

// ---------------------------------------------------------------
// Order confirmation — the single biggest lever on COD return rate.
// Send before dispatch; only ship the ones that reply.
// ---------------------------------------------------------------
function confirmationText(order) {
  const items = order.product || "your order";
  const amount = Math.round(Number(order.sell) || 0).toLocaleString("en-PK");
  return [
    `Assalam-o-Alaikum ${order.customer || ""}`.trim() + ",",
    "",
    `Zaira's Collection se aap ka order ${order.order_no} confirm karna hai:`,
    `${items}`,
    `Amount: Rs ${amount} (${order.method || "COD"})`,
    order.city ? `Delivery: ${order.city}` : null,
    "",
    'Order confirm hai to "HAAN" likh kar bhejein.',
    'Cancel karna ho to "NAHI" likhein.',
    "",
    "Confirmation ke baad hi parcel dispatch hoga. Shukriya!",
  ].filter(Boolean).join("\n");
}

async function sendOrderConfirmation(orderId) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) throw new Error("Order not found");
  if (!order.phone) throw new Error("Is order par customer ka phone number nahi hai");

  const result = await sendText(order.phone, confirmationText(order), { orderId });
  if (result.skipped) return result;

  await pool.query(
    `UPDATE orders SET confirmation_status = 'Sent', confirmation_sent_at = now(), updated_at = now()
     WHERE id = $1`,
    [orderId]
  );
  return result;
}

// Called by the webhook when the customer replies. Anything that looks
// like a yes confirms the order; anything like a no cancels it.
async function handleIncomingReply(rawPhone, text) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ignored: true };

  await logMessage({ phone, direction: "in", body: text });

  const t = String(text || "").trim().toLowerCase();
  const yes = ["haan", "han", "hn", "yes", "y", "ji", "jee", "ok", "okay", "confirm", "confirmed", "ha"];
  const no = ["nahi", "nai", "no", "n", "cancel", "cancelled", "nhi"];

  let decision = null;
  if (yes.some((w) => t === w || t.startsWith(`${w} `))) decision = "Confirmed";
  else if (no.some((w) => t === w || t.startsWith(`${w} `))) decision = "Cancelled";
  if (!decision) return { logged: true, decision: null };

  // Match on the last 10 digits so 923001234567 finds an order saved as
  // 0300-1234567 or 03001234567.
  const tail = phone.slice(-10);
  const { rows } = await pool.query(
    `SELECT id FROM orders
      WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE $1
        AND confirmation_status IN ('Sent', 'Not sent')
        AND status = 'Pending'
      ORDER BY created_at DESC LIMIT 1`,
    [`%${tail}`]
  );
  if (!rows[0]) return { logged: true, decision, matched: false };

  if (decision === "Confirmed") {
    await pool.query(
      "UPDATE orders SET confirmation_status = 'Confirmed', confirmed_at = now(), updated_at = now() WHERE id = $1",
      [rows[0].id]
    );
  } else {
    await pool.query(
      "UPDATE orders SET confirmation_status = 'Cancelled', updated_at = now() WHERE id = $1",
      [rows[0].id]
    );
  }
  return { logged: true, decision, matched: true, orderId: rows[0].id };
}

// ---------------------------------------------------------------
// Daily digest to the owner — yesterday in one message.
// ---------------------------------------------------------------
async function sendDailyDigest() {
  if (!configured()) return { skipped: true, reason: "WhatsApp not configured" };
  const to = process.env.OWNER_WHATSAPP;
  if (!to) return { skipped: true, reason: "OWNER_WHATSAPP not set" };

  const { rows: setting } = await pool.query("SELECT value FROM settings WHERE key = 'digest_enabled'");
  if (setting[0] && setting[0].value === "0") return { skipped: true, reason: "Digest turned off" };

  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

  const { rows: sales } = await pool.query(
    `SELECT COUNT(*)::int AS orders,
            COALESCE(SUM(CASE WHEN status <> 'Returned' THEN sell ELSE 0 END),0) AS revenue,
            COALESCE(SUM(CASE WHEN status <> 'Returned' THEN cost ELSE 0 END),0) AS cost,
            COUNT(*) FILTER (WHERE status = 'Returned')::int AS returned
       FROM orders WHERE date = $1`,
    [yesterday]
  );
  const { rows: pending } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM orders WHERE status IN ('Pending','Shipped')"
  );
  const { rows: unconfirmed } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM orders WHERE status = 'Pending' AND confirmation_status <> 'Confirmed'"
  );
  const { rows: low } = await pool.query(
    "SELECT name, quantity FROM inventory WHERE quantity <= reorder AND alert_enabled = true ORDER BY quantity ASC LIMIT 5"
  );
  const { rows: due } = await pool.query(
    "SELECT COALESCE(SUM(GREATEST(sell - amount_paid, 0)),0) AS total FROM orders WHERE status <> 'Returned'"
  );

  const s = sales[0];
  const rs = (v) => `Rs ${Math.round(Number(v) || 0).toLocaleString("en-PK")}`;

  const body = [
    `*Munshi — ${yesterday}*`,
    "",
    `Orders: ${s.orders}${s.returned ? ` (${s.returned} return)` : ""}`,
    `Sale: ${rs(s.revenue)}`,
    `Gross profit: ${rs(Number(s.revenue) - Number(s.cost))}`,
    "",
    `Parcels chal rahe hain: ${pending[0].c}`,
    `Confirmation pending: ${unconfirmed[0].c}`,
    `Customers se lena hai: ${rs(due[0].total)}`,
    low.length ? "" : null,
    low.length ? `*Stock khatam ho raha hai:*` : null,
    ...low.map((i) => `• ${i.name} — ${Math.round(Number(i.quantity))}`),
  ].filter((x) => x !== null).join("\n");

  return sendText(to, body);
}

module.exports = {
  configured,
  normalizePhone,
  sendText,
  sendOrderConfirmation,
  handleIncomingReply,
  sendDailyDigest,
  confirmationText,
};
