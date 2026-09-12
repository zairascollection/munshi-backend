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


