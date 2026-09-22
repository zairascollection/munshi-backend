const express = require("express");
const pool = require("../db/pool");
const buildCrudRouter = require("../utils/crudRouter");
const { pushStockSafe } = require("../services/woocommerce");

const inventoryRouter = buildCrudRouter({
  table: "inventory",
  resource: "inventory",
  columns: [
    "name", "sku", "category", "quantity", "reorder", "cost", "price", "image",
    "wc_product_id", "wc_variation_id",
    // Variant fields — each size/colour is its own row, grouped by parent_name.
    "parent_name", "size", "color", "supplier_id", "alert_enabled",
  ],
  auditLog: true,
  // Strip the base64 photo out of the list and hand back a cacheable URL
  // instead. The row shrinks from ~150 KB to a few hundred bytes.
  transformRow: (row) => {
    if (!row.image) return { ...row, image_url: null };
    const stamp = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    return { ...row, image: null, image_url: `/inventory/${row.id}/image?v=${stamp}` };
  },
  // Any quantity change goes straight back to the website so a POS sale
  // can't leave the shop overselling stock it no longer has.
  afterWrite: (after, before) => {
    if (!before || Number(before.quantity) !== Number(after.quantity)) pushStockSafe(after);
  },
});

// ---------------------------------------------------------------
// Images are stored in the database as base64 data URLs. Returning them
// inside the inventory list means every page load re-downloads roughly a
// megabyte of photos that never change.
//
// Instead the list returns a URL, and the photo is served from here with a
// one-year immutable cache keyed on updated_at. First load fetches each
// photo once; after that the browser (and the service worker) serve it
// from disk, and a re-uploaded photo gets a new ?v= so it refreshes.
//
// No auth on this route: an <img> tag cannot send an Authorization header,
// and these are product photos from a public shop, not private data. The
// id is a UUID, so nothing is guessable.
// ---------------------------------------------------------------
const imageRouter = express.Router();

imageRouter.get("/:id/image", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT image FROM inventory WHERE id = $1", [req.params.id]);
    const raw = rows[0] && rows[0].image;
    if (!raw) return res.status(404).end();

    const match = /^data:([^;]+);base64,(.*)$/s.exec(raw);
    if (!match) return res.status(404).end();

    const buffer = Buffer.from(match[2], "base64");
    res.set("Content-Type", match[1]);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(buffer);
  } catch (err) {
    console.error("Image fetch failed:", err.message);
    res.status(500).end();
  }
});

const suppliersRouter = buildCrudRouter({
  table: "suppliers",
  resource: "suppliers",
  columns: ["name", "contact_person", "phone", "city", "notes"],
  ownerOnly: true,
  auditLog: true,
});

const employeesRouter = buildCrudRouter({
  table: "employees",
  resource: "employees",
  columns: ["name", "role", "salary", "phone", "joined", "status", "account_id", "image"],
  ownerOnlyFields: ["salary"],
  auditLog: true,
});

const affiliatesRouter = buildCrudRouter({
  table: "affiliates",
  resource: "affiliates",
  columns: ["name", "platform", "rate", "sales", "commission", "status", "payment", "account_id"],
  ownerOnly: true,
});

const accountsRouter = buildCrudRouter({
  table: "accounts",
  resource: "accounts",
  columns: ["name", "type", "balance"],
  ownerOnly: true,
});

const expensesRouter = buildCrudRouter({
  table: "expenses",
  resource: "expenses",
  columns: ["title", "category", "amount", "date", "account_id"],
  ownerOnly: true,
  auditLog: true,
  labelField: "title",
});

// Financify-style ad / marketing spend. Manager + owner only.
const adSpendRouter = buildCrudRouter({
  table: "ad_spend",
  resource: "ad_spend",
  columns: ["date", "channel", "campaign", "amount", "notes"],
  ownerOnly: true,
  auditLog: true,
  labelField: "channel",
});

module.exports = { inventoryRouter, employeesRouter, affiliatesRouter, accountsRouter, expensesRouter, adSpendRouter, suppliersRouter, imageRouter };
