const buildCrudRouter = require("../utils/crudRouter");
const { pushStockSafe } = require("../services/woocommerce");

const inventoryRouter = buildCrudRouter({
  table: "inventory",
  resource: "inventory",
  columns: [
    "name", "sku", "category", "quantity", "reorder", "cost", "price", "image",
    "wc_product_id", "wc_variation_id",
    // Variant fields — each size/colour is its own row, grouped by parent_name.
    "parent_name", "size", "color", "supplier_id",
  ],
  auditLog: true,
  // Any quantity change goes straight back to the website so a POS sale
  // can't leave the shop overselling stock it no longer has.
  afterWrite: (after, before) => {
    if (!before || Number(before.quantity) !== Number(after.quantity)) pushStockSafe(after);
  },
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

module.exports = { inventoryRouter, employeesRouter, affiliatesRouter, accountsRouter, expensesRouter, adSpendRouter, suppliersRouter };
