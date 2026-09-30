const supabase = require("../supabase/client");

/**
 * Middleware: Reads the `session_token` httpOnly cookie, validates it against
 * the database via validate_session(), and attaches the decoded user to req.user.
 *
 * If the session is missing or invalid, responds with 401 Unauthorized.
 *
 * Usage:
 *   router.get("/protected", requireSession, (req, res) => {
 *       res.json({ user: req.user });
 *   });
 */
async function requireSession(req, res, next) {
    const token = req.cookies?.session_token;

    if (!token) {
        return res.status(401).json({
            error: "Unauthorized",
            reason: "No session token. Please log in."
        });
    }

    try {
        const { data, error } = await supabase.rpc("validate_session", {
            p_token: token
        });

        if (error) {
            console.error("❌ validate_session RPC error:", error.message);
            return res.status(500).json({ error: "Session validation failed" });
        }

        if (!data?.valid) {
            return res.status(401).json({
                error: "Unauthorized",
                reason: data?.reason || "Session expired or invalid. Please log in again."
            });
        }

        // Attach user profile to request for downstream use
        req.user = {
            id:          data.user_id,
            authUserId:  data.auth_user_id,
            fullName:    data.full_name,
            username:    data.username,
            email:       data.email,
            phoneNumber: data.phone_number,
            avatarUrl:   data.avatar_url,
            role:        data.role,
            expiresAt:   data.expires_at
        };

        next();
    } catch (err) {
        console.error("❌ requireSession unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error during session check" });
    }
}

module.exports = requireSession;
