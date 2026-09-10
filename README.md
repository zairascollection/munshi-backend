# Munshi Frontend

The same Munshi UI you already had, now wired to the `munshi-backend` API
instead of `window.storage`. Every panel (Inventory, Orders, Employees,
Affiliates, Accounts, Expenses, POS, Reports, Finance) looks and behaves
exactly as before — the only things that changed are:

1. **Login screen** (`Login.jsx`) gates the app; the old Owner/Staff toggle
   in the sidebar is gone, replaced by the real logged-in user's name and role.
2. **`api.js`** replaces `window.storage.get/set` — on login it fetches every
   resource from the backend, and every add/edit/delete you make in the UI
   is pushed to the API in the background (see the `update`/`reconcile`
   functions near the top of `App.jsx`).
3. A **"Sync WooCommerce"** button in the sidebar (owner only) triggers
   `POST /sync/woocommerce` on the backend as a manual fallback alongside
   the real-time webhook sync.

## Setup

```
npm install
cp .env.example .env   # point VITE_API_BASE_URL at your deployed backend
npm run dev
```

Log in with the owner account you created via `node src/db/createOwner.js`
in the backend project.

## How data flows now

- On login, the app calls `GET /inventory`, `/orders`, `/employees`, and
  (owner only) `/affiliates`, `/accounts`, `/expenses`, and fills the same
  `data` state shape the UI already expected.
- Every UI action that used to call `update(key, fn)` to mutate local state
  still does — `update` now also diffs the before/after list and fires the
  matching `POST`/`PUT`/`DELETE` call per changed row. No changes were
  needed inside Inventory/Orders/Employees/Affiliates/Accounts/Expenses/POS
  themselves.
- New rows get a temporary client-side id (same `genId()` as before) that's
  swapped for the server's real id once the create request resolves.
- If a request fails (network issue, permission error), a toast shows the
  error and the local optimistic change is left in place — refreshing the
  page will re-sync from the server as the source of truth.

## Known trade-offs to revisit later

- Optimistic updates mean if two people edit the same record at once, the
  last write wins — fine for a small team, worth adding conflict handling
  for if the staff list grows.
- `Login.jsx` stores the JWT in `localStorage`. That's fine for a normal
  hosted web app (this is no longer running inside a Claude.ai artifact
  sandbox), but swap it for httpOnly cookies if you want XSS-resistant
  token storage later.
- Deleting a record removes it from the backend immediately — there's no
  "undo" beyond re-adding it by hand, matching the original prototype's behavior.
