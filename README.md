# Munshi Backend

Node/Express + PostgreSQL backend for the Munshi app (Zaira's Collection),
implementing Phase 1 of the project brief: real database, real auth, and
automatic WooCommerce order sync via webhooks.

## What's here

```
src/
  server.js              Express app + route mounting
  db/
    schema.sql           Full Postgres schema (tables match munshi.jsx's data model)
    migrate.js            Runs schema.sql against DATABASE_URL
    createOwner.js        One-time script to create the first login
    pool.js               pg connection pool
  middleware/auth.js       JWT auth + owner/staff permission guards
  routes/
    auth.js                POST /auth/login, GET /auth/me, POST /auth/users (owner only)
    orders.js               Orders CRUD (manual/POS orders + read access to synced WC orders)
    resources.js            Inventory, employees, affiliates, accounts, expenses CRUD
    finance.js               GET /finance/summary, GET /finance/ledger (owner only)
    webhooks.js              POST /webhooks/woocommerce — receives WC order.created/updated
  services/woocommerce.js    WC status/field mapping, upsert-by-wc_order_id, REST client, backfill
  utils/
    permissions.js           Owner-only resource list + field scrubbing for staff
    crudRouter.js            Generic CRUD route factory used by resources.js
```

## 1. Set up the database

1. Create a Postgres database (Railway, Supabase, and Render all have a free/cheap tier).
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL`.
3. Run the migration:
   ```
   npm install
   npm run migrate
   ```
4. Create the first owner login:
   ```
   node src/db/createOwner.js "Zaira" owner@zairascollection.com "a-strong-password"
   ```

## 2. Configure WooCommerce

**Generate API keys** (needed for the initial backfill and manual "sync now" button):
WordPress Admin → WooCommerce → Settings → Advanced → REST API → Add key → **Read/Write**.
Put the key/secret in `.env` as `WC_CONSUMER_KEY` / `WC_CONSUMER_SECRET`.

**Set up the webhook** (needed for real-time sync, since that's what you chose):
WordPress Admin → WooCommerce → Settings → Advanced → Webhooks → Add webhook.
- Topic: `Order created` — Delivery URL: `https://<your-api-domain>/webhooks/woocommerce`
- Add a second webhook with Topic: `Order updated` — same delivery URL
- Secret: generate a random string, put it in both the WooCommerce webhook config
  and your `.env` as `WC_WEBHOOK_SECRET` — this is what lets the server verify a
  request genuinely came from WooCommerce and not someone else hitting the URL.
- **Webhooks require your API to be publicly reachable over HTTPS.** Until it's
  deployed somewhere public (Railway/Render both give you an HTTPS URL for free),
  WooCommerce can't deliver the webhook. Deploy the backend first, then add the
  webhook pointing at the live URL.

Because webhooks can occasionally be missed (a deploy restart, a delivery
failure), there's also a manual fallback: `POST /sync/woocommerce` (owner-only,
JWT required) pulls the last N days of orders and upserts them the same way the
webhook does — safe to call any time, including from a "Sync now" button in the UI.

## 3. Run it

```
npm run dev      # local dev, auto-reload
npm start        # production
```

Deploy to Railway/Render by pointing them at this repo; set the same env vars
from `.env` in their dashboard, run `npm run migrate` once via their shell/CLI,
then create the owner login the same way.

## API overview

All routes except `/health`, `/auth/login`, and `/webhooks/*` require
`Authorization: Bearer <token>` from `/auth/login`.

| Method/Path | Notes |
|---|---|
| `POST /auth/login` | `{ email, password }` → `{ token, user }` |
| `GET /auth/me` | current user |
| `POST /auth/users` | owner only — create a staff/owner login |
| `GET/POST/PUT/DELETE /inventory[/:id]` | staff can read/write, cost hidden from staff on read |
| `GET/POST/PUT/DELETE /orders[/:id]` | staff can read/write manual orders; cost hidden from staff |
| `GET/POST/PUT/DELETE /employees[/:id]` | staff can read/write, salary hidden from staff on read |
| `GET/POST/PUT/DELETE /affiliates[/:id]` | **owner only** |
| `GET/POST/PUT/DELETE /accounts[/:id]` | **owner only** |
| `GET/POST/PUT/DELETE /expenses[/:id]` | **owner only** |
| `GET /finance/summary` | **owner only** — P&L, receivables/payables |
| `GET /finance/ledger` | **owner only** — customer khata |
| `POST /sync/woocommerce` | **owner only** — manual backfill/re-sync, `{ days?: number }` |
| `POST /webhooks/woocommerce` | called by WooCommerce, verified via HMAC signature |

Delete is blocked for staff on every resource regardless of the table above
(enforced in `middleware/auth.js`), matching the existing UI's permission logic.

## Notes / things left for you to decide

- **COGS on WooCommerce orders is 0 by default** — WooCommerce has no cost field,
  so synced orders come in with `cost: 0` until you either (a) match line items
  against `inventory.cost` by `wc_product_id`/SKU and compute it server-side, or
  (b) fill it in manually per order. The `inventory` table already has
  `wc_product_id`/`wc_variation_id` columns ready for that matching once you want it.
- **"Shipped" status**: WooCommerce has no built-in "Shipped" order status. If your
  store doesn't use a shipment-tracking plugin that adds one, synced orders will
  land as Pending until marked Delivered/Returned, and you'll update to "Shipped"
  manually once a courier is assigned — same manual flow as today, just one field.
- **Courier/tracking fields** are nullable and untouched by sync, exactly as scoped —
  ready to wire to a real courier API in Phase 2 without a schema change.
- **Frontend rewiring** (swapping `window.storage` calls in `munshi.jsx` for fetch
  calls to these endpoints, plus a login screen) is the next piece — this backend
  is designed so those changes are mostly mechanical: the JSON shape returned
  matches the existing state shape closely (snake_case columns instead of
  camelCase being the main difference to account for).
