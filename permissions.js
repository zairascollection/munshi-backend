// Three roles: owner (full access), manager (sees cost/salary/finance/
// reports but can't delete anything and can't touch Team or Accounts),
// staff (operational only — no cost, salary, profit, finance, delete).

// Always owner-only, regardless of manager status.
const OWNER_ONLY_RESOURCES = new Set(["accounts", "users", "audit_log"]);
// Visible to manager and owner, hidden from staff.
const MANAGER_RESOURCES = new Set(["finance", "expenses", "affiliates"]);

function isOwner(user) {
  return user && user.role === "owner";
}

function isManagerOrAbove(user) {
  return user && (user.role === "owner" || user.role === "manager");
}

function canAccessResource(user, resource) {
  if (OWNER_ONLY_RESOURCES.has(resource)) return isOwner(user);
  if (MANAGER_RESOURCES.has(resource)) return isManagerOrAbove(user);
  return true;
}

// Only the owner can ever delete records.
function canDelete(user) {
  return isOwner(user);
}

// Strips cost/salary from records before sending them to staff. Managers
// see everything a record has (inventory cost is visible to everyone now,
// tracked instead via the audit log — see routes/auditLog.js).
function scrubForRole(user, resource, record) {
  if (isManagerOrAbove(user) || !record) return record;
  const clone = { ...record };
  if (resource === "orders") {
    delete clone.cost;
  }
  if (resource === "employees") {
    delete clone.salary;
  }
  return clone;
}

module.exports = { isOwner, isManagerOrAbove, canAccessResource, canDelete, scrubForRole, OWNER_ONLY_RESOURCES, MANAGER_RESOURCES };
