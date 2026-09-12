const pool = require("../db/pool");

// Sends a low-stock summary via Twilio (SMS or WhatsApp). Optional feature —
// does nothing until TWILIO_* env vars are set. Uses Twilio's plain REST API
// directly (no twilio npm package) to keep dependencies minimal.
function isConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER &&
    process.env.ALERT_TO_NUMBER
  );
}

async function sendTwilioMessage(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP === "true" ? `whatsapp:${process.env.TWILIO_FROM_NUMBER}` : process.env.TWILIO_FROM_NUMBER;
  const to = process.env.TWILIO_WHATSAPP === "true" ? `whatsapp:${process.env.ALERT_TO_NUMBER}` : process.env.ALERT_TO_NUMBER;

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendLowStockAlert() {
  if (!isConfigured()) return { sent: false, reason: "Twilio not configured" };

  const { rows } = await pool.query(
    "SELECT name, quantity, reorder FROM inventory WHERE quantity <= reorder ORDER BY quantity ASC"
  );
  if (rows.length === 0) return { sent: false, reason: "Nothing low on stock" };

  const lines = rows.slice(0, 15).map((r) => `• ${r.name}: ${r.quantity} left (reorder at ${r.reorder})`);
  const body = `Munshi — Low stock alert (${rows.length} item${rows.length > 1 ? "s" : ""}):\n${lines.join("\n")}`;
  await sendTwilioMessage(body);
  return { sent: true, count: rows.length };
}

module.exports = { sendLowStockAlert, isConfigured };
