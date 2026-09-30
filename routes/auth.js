require("dotenv").config();
const express       = require("express");
const router        = express.Router();
const crypto        = require("crypto");
const supabase      = require("../supabase/client");
const { createEphemeralClient } = require("../supabase/client");
const requireSession = require("../middleware/requireSession");
const requireRole   = require("../middleware/requireRole");

// ── Cookie options (shared) ────────────────────────────────────────────────────
const SESSION_COOKIE_NAME = "session_token";
const COOKIE_OPTIONS = {
    httpOnly:  true,               // JavaScript cannot read this cookie (XSS protection)
    secure:    true,               // HTTPS only — required for SameSite=None
    sameSite:  "none",             // Cross-site allowed — required for Workers↔Render auth
    maxAge:    7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
};

// ── Helper: set or clear session cookie ───────────────────────────────────────
function setSessionCookie(res, token) {
    res.cookie(SESSION_COOKIE_NAME, token, COOKIE_OPTIONS);
}

function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure:   true,
        sameSite: "none"
    });
}

// ── Helper: get client IP safely ──────────────────────────────────────────────
function getClientIp(req) {
    const raw = (
        req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
        req.socket?.remoteAddress ||
        ""
    ).trim();
    return raw.length > 0 ? raw : null;
}

// ── Helper: issue user session (RPC with direct DB insert fallback) ───────────
async function issueUserSession(userId, req) {
    const ip = getClientIp(req);
    const agent = req.headers["user-agent"] || null;

    // 1. Try stored procedure create_user_session
    try {
        const { data: token, error } = await supabase.rpc("create_user_session", {
            p_user_id: userId,
            p_ip:      ip,
            p_agent:   agent
        });
        if (!error && token) {
            return token;
        }
        console.warn("⚠️ RPC create_user_session returned error, using fallback:", error?.message);
    } catch (rpcErr) {
        console.warn("⚠️ RPC create_user_session exception, using fallback:", rpcErr.message);
    }

    // 2. Direct insert fallback into user_sessions
    try {
        const fallbackToken = crypto.randomBytes(48).toString("hex");
        const { data: inserted, error: insertErr } = await supabase
            .from("user_sessions")
            .insert({
                user_id:       userId,
                session_token: fallbackToken,
                ip_address:    ip,
                user_agent:    agent
            })
            .select("session_token")
            .maybeSingle();

        if (!insertErr && inserted?.session_token) {
            return inserted.session_token;
        }
        console.error("❌ Direct session insert fallback failed:", insertErr?.message);
    } catch (fallbackErr) {
        console.error("❌ Direct session fallback exception:", fallbackErr.message);
    }

    return null;
}

// ==============================================================================
// POST /api/auth/login
// Accepts: { identifier, password }
//   identifier = username OR email
// Flow:
//   1. Look up user in system_users by username or email (case-insensitive)
//   2. Verify password via Supabase Auth signInWithPassword
//   3. Call record_login_attempt() for audit + lockout logic (5 failures = 24h block)
//   4. Call create_user_session() → set httpOnly cookie
// ==============================================================================
router.post("/login", async (req, res) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
        return res.status(400).json({ error: "identifier and password are required" });
    }

    const cleanIdentifier = identifier.trim();
    const isEmail = cleanIdentifier.includes("@");

    try {
        // Step 1: Look up user by username OR email (case-insensitive)
        let lookupQuery = supabase
            .from("system_users")
            .select("id, email, username, full_name, role, is_active, locked_until, failed_login_count, avatar_url, phone_number");

        if (isEmail) {
            lookupQuery = lookupQuery.eq("email", cleanIdentifier.toLowerCase());
        } else {
            lookupQuery = lookupQuery.ilike("username", cleanIdentifier);
        }

        const { data: userRow, error: lookupError } = await lookupQuery.maybeSingle();

        if (lookupError) {
            console.error("❌ Login lookup error:", lookupError.message);
            return res.status(500).json({ error: "Login failed. Please try again." });
        }

        if (!userRow) {
            // Record attempt without a real user_id (unknown username/email)
            await supabase.rpc("record_login_attempt", {
                p_user_id:        null,
                p_username_tried: cleanIdentifier,
                p_success:        false,
                p_failure_reason: "user_not_found",
                p_ip_address:     getClientIp(req),
                p_user_agent:     req.headers["user-agent"] || null
            });
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Step 2: Check account health before attempting Auth
        if (!userRow.is_active) {
            return res.status(403).json({ error: "Account is deactivated. Contact your administrator." });
        }

        if (userRow.locked_until && new Date(userRow.locked_until) > new Date()) {
            const lockedUntil = new Date(userRow.locked_until).toISOString();
            return res.status(403).json({
                error: "Account is temporarily locked due to too many failed login attempts.",
                locked_until: lockedUntil
            });
        }

        // Step 3: Verify password via Supabase Auth using ephemeral client (never mutates service_role)
        const authClient = createEphemeralClient();
        const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
            email:    userRow.email,
            password: password
        });

        if (authError || !authData?.user) {
            // Record failed attempt → increments counter, locks after 5 failures
            const { data: attemptResult } = await supabase.rpc("record_login_attempt", {
                p_user_id:        userRow.id,
                p_username_tried: cleanIdentifier,
                p_success:        false,
                p_failure_reason: "wrong_password",
                p_ip_address:     getClientIp(req),
                p_user_agent:     req.headers["user-agent"] || null
            });

            if (attemptResult?.reason === "account_locked") {
                return res.status(403).json({
                    error: "Account has been temporarily locked for 24 hours due to 5 failed login attempts.",
                    locked_until: attemptResult.locked_until
                });
            }

            const remaining = attemptResult?.remaining;
            return res.status(401).json({
                error: "Invalid credentials",
                remaining_attempts: typeof remaining === "number" ? remaining : null
            });
        }

        // Step 4: Record successful login + create session
        await supabase.rpc("record_login_attempt", {
            p_user_id:        userRow.id,
            p_username_tried: cleanIdentifier,
            p_success:        true,
            p_failure_reason: null,
            p_ip_address:     getClientIp(req),
            p_user_agent:     req.headers["user-agent"] || null
        });

        const sessionToken = await issueUserSession(userRow.id, req);

        if (!sessionToken) {
            console.error("❌ issueUserSession failed for user:", userRow.id);
            return res.status(500).json({ error: "Login succeeded but session creation failed. Please try again." });
        }

        setSessionCookie(res, sessionToken);

        console.log(`✅ Login: ${userRow.username} (${userRow.role}) from ${getClientIp(req)}`);

        return res.status(200).json({
            success:  true,
            message:  "Logged in successfully",
            token:    sessionToken,
            user: {
                user_id:      userRow.id,
                username:     userRow.username,
                email:        userRow.email,
                full_name:    userRow.full_name,
                role:         userRow.role,
                avatar_url:   userRow.avatar_url   ?? null,
                phone_number: userRow.phone_number ?? null,
            }
        });

    } catch (err) {
        console.error("❌ /login unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ── Helpers for user fields ───────────────────────────────────────────────────
async function generateUniqueUsername(email) {
    let base = (email || "").split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "").toLowerCase();
    if (base.length < 3) base = `user_${base}`;
    if (base.length > 40) base = base.slice(0, 40);

    let candidate = base;
    let attempts = 0;
    while (attempts < 5) {
        const { data: conflict } = await supabase
            .from("system_users")
            .select("id")
            .ilike("username", candidate)
            .maybeSingle();

        if (!conflict) return candidate;
        candidate = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
        attempts++;
    }
    return `user_${Date.now()}`;
}

function cleanFullNameNoNumbers(name, fallback = "System User") {
    let cleaned = (name || "").replace(/[0-9]/g, "").trim();
    if (cleaned.length < 2) cleaned = fallback;
    if (cleaned.length > 100) cleaned = cleaned.slice(0, 100);
    return cleaned;
}

// ==============================================================================
// POST /api/auth/google
// Called by the frontend AFTER Supabase Auth completes the Google OAuth flow
// and the frontend receives a Supabase access_token.
// Accepts: { access_token }
// Flow:
//   1. Verify the access token via Supabase Auth getUser()
//   2. Check if user already exists in system_users
//      - If YES: logs in immediately (even without password), creates 7-day session cookie
//      - If NO (new account): returns requires_setup: true with profile details so
//        the user can set their password (and optional username) before entering
// ==============================================================================
router.post("/google", async (req, res) => {
    const { access_token } = req.body;

    if (!access_token) {
        return res.status(400).json({ error: "access_token is required" });
    }

    try {
        // Step 1: Verify the token and get the Google user
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(access_token);

        if (authError || !authUser) {
            return res.status(401).json({ error: "Invalid or expired Google token" });
        }

        const cleanEmail = authUser.email.toLowerCase().trim();

        // Step 2: Look up this email in system_users
        const { data: userRow, error: lookupError } = await supabase
            .from("system_users")
            .select("id, auth_user_id, username, email, full_name, role, is_active, locked_until, avatar_url, phone_number")
            .ilike("email", cleanEmail)
            .maybeSingle();

        if (lookupError) {
            console.error("❌ Google login lookup error:", lookupError.message);
            return res.status(500).json({ error: "Login failed. Please try again." });
        }

        if (!userRow) {
            // New Google account! Prompt to set password (and optional username)
            const googleAvatar = authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture || null;
            const googleName = authUser.user_metadata?.full_name || authUser.user_metadata?.name || cleanEmail.split("@")[0];

            return res.status(200).json({
                success: true,
                requires_setup: true,
                email: cleanEmail,
                full_name: cleanFullNameNoNumbers(googleName),
                avatar_url: googleAvatar
            });
        }

        if (!userRow.is_active) {
            return res.status(403).json({ error: "Account is deactivated. Contact your administrator." });
        }

        if (userRow.locked_until && new Date(userRow.locked_until) > new Date()) {
            return res.status(403).json({
                error: "Account is locked. Contact your administrator.",
                locked_until: userRow.locked_until
            });
        }

        // Step 3: Link auth_user_id and update avatar_url if provided
        const googleAvatar = authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture || null;
        const updates = { updated_at: new Date().toISOString() };
        if (googleAvatar && !userRow.avatar_url) updates.avatar_url = googleAvatar;
        if (userRow.auth_user_id !== authUser.id) updates.auth_user_id = authUser.id;

        await supabase
            .from("system_users")
            .update(updates)
            .eq("id", userRow.id);

        // Step 4: Record login in audit log
        await supabase.rpc("record_login_attempt", {
            p_user_id:        userRow.id,
            p_username_tried: userRow.username || cleanEmail,
            p_success:        true,
            p_failure_reason: null,
            p_ip_address:     getClientIp(req),
            p_user_agent:     req.headers["user-agent"] || null
        });

        // Step 5: Create 7-day session cookie
        const sessionToken = await issueUserSession(userRow.id, req);

        if (!sessionToken) {
            console.error("❌ Google login issueUserSession failed for user:", userRow.id);
            return res.status(500).json({ error: "Session creation failed. Please try again." });
        }

        setSessionCookie(res, sessionToken);

        console.log(`✅ Google Login: ${userRow.username || userRow.email} (${userRow.role}) from ${getClientIp(req)}`);

        return res.status(200).json({
            success: true,
            requires_setup: false,
            message: "Logged in with Google successfully",
            token: sessionToken,
            user: {
                user_id:      userRow.id,
                auth_user_id: userRow.auth_user_id || authUser.id,
                username:     userRow.username,
                email:        userRow.email,
                full_name:    userRow.full_name,
                role:         userRow.role,
                avatar_url:   userRow.avatar_url || googleAvatar,
                phone_number: userRow.phone_number ?? null
            }
        });

    } catch (err) {
        console.error("❌ /google unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// POST /api/auth/google/complete-setup
// Sets password and optional username for a new Google account, then immediately
// creates a session and logs them in.
// Accepts: { access_token, password, username?, full_name?, phone_number? }
// ==============================================================================
router.post("/google/complete-setup", async (req, res) => {
    const { access_token, password, username, full_name, phone_number } = req.body;

    if (!access_token || !password) {
        return res.status(400).json({ error: "access_token and password are required" });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters long." });
    }

    try {
        // Step 1: Verify Google OAuth token
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(access_token);
        if (authError || !authUser) {
            return res.status(401).json({ error: "Invalid or expired Google session. Please sign in again." });
        }

        const cleanEmail = authUser.email.toLowerCase().trim();

        // Step 2: Handle Username (OPTIONAL)
        let finalUsername = null;
        if (username && username.trim().length > 0) {
            const trimmedUsername = username.trim().toLowerCase();
            if (trimmedUsername.length < 3 || trimmedUsername.length > 50) {
                return res.status(400).json({ error: "Username must be between 3 and 50 characters." });
            }
            if (!/^[a-zA-Z0-9._-]+$/.test(trimmedUsername)) {
                return res.status(400).json({
                    error: "Username can only contain letters, numbers, periods, underscores, and hyphens."
                });
            }

            // Check if username taken
            const { data: existingUser } = await supabase
                .from("system_users")
                .select("id")
                .ilike("username", trimmedUsername)
                .maybeSingle();

            if (existingUser) {
                return res.status(409).json({ error: "This username is already taken. Please choose another." });
            }

            finalUsername = trimmedUsername;
        } else {
            // Username is optional — auto-generate a valid unique fallback
            finalUsername = await generateUniqueUsername(cleanEmail);
        }

        // Step 3: Handle Full Name (no digits allowed by constraint)
        const rawName = full_name?.trim() || authUser.user_metadata?.full_name || authUser.user_metadata?.name || cleanEmail.split("@")[0];
        const cleanFullName = cleanFullNameNoNumbers(rawName, "Google User");

        // Step 4: Set the password on Supabase Auth via admin API
        const { error: pwdError } = await supabase.auth.admin.updateUserById(authUser.id, {
            password: password,
            user_metadata: {
                full_name: cleanFullName,
                username:  finalUsername,
                role:      "staff"
            }
        });

        if (pwdError) {
            console.error("❌ Failed to set password on Supabase Auth:", pwdError.message);
            return res.status(400).json({ error: `Failed to set password: ${pwdError.message}` });
        }

        // Step 5: Check if system_users row already exists for this email
        const { data: existingRow } = await supabase
            .from("system_users")
            .select("id, role, avatar_url, is_active")
            .ilike("email", cleanEmail)
            .maybeSingle();

        const googleAvatar = authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture || null;
        let systemUserId = null;
        let userRole = "staff";

        if (existingRow) {
            systemUserId = existingRow.id;
            userRole = existingRow.role || "staff";
            await supabase
                .from("system_users")
                .update({
                    auth_user_id: authUser.id,
                    full_name: cleanFullName,
                    username: finalUsername,
                    avatar_url: googleAvatar || existingRow.avatar_url,
                    updated_at: new Date().toISOString()
                })
                .eq("id", existingRow.id);

            // If account is not active, return pending approval
            if (!existingRow.is_active) {
                console.log(`⏳ Account pending approval: ${cleanEmail} (${finalUsername})`);
                return res.status(200).json({
                    success: true,
                    requires_approval: true,
                    message: "Account setup complete! Your account is pending administrator approval before you can log in."
                });
            }
        } else {
            // New self-registered account: requires admin/super_admin approval
            const { data: inserted, error: insertError } = await supabase
                .from("system_users")
                .insert({
                    auth_user_id: authUser.id,
                    email: cleanEmail,
                    full_name: cleanFullName,
                    username: finalUsername,
                    phone_number: phone_number?.trim() || null,
                    role: "staff", // new self-registrations default to staff only
                    avatar_url: googleAvatar,
                    is_active: false // Pending approval by Super Admin or Admin
                })
                .select("id, role, is_active")
                .single();

            if (insertError) {
                console.error("❌ Failed to insert system_user:", insertError.message);
                return res.status(500).json({ error: "Failed to create user profile. Please try again." });
            }
            systemUserId = inserted.id;
            userRole = inserted.role;

            console.log(`⏳ New account registered, pending administrator approval: ${cleanEmail} (${finalUsername})`);

            return res.status(200).json({
                success: true,
                requires_approval: true,
                message: "Account created successfully! Your account is pending administrator approval before you can log in to the command center."
            });
        }

        // Step 6: Record login attempt in audit log (for already-active users)
        await supabase.rpc("record_login_attempt", {
            p_user_id:        systemUserId,
            p_username_tried: finalUsername,
            p_success:        true,
            p_failure_reason: null,
            p_ip_address:     getClientIp(req),
            p_user_agent:     req.headers["user-agent"] || null
        });

        // Step 7: Issue 7-day session token & set httpOnly cookie
        const sessionToken = await issueUserSession(systemUserId, req);

        if (!sessionToken) {
            console.error("❌ Session creation error for setup user:", systemUserId);
            return res.status(500).json({ error: "Session creation failed. Please try again." });
        }

        setSessionCookie(res, sessionToken);

        console.log(`🎉 Account setup and active: ${cleanEmail} (${finalUsername})`);

        return res.status(200).json({
            success: true,
            requires_approval: false,
            message: "Password set and logged in successfully!",
            token: sessionToken,
            user: {
                user_id:      systemUserId,
                auth_user_id: authUser.id,
                username:     finalUsername,
                email:        cleanEmail,
                full_name:    cleanFullName,
                role:         userRole,
                avatar_url:   googleAvatar,
                phone_number: phone_number?.trim() || null
            }
        });

    } catch (err) {
        console.error("❌ /google/complete-setup error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// POST /api/auth/logout
// Revokes the current session token from the database and clears the cookie.
// Requires: valid session cookie
// ==============================================================================
router.post("/logout", requireSession, async (req, res) => {
    const authHeader = req.headers["authorization"];
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const token = req.cookies?.[SESSION_COOKIE_NAME] || bearerToken || req.headers["x-session-token"] || null;

    try {
        if (token) {
            await supabase.rpc("revoke_session", { p_token: token });
        }
        clearSessionCookie(res);

        console.log(`👋 Logout: ${req.user.username}`);

        return res.status(200).json({ success: true, message: "Logged out successfully" });
    } catch (err) {
        console.error("❌ /logout error:", err.message);
        clearSessionCookie(res);
        return res.status(200).json({ success: true, message: "Logged out" });
    }
});


// ==============================================================================
// GET /api/auth/me
// Returns the currently authenticated user's profile from the session.
// Requires: valid session cookie
// ==============================================================================
router.get("/me", requireSession, (req, res) => {
    // Normalize req.user (camelCase from requireSession) to the snake_case
    // AuthUser interface expected by the frontend.
    return res.status(200).json({
        success: true,
        user: {
            user_id:      req.user.id,
            auth_user_id: req.user.authUserId  ?? null,
            username:     req.user.username,
            email:        req.user.email,
            full_name:    req.user.fullName    ?? null,
            role:         req.user.role,
            avatar_url:   req.user.avatarUrl   ?? null,
            phone_number: req.user.phoneNumber ?? null,
            expires_at:   req.user.expiresAt   ?? null,
        }
    });
});


// ==============================================================================
// GET /api/auth/users
// Returns list of all system_users for admin/super_admin user management.
// Requires: valid session with role admin or super_admin
// ==============================================================================
router.get("/users", requireSession, requireRole("super_admin", "admin"), async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from("system_users")
            .select("id, auth_user_id, username, email, full_name, role, is_active, last_login_at, created_at, avatar_url, phone_number")
            .order("created_at", { ascending: false });

        if (error) {
            console.error("❌ /users query error:", error.message);
            return res.status(500).json({ error: "Failed to fetch users" });
        }

        return res.status(200).json({
            success: true,
            users: users.map(u => ({
                user_id:       u.id,
                auth_user_id:  u.auth_user_id,
                username:      u.username,
                email:         u.email,
                full_name:     u.full_name,
                role:          u.role,
                is_active:     u.is_active,
                last_login_at: u.last_login_at,
                created_at:    u.created_at,
                avatar_url:    u.avatar_url,
                phone_number:  u.phone_number
            }))
        });
    } catch (err) {
        console.error("❌ /users unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// PATCH /api/auth/users/:id/status
// Accepts/approves a pending user or activates/deactivates an existing user.
// Requires: valid session with role admin or super_admin
// Accepts: { is_active: boolean }
// ==============================================================================
router.patch("/users/:id/status", requireSession, requireRole("super_admin", "admin"), async (req, res) => {
    const { id: targetUserId } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== "boolean") {
        return res.status(400).json({ error: "is_active must be a boolean (true or false)" });
    }

    try {
        const { data: targetUser, error: lookupErr } = await supabase
            .from("system_users")
            .select("id, username, role, is_active")
            .eq("id", targetUserId)
            .maybeSingle();

        if (lookupErr || !targetUser) {
            return res.status(404).json({ error: "Target user not found" });
        }

        // An admin cannot modify a super_admin's status
        if (targetUser.role === "super_admin" && req.user.role !== "super_admin") {
            return res.status(403).json({ error: "Forbidden. Admins cannot change the status of a Super Admin." });
        }

        // Prevent deactivating the last active super_admin
        if (targetUser.role === "super_admin" && !is_active) {
            const { count } = await supabase
                .from("system_users")
                .select("id", { count: "exact", head: true })
                .eq("role", "super_admin")
                .eq("is_active", true);

            if (count <= 1) {
                return res.status(403).json({ error: "Cannot deactivate the last remaining active Super Admin." });
            }
        }

        const { error: updateErr } = await supabase
            .from("system_users")
            .update({
                is_active: is_active,
                updated_at: new Date().toISOString()
            })
            .eq("id", targetUserId);

        if (updateErr) {
            console.error("❌ Update user status error:", updateErr.message);
            return res.status(500).json({ error: "Failed to update user status" });
        }

        // If deactivated, revoke all active sessions immediately
        if (!is_active) {
            await supabase.rpc("revoke_all_sessions", { p_user_id: targetUserId });
        }

        console.log(`👤 User ${targetUser.username} status set to ${is_active ? 'ACTIVE' : 'INACTIVE'} by ${req.user.username}`);

        return res.status(200).json({
            success: true,
            message: is_active ? "User approved and activated successfully." : "User deactivated successfully.",
            is_active
        });

    } catch (err) {
        console.error("❌ /users/:id/status unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// POST /api/auth/invite
// Generates a 1-hour invite URL for a new account registration.
// Requires: super_admin or admin session
// Accepts: { target_role } — "admin" or "staff" (default: "staff")
// ==============================================================================
router.post("/invite", requireSession, requireRole("super_admin", "admin"), async (req, res) => {
    const targetRole = req.body.target_role || "staff";
    const validRoles = req.user.role === "super_admin" 
        ? ["admin", "staff", "super_admin"] 
        : ["admin", "staff"];

    if (!validRoles.includes(targetRole)) {
        return res.status(400).json({
            error: req.user.role === "admin" && targetRole === "super_admin"
                ? "Admins cannot invite users with the 'super_admin' role."
                : `Invalid target_role. Allowed values: ${validRoles.join(", ")}`
        });
    }

    try {
        const { data: token, error } = await supabase.rpc("generate_invite_token", {
            p_issued_by:   req.user.id,
            p_target_role: targetRole
        });

        if (error || !token) {
            console.error("❌ generate_invite_token error:", error?.message);
            return res.status(500).json({ error: "Failed to generate invite link" });
        }

        const baseUrl   = (process.env.FRONTEND_URL || "https://responde-frontend-reactjs.sedrickopulencia.workers.dev").replace(/\/+$/, "");
        const inviteUrl = `${baseUrl}/register?token=${token}`;

        console.log(`📨 Invite generated by ${req.user.username} for role: ${targetRole}`);

        return res.status(201).json({
            success:     true,
            invite_url:  inviteUrl,
            target_role: targetRole,
            expires_in:  "1 hour"
        });

    } catch (err) {
        console.error("❌ /invite unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// POST /api/auth/register
// Called when a new user visits the invite URL and fills out the registration form.
// Accepts: { token, email, password, username, full_name, phone_number? }
// Flow:
//   1. Validate form fields (username format, full_name no numbers)
//   2. Verify username and email are not already taken
//   3. Validate the invite token
//   4. Create Supabase Auth user (triggers handle_new_auth_user)
//   5. Consume invite token and ensure role assignment
// ==============================================================================
router.post("/register", async (req, res) => {
    const { token, email, password, username, full_name, phone_number } = req.body;

    // Basic validation
    if (!token || !email || !password || !full_name) {
        return res.status(400).json({
            error: "token, email, password, and full_name are required"
        });
    }

    const trimmedFullName = cleanFullNameNoNumbers(full_name);
    if (trimmedFullName.length < 2 || trimmedFullName.length > 100) {
        return res.status(400).json({ error: "full_name must be between 2 and 100 characters and contain no numbers" });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Username is optional
    let trimmedUsername = null;
    if (username && username.trim().length > 0) {
        trimmedUsername = username.trim().toLowerCase();
        if (trimmedUsername.length < 3 || trimmedUsername.length > 50) {
            return res.status(400).json({ error: "username must be between 3 and 50 characters" });
        }

        if (!/^[a-zA-Z0-9._-]+$/.test(trimmedUsername)) {
            return res.status(400).json({
                error: "username can only contain letters, numbers, periods, underscores, and hyphens"
            });
        }
    } else {
        trimmedUsername = await generateUniqueUsername(cleanEmail);
    }

    try {
        // Step 1: Pre-check if username or email already exists in system_users
        const { data: existingUsername } = await supabase
            .from("system_users")
            .select("id")
            .eq("username", trimmedUsername)
            .maybeSingle();

        if (existingUsername) {
            return res.status(409).json({ error: "This username is already taken. Please choose another." });
        }

        const { data: existingEmail } = await supabase
            .from("system_users")
            .select("id")
            .eq("email", cleanEmail)
            .maybeSingle();

        if (existingEmail) {
            return res.status(409).json({ error: "An account with this email already exists." });
        }

        // Step 2: Validate token
        const { data: inviteCheck, error: checkError } = await supabase
            .from("invite_tokens")
            .select("id, target_role, expires_at, used_at, is_revoked")
            .eq("token", token)
            .maybeSingle();

        if (checkError) {
            console.error("❌ Invite token check error:", checkError.message);
            return res.status(500).json({ error: "Registration failed. Please try again." });
        }

        if (!inviteCheck) {
            return res.status(400).json({ error: "Invalid or expired invite link." });
        }

        if (inviteCheck.used_at || inviteCheck.is_revoked) {
            return res.status(400).json({ error: "This invite link has already been used or revoked." });
        }

        if (new Date(inviteCheck.expires_at) < new Date()) {
            return res.status(400).json({ error: "This invite link has expired. Ask your administrator for a new one." });
        }

        // Step 3: Create Supabase Auth user with metadata
        // handle_new_auth_user() trigger will auto-insert into system_users
        const { data: signUpData, error: signUpError } = await supabase.auth.admin.createUser({
            email:         cleanEmail,
            password:      password,
            email_confirm: true,   // auto-confirm, no email verification needed (invite = pre-verified)
            user_metadata: {
                full_name:    trimmedFullName,
                username:     trimmedUsername,
                phone_number: phone_number?.trim() || null,
                role:         inviteCheck.target_role
            }
        });

        if (signUpError) {
            const msg = signUpError.message || "";
            if (msg.includes("already registered") || msg.includes("already been registered")) {
                return res.status(409).json({ error: "An account with this email already exists." });
            }
            console.error("❌ createUser error:", msg);
            return res.status(400).json({ error: msg });
        }

        const newAuthUserId = signUpData.user.id;

        // Step 4: Look up the newly created system_users row (created by trigger)
        let { data: newUserRow } = await supabase
            .from("system_users")
            .select("id")
            .eq("auth_user_id", newAuthUserId)
            .maybeSingle();

        // Fallback: If trigger did not run, perform direct insertion
        if (!newUserRow) {
            const { data: insertedUser, error: insertErr } = await supabase
                .from("system_users")
                .insert({
                    auth_user_id: newAuthUserId,
                    full_name:    trimmedFullName,
                    username:     trimmedUsername,
                    email:        cleanEmail,
                    phone_number: phone_number?.trim() || null,
                    role:         inviteCheck.target_role
                })
                .select("id")
                .single();

            if (insertErr && !insertErr.message.includes("duplicate")) {
                console.error("❌ Fallback system_users insert error:", insertErr.message);
            }
            newUserRow = insertedUser;
        }

        if (!newUserRow) {
            console.error("❌ New user system_users lookup and fallback both failed");
            return res.status(500).json({ error: "Account created but profile setup failed. Contact administrator." });
        }

        // Step 5: Consume the invite token and ensure role assignment
        const { error: consumeError } = await supabase.rpc("consume_invite_token", {
            p_token:       token,
            p_new_user_id: newUserRow.id
        });

        if (consumeError) {
            console.error("⚠️ consume_invite_token error:", consumeError.message);
        }

        console.log(`🎉 New account registered: ${trimmedUsername} (${inviteCheck.target_role})`);

        return res.status(201).json({
            success: true,
            message: "Account created successfully. You can now log in.",
            role:    inviteCheck.target_role
        });

    } catch (err) {
        console.error("❌ /register unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// PATCH /api/auth/users/:id/role
// Changes a user's role.
// Rules:
//   - Super Admin can change any role (promotions to super_admin require OTP)
//   - Admin can promote/demote between staff and admin, but CANNOT promote to super_admin
//   - Admin CANNOT modify a super_admin's role
// ==============================================================================
router.patch("/users/:id/role", requireSession, requireRole("super_admin", "admin"), async (req, res) => {
    const { id: targetUserId }     = req.params;
    const { new_role, password, supabase_otp, notes } = req.body;

    if (!new_role || !password) {
        return res.status(400).json({ error: "new_role and password are required" });
    }

    const validRoles = ["admin", "staff", "super_admin"];
    if (!validRoles.includes(new_role)) {
        return res.status(400).json({ error: `Invalid role. Allowed: ${validRoles.join(", ")}` });
    }

    // Role restrictions:
    // Admin can ONLY promote to admin or staff.
    // Admin CANNOT promote anyone to super_admin!
    if (req.user.role === "admin" && new_role === "super_admin") {
        return res.status(403).json({
            error: "Forbidden. An Admin cannot promote a user to Super Admin. Only Super Admins can promote to Super Admin."
        });
    }

    if (new_role === "super_admin" && !supabase_otp) {
        return res.status(400).json({
            error: "Promoting to super_admin requires an OTP from your email. Please check your inbox."
        });
    }

    try {
        // Pre-check: Target user existence and role protections
        const { data: targetUser, error: targetLookupErr } = await supabase
            .from("system_users")
            .select("id, username, role, auth_user_id")
            .eq("id", targetUserId)
            .maybeSingle();

        if (targetLookupErr || !targetUser) {
            return res.status(404).json({ error: "Target user not found" });
        }

        // An admin cannot modify a super_admin
        if (targetUser.role === "super_admin" && req.user.role !== "super_admin") {
            return res.status(403).json({
                error: "Forbidden. An Admin cannot modify the role of a Super Admin."
            });
        }

        if (targetUser.role === "super_admin" && req.user.id !== targetUserId) {
            return res.status(403).json({
                error: "Forbidden. A super admin cannot change or edit the role of a co-super admin."
            });
        }

        if (targetUserId === req.user.id && new_role === "super_admin" && req.user.role === "super_admin") {
            return res.status(400).json({ error: "You are already a super_admin." });
        }

        // Step 1: Re-verify caller's own password via Supabase Auth using ephemeral client
        const authClient = createEphemeralClient();
        const { error: reAuthError } = await authClient.auth.signInWithPassword({
            email:    req.user.email,
            password: password
        });

        if (reAuthError) {
            return res.status(401).json({ error: "Password confirmation failed. Role not changed." });
        }

        // If caller is Admin changing between staff and admin:
        if (req.user.role === "admin") {
            const oldRole = targetUser.role;
            await supabase
                .from("system_users")
                .update({ role: new_role, updated_at: new Date().toISOString() })
                .eq("id", targetUserId);

            if (targetUser.auth_user_id) {
                await supabase.auth.admin.updateUserById(targetUser.auth_user_id, {
                    user_metadata: { role: new_role }
                });
            }

            console.log(`🔒 Role change by admin ${req.user.username}: user ${targetUserId} (${oldRole} -> ${new_role})`);

            return res.status(200).json({
                success:  true,
                message:  `Role changed successfully from ${oldRole} to ${new_role}`,
                old_role: oldRole,
                new_role: new_role
            });
        }

        // Caller is super_admin:
        let supabaseAuthConfirmed = false;
        if (new_role === "super_admin") {
            const otpClient = createEphemeralClient();
            const { error: otpError } = await otpClient.auth.verifyOtp({
                email: req.user.email,
                token: supabase_otp,
                type:  "email"
            });

            if (otpError) {
                return res.status(401).json({
                    error: "OTP verification failed. Please request a new code and try again."
                });
            }
            supabaseAuthConfirmed = true;
        }

        const { data: result, error: changeError } = await supabase.rpc("change_user_role", {
            p_changed_by:              req.user.id,
            p_target_user_id:          targetUserId,
            p_new_role:                new_role,
            p_password_confirmed:      true,
            p_supabase_auth_confirmed: supabaseAuthConfirmed,
            p_notes:                   notes || null
        });

        if (changeError) {
            console.error("❌ change_user_role error:", changeError.message);
            return res.status(500).json({ error: "Failed to change role. Please try again." });
        }

        if (!result?.ok) {
            const reasonMessages = {
                cannot_modify_co_super_admin:   "A super admin cannot modify the role of a fellow super admin.",
                cannot_demote_last_super_admin: "Cannot demote the last remaining active super_admin.",
                forbidden_not_super_admin:      "Only super_admin accounts can modify roles.",
                password_not_confirmed:         "Password confirmation was not provided.",
                supabase_auth_required_for_super_admin: "OTP confirmation is required to promote to super_admin.",
                target_user_not_found:          "Target user does not exist."
            };
            return res.status(403).json({
                error: reasonMessages[result?.reason] || result?.reason || "Role change denied."
            });
        }

        console.log(`🔒 Role change: user ${targetUserId} → ${new_role} by super_admin ${req.user.username}`);

        return res.status(200).json({
            success:  true,
            message:  `Role changed successfully from ${result.old_role} to ${result.new_role}`,
            old_role: result.old_role,
            new_role: result.new_role
        });

    } catch (err) {
        console.error("❌ /users/:id/role unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// POST /api/auth/request-otp
// Sends an OTP to the super_admin's email (required before promoting to super_admin).
// Requires: super_admin session
// ==============================================================================
router.post("/request-otp", requireSession, requireRole("super_admin"), async (req, res) => {
    try {
        const otpClient = createEphemeralClient();
        const { error } = await otpClient.auth.signInWithOtp({
            email:   req.user.email,
            options: { shouldCreateUser: false }
        });

        if (error) {
            console.error("❌ OTP request error:", error.message);
            return res.status(500).json({ error: "Failed to send OTP. Please try again." });
        }

        console.log(`📧 OTP requested by ${req.user.username} for super_admin promotion`);

        return res.status(200).json({
            success: true,
            message: `OTP sent to ${req.user.email}. It expires in 10 minutes.`
        });

    } catch (err) {
        console.error("❌ /request-otp unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;
