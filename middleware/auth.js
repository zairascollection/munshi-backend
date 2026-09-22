const jwt = require("jsonwebtoken");
const { canAccessResource, canDelete } = require("../utils/permissions");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, name, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Blocks staff from an entire resource (finance, accounts, expenses, affiliates)
function requireResourceAccess(resource) {
  return (req, res, next) => {
    if (!canAccessResource(req.user, resource)) {
      return res.status(403).json({ error: "Owner access required" });
    }
    next();
  };
}

// Blocks staff from DELETE endpoints anywhere in the app
function requireDeletePermission(req, res, next) {
  if (!canDelete(req.user)) {
    return res.status(403).json({ error: "Only the owner can delete records" });
  }
  next();
}

module.exports = { requireAuth, requireResourceAccess, requireDeletePermission };
