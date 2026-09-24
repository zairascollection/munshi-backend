// Three roles: owner (full access), manager (sees cost/salary/finance/
// reports but can't delete anything and can't touch Team or Accounts),
// staff (operational only — no cost, salary, profit, finance, delete).

// Always owner-only, regardless of manager status.
const OWNER_ONLY_RESOURCES = new Set(["accounts", "users", "audit_log"]);
// Visible to manager and owner, hidden from staff.
const MANAGER_RESOURCES = new Set(["finance", "expenses", "affiliates", "ad_spend", "settings", "analytics", "suppliers", "purchases"]);

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

// Managers can delete as well as edit. The safeguard is not a locked
// button — it is that every delete is written to the change history with
// the deleter's name and a summary of what the record held, so the owner
// can see exactly what happened and put it back.
function canDelete(user) {
  return isManagerOrAbove(user);
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
