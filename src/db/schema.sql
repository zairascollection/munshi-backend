-- Munshi database schema
-- Mirrors the data model already used in munshi.jsx so the frontend
-- needs minimal changes when it's rewired from window.storage to this API.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Auth ----------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'manager')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Accounts ----------
-- Created early: employees/affiliates/expenses reference it.
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT, -- Cash / Bank / JazzCash / EasyPaisa
  balance NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Inventory ----------
CREATE TABLE IF NOT EXISTS inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sku TEXT UNIQUE,
  category TEXT,
  quantity NUMERIC NOT NULL DEFAULT 0,
  reorder NUMERIC NOT NULL DEFAULT 0,
  cost NUMERIC NOT NULL DEFAULT 0,
  price NUMERIC NOT NULL DEFAULT 0,
  image TEXT,
  -- links inventory rows to WooCommerce products so future stock-sync
  -- (WC -> Munshi or Munshi -> WC) can match by product/variation id
  wc_product_id BIGINT,
  wc_variation_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Orders & parcels ----------
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT NOT NULL,
  customer TEXT NOT NULL,
  phone TEXT,
  product TEXT,
  qty NUMERIC NOT NULL DEFAULT 1,
  sell NUMERIC NOT NULL DEFAULT 0,
  cost NUMERIC NOT NULL DEFAULT 0,
  -- Courier fields are manual for now (Phase 2 wires a real courier API).
  -- Left nullable/free-text on purpose so no schema change is needed later.
  courier TEXT,
  tracking TEXT,
  status TEXT NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Shipped', 'Delivered', 'Returned')),
  amount_paid NUMERIC NOT NULL DEFAULT 0,
  due_date DATE,
  method TEXT, -- COD / JazzCash / EasyPaisa / Bank Transfer
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  billed_by TEXT,       -- name of the staff/owner who generated the bill (POS orders)
  return_reason TEXT,   -- why an order was marked Returned (size, quality, changed mind, etc.)
  city TEXT,            -- delivery city, for city-wise performance/return-rate analysis

  -- WooCommerce sync bookkeeping
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'woocommerce')),
  wc_order_id BIGINT UNIQUE, -- null for manually-entered/POS orders
  wc_status TEXT,             -- raw WooCommerce status, kept for reference
  wc_payment_method TEXT,
  synced_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_wc_order_id ON orders (wc_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders (date);

-- ---------- Employees ----------
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  role TEXT,
  salary NUMERIC NOT NULL DEFAULT 0,
  phone TEXT,
  joined DATE,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Paid', 'Pending')),
  account_id UUID REFERENCES accounts(id),
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Affiliates ----------
CREATE TABLE IF NOT EXISTS affiliates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  platform TEXT,
  rate NUMERIC NOT NULL DEFAULT 0,     -- commission %
  sales NUMERIC NOT NULL DEFAULT 0,
  commission NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  payment TEXT NOT NULL DEFAULT 'Pending' CHECK (payment IN ('Paid', 'Pending')),
  account_id UUID REFERENCES accounts(id),
  wc_affiliate_id BIGINT UNIQUE, -- null for manually-entered affiliates; set for ones synced from YITH
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Expenses ----------
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  account_id UUID REFERENCES accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Webhook event log ----------
-- Prevents double-processing if WooCommerce retries a webhook delivery.
CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wc_order_id BIGINT NOT NULL,
  topic TEXT NOT NULL,
  delivery_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wc_order_id, delivery_id)
);

-- ---------- Safety net for columns added after the first migration ----------
-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
-- these ALTERs make sure a database migrated before a given feature was
-- added still picks up the new column on the next migration run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE employees ADD COLUMN IF NOT EXISTS image TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billed_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS city TEXT;

-- Widen the users.role check to allow 'manager' on databases created
-- before this role existed. Constraint name matches Postgres's default
-- auto-generated name for an inline CHECK on this column.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'staff', 'manager'));

-- ---------- Audit log ----------
-- Field-level change history, mainly so the owner can see who edited
-- inventory cost (now editable by everyone) and when.
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource TEXT NOT NULL,
  record_id UUID NOT NULL,
  record_label TEXT,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log (resource, changed_at DESC);


-- =====================================================================
-- v2 — Returns, COD cost tracking, ad spend, settings, monthly snapshots
-- (Financify-style profit tracking). All additive & idempotent.
-- =====================================================================

-- ---------- Orders: COD / return economics ----------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel TEXT;              -- Website / POS / Instagram / WhatsApp / Other
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_charge NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_charge NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS returned_at DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at DATE;

CREATE INDEX IF NOT EXISTS idx_orders_city ON orders (city);
CREATE INDEX IF NOT EXISTS idx_orders_billed_by ON orders (billed_by);

-- ---------- Ad / marketing spend ----------
-- Financify syncs this from Meta/Google APIs. Here it's manual entry
-- (one row per channel per day) — same maths, no API keys needed.
CREATE TABLE IF NOT EXISTS ad_spend (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  channel TEXT NOT NULL,          -- Facebook / Instagram / Google / TikTok / Other
  campaign TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_spend_date ON ad_spend (date);

-- ---------- App settings (single row, key/value) ----------
-- Default COD charges, tax rate, cash-handling %. Used to auto-fill new
-- orders and to compute true profit in the analytics endpoints.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('default_delivery_charge', '250'),
  ('default_return_charge', '150'),
  ('cash_handling_pct', '1'),
  ('tax_pct', '0'),
  ('packaging_cost', '50')
ON CONFLICT (key) DO NOTHING;

-- ---------- Auto month-end analysis snapshots ----------
-- Written by the month-end cron so the owner has a frozen record of each
-- month even after orders are later edited.
CREATE TABLE IF NOT EXISTS monthly_reports (
  month TEXT PRIMARY KEY,            -- 'YYYY-MM'
  data JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- v3 — Variants, suppliers & purchases, customer ledger,
--      WhatsApp order confirmation. All additive & idempotent.
-- =====================================================================

-- ---------- Inventory variants ----------
-- Each size/colour stays its own row (its own SKU, stock, cost and price)
-- but rows are grouped in the UI by parent_name. Existing rows have NULLs
-- here and keep behaving exactly as before.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS parent_name TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS size TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS supplier_id UUID;
CREATE INDEX IF NOT EXISTS idx_inventory_parent ON inventory (parent_name);

-- ---------- Suppliers ----------
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  city TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Purchase orders ----------
-- Receiving a PO is what actually raises stock and sets the real cost,
-- so cost stops being a number somebody types from memory.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no TEXT NOT NULL,
  supplier_id UUID REFERENCES suppliers(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Ordered', 'Received', 'Cancelled')),
  total NUMERIC NOT NULL DEFAULT 0,
  amount_paid NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  received_at DATE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_id UUID REFERENCES inventory(id),
  name TEXT NOT NULL,
  sku TEXT,
  qty NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items (po_id);

-- ---------- Customer ledger ----------
-- Order rows already hold every sale; this table only holds the things
-- that are ABOUT the customer rather than about one order — notes, and
-- whether they're blocked from COD after repeated refusals.
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  city TEXT,
  notes TEXT,
  cod_blocked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- WhatsApp order confirmation ----------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_status TEXT NOT NULL DEFAULT 'Not sent';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS po_id UUID;

CREATE TABLE IF NOT EXISTS whatsapp_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  body TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_log_order ON whatsapp_log (order_id);

INSERT INTO settings (key, value) VALUES
  ('whatsapp_enabled', '0'),
  ('digest_enabled', '1'),
  ('cod_block_after_returns', '2')
ON CONFLICT (key) DO NOTHING;

-- ---------- Per-item low-stock alert opt-in ----------
-- Default false: a shop with one-off pieces would otherwise get an alert
-- for every single item. The owner turns it on for the lines they restock.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS alert_enabled BOOLEAN NOT NULL DEFAULT false;

-- Older clients may not send these yet; a NULL is harmless (JS reads it as
-- falsy / 0) whereas a NOT NULL violation breaks the whole save.
ALTER TABLE inventory ALTER COLUMN alert_enabled DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN delivery_charge DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN return_charge DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN refund_amount DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN restocked DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN confirmation_status DROP NOT NULL;

-- =====================================================================
-- v4 — Order payments (udhaar clearing) + return reversal
-- =====================================================================

-- Every instalment against an order gets its own row, so a bill paid in
-- three parts has three records instead of one number quietly changing.
-- orders.amount_paid stays as the running total, kept in sync here.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  method TEXT,
  account_id UUID REFERENCES accounts(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  received_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments (date);

-- =====================================================================
-- v5 — Affiliate consignment stock + who the sale came through
-- =====================================================================

-- Stock handed to an affiliate (or anyone) to sell on our behalf. The
-- goods have left the shop but are still ours until they sell, so the
-- inventory count drops and this table records who is holding what.
CREATE TABLE IF NOT EXISTS consignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no TEXT,
  affiliate_id UUID REFERENCES affiliates(id),
  holder_name TEXT,                  -- used when the holder isn't a listed affiliate
  phone TEXT,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'Out' CHECK (status IN ('Out', 'Partial', 'Settled')),
  notes TEXT,
  given_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consignments_affiliate ON consignments (affiliate_id);

-- qty_out is what went out; sold + returned is what came back one way or
-- the other. Whatever is left is still sitting with the holder.
CREATE TABLE IF NOT EXISTS consignment_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_id UUID NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  inventory_id UUID REFERENCES inventory(id),
  name TEXT NOT NULL,
  sku TEXT,
  qty_out NUMERIC NOT NULL DEFAULT 0,
  qty_returned NUMERIC NOT NULL DEFAULT 0,
  qty_sold NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  unit_price NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_consignment_items_parent ON consignment_items (consignment_id);

-- billed_by is whoever typed the bill into Munshi. sold_by is the person
-- or affiliate the sale actually came through — that's what matters when
-- a customer rings up with a complaint weeks later.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sold_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sold_by_type TEXT;   -- Staff / Affiliate / Walk-in / Online
ALTER TABLE orders ADD COLUMN IF NOT EXISTS consignment_id UUID;
CREATE INDEX IF NOT EXISTS idx_orders_sold_by ON orders (sold_by);

-- The exact items a bill was made of.
--
-- Orders only ever stored a summary string ("3PC x1, 2pc x1"). This shop
-- reuses the same names across many different products, so matching that
-- string back to stock put the same photo on dozens of unrelated bills.
-- New bills record the inventory ids outright, which removes the guess.
-- [{ id, name, qty, price }]
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB;
