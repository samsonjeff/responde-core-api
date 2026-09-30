/**
 * Middleware factory: Restricts a route to users with specific roles.
 *
 * MUST be used AFTER requireSession (which populates req.user).
 *
 * Role hierarchy:
 *   super_admin  → full access (edit roles, all features)
 *   admin        → read, update, delete; cannot edit roles
 *   staff        → dashboard only; no data read/update/delete
 *
 * Usage:
 *   router.patch("/users/:id/role", requireSession, requireRole("super_admin"), handler);
 *   router.get("/conversations",   requireSession, requireRole("admin", "super_admin"), handler);
 *
 * @param {...string} roles - One or more allowed role strings
 */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            // Should never reach here without requireSession, but guard anyway
            return res.status(401).json({
                error: "Unauthorized",
                reason: "No authenticated user on request. Ensure requireSession runs first."
            });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                error: "Forbidden",
                reason: `This action requires one of the following roles: ${roles.join(", ")}. Your role: ${req.user.role}.`
            });
        }

        next();
    };
}

module.exports = requireRole;
