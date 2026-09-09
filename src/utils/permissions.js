// Mirrors the ownerOnly NAV sections + delete restrictions already
// designed into munshi.jsx, now enforced server-side instead of just
// hidden in the UI (so staff can't hit the API directly and see them).

const OWNER_ONLY_RESOURCES = new Set(["finance", "accounts", "expenses", "affiliates", "users"]);

function isOwner(user) {
  return user && user.role === "owner";
}

function canAccessResource(user, resource) {
  if (isOwner(user)) return true;
  return !OWNER_ONLY_RESOURCES.has(resource);
}

function canDelete(user) {
  return isOwner(user);
}

// Strips cost/profit-revealing fields from inventory/order records
// before sending them to a staff user.
function scrubForRole(user, resource, record) {
  if (isOwner(user) || !record) return record;
  const clone = { ...record };
  if (resource === "inventory") {
    delete clone.cost;
  }
  if (resource === "orders") {
    delete clone.cost;
  }
  if (resource === "employees") {
    delete clone.salary;
  }
  return clone;
}

module.exports = { isOwner, canAccessResource, canDelete, scrubForRole, OWNER_ONLY_RESOURCES };
