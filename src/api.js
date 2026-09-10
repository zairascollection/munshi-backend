// Talks to the munshi-backend API. Replaces the old window.storage calls.
//
// Set VITE_API_BASE_URL in your .env (e.g. https://api.zairascollection.com)
// when building with Vite. If you're using a different bundler, swap the
// `BASE_URL` line below for however your tooling exposes env vars.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

const TOKEN_KEY = "munshi_token";

// Token is kept in localStorage. This file only ever runs as part of the
// real hosted app (not inside a Claude.ai artifact preview), so normal
// browser storage is fine here — unlike an artifact, this won't be
// sandboxed, and a page refresh should keep the user logged in.
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable, fine to no-op */ }
}

async function request(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- Auth ---
export async function login(email, password) {
  return request("/auth/login", { method: "POST", body: { email, password } });
}
export async function me() {
  return request("/auth/me");
}
export async function createUser({ name, email, password, role }) {
  return request("/auth/users", { method: "POST", body: { name, email, password, role } });
}
export async function listUsers() {
  return request("/auth/users");
}
export async function removeUser(id) {
  return request(`/auth/users/${id}`, { method: "DELETE" });
}

// --- Field name mapping between the UI's camelCase and the DB's snake_case ---
// Only fields that actually differ need an entry; everything else passes through.
const FIELD_MAPS = {
  orders: { orderNo: "order_no", amountPaid: "amount_paid", dueDate: "due_date" },
  employees: { paidFrom: "account_id" },
  affiliates: { paidFrom: "account_id" },
  expenses: { accountId: "account_id" },
  inventory: {},
  accounts: {},
};

// Fields that come back from Postgres as strings (NUMERIC) and should be
// coerced to numbers so the UI's arithmetic and formatting work as before.
const NUMERIC_FIELDS = {
  inventory: ["quantity", "reorder", "cost", "price"],
  orders: ["qty", "sell", "cost", "amountPaid"],
  employees: ["salary"],
  affiliates: ["rate", "sales", "commission"],
  accounts: ["balance"],
  expenses: ["amount"],
};

function toApi(resource, obj) {
  const map = FIELD_MAPS[resource] || {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "id") continue; // server assigns/owns the id
    out[map[k] || k] = v === "" ? null : v;
  }
  return out;
}

function fromApi(resource, row) {
  if (!row) return row;
  const map = FIELD_MAPS[resource] || {};
  const reverse = Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[reverse[k] || k] = v;
  }
  // affiliates/employees keep paidFrom populated even when payment is
  // "Pending" so the badge logic in the UI still has something to show;
  // the backend clears account_id on markPending, matching that.
  const numeric = NUMERIC_FIELDS[resource] || [];
  for (const f of numeric) {
    if (out[f] !== undefined && out[f] !== null) out[f] = Number(out[f]);
  }
  return out;
}

// --- Generic resource CRUD ---
export const api = {
  list: (resource) => request(`/${resource}`).then((rows) => rows.map((r) => fromApi(resource, r))),
  create: (resource, item) =>
    request(`/${resource}`, { method: "POST", body: toApi(resource, item) }).then((r) => fromApi(resource, r)),
  update: (resource, id, item) =>
    request(`/${resource}/${id}`, { method: "PUT", body: toApi(resource, item) }).then((r) => fromApi(resource, r)),
  remove: (resource, id) => request(`/${resource}/${id}`, { method: "DELETE" }),
};

// --- Finance (owner only) ---
export async function financeSummary() {
  return request("/finance/summary");
}
export async function financeLedger() {
  return request("/finance/ledger");
}

// --- WooCommerce manual sync trigger (owner only) ---
export async function syncWooCommerce(days) {
  return request("/sync/woocommerce", { method: "POST", body: { days } });
}
