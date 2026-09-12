const buildCrudRouter = require("../utils/crudRouter");

const inventoryRouter = buildCrudRouter({
  table: "inventory",
  resource: "inventory",
  columns: ["name", "sku", "category", "quantity", "reorder", "cost", "price", "image", "wc_product_id", "wc_variation_id"],
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

module.exports = { inventoryRouter, employeesRouter, affiliatesRouter, accountsRouter, expensesRouter, adSpendRouter };
