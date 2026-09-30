require("dotenv").config();
const express       = require("express");
const router        = express.Router();
const supabase      = require("../supabase/client");
const requireSession = require("../middleware/requireSession");
const requireRole   = require("../middleware/requireRole");

// ── Cookie options (shared) ────────────────────────────────────────────────────
const SESSION_COOKIE_NAME = "session_token";
const COOKIE_OPTIONS = {
    httpOnly:  true,               // JavaScript cannot read this cookie (XSS protection)
    secure:    process.env.NODE_ENV === "production", // HTTPS only in production
    sameSite:  "strict",           // No cross-site requests
    maxAge:    7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
};

// ── Helper: set or clear session cookie ───────────────────────────────────────
function setSessionCookie(res, token) {
    res.cookie(SESSION_COOKIE_NAME, token, COOKIE_OPTIONS);
}

function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === "production",
        sameSite: "strict"
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
            .select("id, email, username, role, is_active, locked_until, failed_login_count");

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

        // Step 3: Verify password via Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
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

        const { data: sessionToken, error: sessionError } = await supabase.rpc("create_user_session", {
            p_user_id: userRow.id,
            p_ip:      getClientIp(req),
            p_agent:   req.headers["user-agent"] || null
        });

        if (sessionError || !sessionToken) {
            console.error("❌ create_user_session error:", sessionError?.message);
            return res.status(500).json({ error: "Login succeeded but session creation failed. Please try again." });
        }

        setSessionCookie(res, sessionToken);

        console.log(`✅ Login: ${userRow.username} (${userRow.role}) from ${getClientIp(req)}`);

        return res.status(200).json({
            success:  true,
            message:  "Logged in successfully",
            user: {
                id:       userRow.id,
                username: userRow.username,
                role:     userRow.role
            }
        });

    } catch (err) {
        console.error("❌ /login unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// POST /api/auth/google
// Called by the frontend AFTER Supabase Auth completes the Google OAuth flow
// and the frontend receives a Supabase access_token.
// Accepts: { access_token }
// Flow:
//   1. Verify the access token via Supabase Auth getUser()
//   2. Check that the email exists in system_users (invite-only guard)
//   3. Link auth_user_id & sync avatar_url
//   4. Record successful login audit
//   5. Create 7-day session cookie for consistency
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

        // Step 2: Look up this email in our system_users (invite-only guard)
        const { data: userRow, error: lookupError } = await supabase
            .from("system_users")
            .select("id, auth_user_id, username, role, is_active, locked_until")
            .ilike("email", cleanEmail)
            .maybeSingle();

        if (lookupError) {
            console.error("❌ Google login lookup error:", lookupError.message);
            return res.status(500).json({ error: "Login failed. Please try again." });
        }

        if (!userRow) {
            // Email not in system_users — not an invited user
            return res.status(403).json({
                error: "Access denied. Your Google account is not registered in this system. Contact your administrator."
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
        if (googleAvatar) updates.avatar_url = googleAvatar;
        if (userRow.auth_user_id !== authUser.id) updates.auth_user_id = authUser.id;

        await supabase
            .from("system_users")
            .update(updates)
            .eq("id", userRow.id);

        // Step 4: Record login in audit log
        await supabase.rpc("record_login_attempt", {
            p_user_id:        userRow.id,
            p_username_tried: cleanEmail,
            p_success:        true,
            p_failure_reason: null,
            p_ip_address:     getClientIp(req),
            p_user_agent:     req.headers["user-agent"] || null
        });

        // Step 5: Create 7-day session cookie (same flow as password login)
        const { data: sessionToken, error: sessionError } = await supabase.rpc("create_user_session", {
            p_user_id: userRow.id,
            p_ip:      getClientIp(req),
            p_agent:   req.headers["user-agent"] || null
        });

        if (sessionError || !sessionToken) {
            console.error("❌ Google login create_user_session error:", sessionError?.message);
            return res.status(500).json({ error: "Session creation failed. Please try again." });
        }

        setSessionCookie(res, sessionToken);

        console.log(`✅ Google Login: ${userRow.username} (${userRow.role}) from ${getClientIp(req)}`);

        return res.status(200).json({
            success: true,
            message: "Logged in with Google successfully",
            user: {
                id:       userRow.id,
                username: userRow.username,
                role:     userRow.role
            }
        });

    } catch (err) {
        console.error("❌ /google unexpected error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});


// ==============================================================================
// POST /api/auth/logout
// Revokes the current session token from the database and clears the cookie.
// Requires: valid session cookie
// ==============================================================================
router.post("/logout", requireSession, async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];

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
    return res.status(200).json({ success: true, user: req.user });
});


// ==============================================================================
// POST /api/auth/invite
// Generates a 1-hour invite URL for a new account registration.
// Requires: super_admin session
// Accepts: { target_role } — "admin" or "staff" (default: "staff")
// ==============================================================================
router.post("/invite", requireSession, requireRole("super_admin"), async (req, res) => {
    const targetRole = req.body.target_role || "staff";
    const validRoles = ["admin", "staff"];

    if (!validRoles.includes(targetRole)) {
        return res.status(400).json({
            error: `Invalid target_role. Allowed values: ${validRoles.join(", ")}`
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

        const baseUrl   = process.env.FRONTEND_URL || "http://localhost:3000";
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
    if (!token || !email || !password || !username || !full_name) {
        return res.status(400).json({
            error: "token, email, password, username, and full_name are required"
        });
    }

    const trimmedFullName = full_name.trim();
    if (/[0-9]/.test(trimmedFullName)) {
        return res.status(400).json({ error: "full_name must not contain numbers" });
    }

    if (trimmedFullName.length < 2 || trimmedFullName.length > 100) {
        return res.status(400).json({ error: "full_name must be between 2 and 100 characters" });
    }

    const trimmedUsername = username.trim().toLowerCase();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 50) {
        return res.status(400).json({ error: "username must be between 3 and 50 characters" });
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(trimmedUsername)) {
        return res.status(400).json({
            error: "username can only contain letters, numbers, periods, underscores, and hyphens"
        });
    }

    const cleanEmail = email.trim().toLowerCase();

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
// Changes a user's role. Requires:
//   - Caller must be super_admin with valid session
//   - Body must include { new_role, password } (caller's own password for confirmation)
//   - If promoting to super_admin, body must also include { supabase_otp } (OTP code)
// ==============================================================================
router.patch("/users/:id/role", requireSession, requireRole("super_admin"), async (req, res) => {
    const { id: targetUserId }     = req.params;
    const { new_role, password, supabase_otp, notes } = req.body;

    if (!new_role || !password) {
        return res.status(400).json({ error: "new_role and password are required" });
    }

    const validRoles = ["admin", "staff", "super_admin"];
    if (!validRoles.includes(new_role)) {
        return res.status(400).json({ error: `Invalid role. Allowed: ${validRoles.join(", ")}` });
    }

    if (new_role === "super_admin" && !supabase_otp) {
        return res.status(400).json({
            error: "Promoting to super_admin requires an OTP from your email. Please check your inbox."
        });
    }

    try {
        // Pre-check: Target user existence and co-super_admin protection
        const { data: targetUser, error: targetLookupErr } = await supabase
            .from("system_users")
            .select("id, username, role")
            .eq("id", targetUserId)
            .maybeSingle();

        if (targetLookupErr || !targetUser) {
            return res.status(404).json({ error: "Target user not found" });
        }

        if (targetUser.role === "super_admin" && req.user.id !== targetUserId) {
            return res.status(403).json({
                error: "Forbidden. A super admin cannot change or edit the role of a co-super admin."
            });
        }

        if (targetUserId === req.user.id && new_role === "super_admin") {
            return res.status(400).json({ error: "You are already a super_admin." });
        }

        // Step 1: Re-verify caller's own password via Supabase Auth
        const { error: reAuthError } = await supabase.auth.signInWithPassword({
            email:    req.user.email,
            password: password
        });

        if (reAuthError) {
            return res.status(401).json({ error: "Password confirmation failed. Role not changed." });
        }

        let supabaseAuthConfirmed = false;

        // Step 2: If promoting to super_admin — verify OTP via Supabase Auth
        if (new_role === "super_admin") {
            const { error: otpError } = await supabase.auth.verifyOtp({
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

        // Step 3: Call change_user_role() which enforces last super_admin check and writes audit log
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

        console.log(`🔒 Role change: user ${targetUserId} → ${new_role} by ${req.user.username}`);

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
        const { error } = await supabase.auth.signInWithOtp({
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
