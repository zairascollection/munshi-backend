const express = require("express");
const crypto = require("crypto");
const pool = require("../db/pool");
const { upsertWooOrder } = require("../services/woocommerce");

const router = express.Router();

// IMPORTANT: this route must receive the RAW request body (not JSON-parsed)
// so the HMAC signature can be verified against the exact bytes WooCommerce
// signed. server.js mounts express.raw() for this path — see comments there.
function verifySignature(req) {
  const signature = req.headers["x-wc-webhook-signature"];
  if (!signature || !process.env.WC_WEBHOOK_SECRET) return false;
  const computed = crypto
    .createHmac("sha256", process.env.WC_WEBHOOK_SECRET)
    .update(req.body) // raw Buffer
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
  } catch {
    return false; // length mismatch etc.
  }
}

async function alreadyProcessed(wcOrderId, deliveryId) {
  if (!deliveryId) return false; // can't dedupe without one; fall through to upsert (idempotent anyway)
  const { rows } = await pool.query(
    "SELECT 1 FROM webhook_events WHERE wc_order_id = $1 AND delivery_id = $2",
    [wcOrderId, deliveryId]
  );
  return rows.length > 0;
}

async function recordProcessed(wcOrderId, topic, deliveryId) {
  await pool.query(
    `INSERT INTO webhook_events (wc_order_id, topic, delivery_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [wcOrderId, topic, deliveryId]
  );
}

// POST /webhooks/woocommerce
// Configure ONE webhook in WooCommerce per topic (order.created, order.updated)
// pointing here, e.g. https://your-api-domain.com/webhooks/woocommerce
router.post("/woocommerce", async (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // WooCommerce sends a test ping with no real order id when the webhook
  // is first created — acknowledge it without erroring.
  if (!payload || !payload.id) {
    return res.status(200).json({ ok: true, note: "no order payload (likely a test ping)" });
  }

  const topic = req.headers["x-wc-webhook-topic"] || "unknown";
  const deliveryId = req.headers["x-wc-webhook-delivery-id"];

  if (await alreadyProcessed(payload.id, deliveryId)) {
    return res.status(200).json({ ok: true, deduped: true });
  }

  const order = await upsertWooOrder(payload);
  await recordProcessed(payload.id, topic, deliveryId);

  res.status(200).json({ ok: true, order_id: order.id });
});

module.exports = router;
