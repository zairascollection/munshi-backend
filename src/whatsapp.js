const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const wa = require("../services/whatsapp");

const router = express.Router();

// --- Meta webhook verification (GET) — Meta calls this once when you
// --- save the callback URL in the Meta dashboard. No auth: Meta can't
// --- log in, the shared verify token is the check.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- Incoming messages (POST). Always answer 200 quickly, otherwise
// --- Meta retries and eventually disables the webhook.
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          if (msg.type !== "text") continue;
          const result = await wa.handleIncomingReply(msg.from, msg.text?.body);
          console.log("[whatsapp] reply:", msg.from, msg.text?.body, JSON.stringify(result));
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
  }
});

router.use(requireAuth);

// POST /whatsapp/confirm/:orderId — send the confirmation message
router.post("/confirm/:orderId", async (req, res) => {
  try {
    const result = await wa.sendOrderConfirmation(req.params.orderId);
    if (result.skipped) return res.status(400).json({ error: result.reason });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /whatsapp/confirm-bulk  { ids: [...] } — send to several at once
router.post("/confirm-bulk", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const results = { sent: 0, failed: [] };
  for (const id of ids) {
    try {
      const r = await wa.sendOrderConfirmation(id);
      if (r.skipped) results.failed.push({ id, error: r.reason });
      else results.sent += 1;
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }
  res.json(results);
});

// PUT /whatsapp/status/:orderId  { status } — set confirmation by hand
// (for the calls and replies that happen outside WhatsApp).
router.put("/status/:orderId", async (req, res) => {
  const allowed = ["Not sent", "Sent", "Confirmed", "No response", "Cancelled"];
  const { status } = req.body || {};
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  const { rows } = await pool.query(
    `UPDATE orders SET confirmation_status = $1,
            confirmed_at = CASE WHEN $1 = 'Confirmed' THEN now() ELSE confirmed_at END,
            updated_at = now()
      WHERE id = $2 RETURNING id, confirmation_status`,
    [status, req.params.orderId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

// GET /whatsapp/log/:orderId — the conversation for one order
router.get("/log/:orderId", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM whatsapp_log WHERE order_id = $1 ORDER BY created_at ASC",
    [req.params.orderId]
  );
  res.json(rows);
});

// GET /whatsapp/health — is it wired up at all?
router.get("/health", (req, res) => {
  res.json({
    configured: wa.configured(),
    ownerNumberSet: Boolean(process.env.OWNER_WHATSAPP),
    webhookVerifyTokenSet: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
  });
});

module.exports = router;
