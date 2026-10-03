const nodemailer = require("nodemailer");
const crypto = require("crypto");
const supabase = require("../supabase/client");

// In-memory verification storage (fallback & fast validation)
// Key: challengeToken
const verificationStore = new Map();

// Periodic cleanup of expired verification entries every 2 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of verificationStore.entries()) {
        if (data.expiresAt < now) {
            verificationStore.delete(token);
        }
    }
}, 2 * 60 * 1000).unref();

/**
 * Configure Nodemailer transporter for Brevo SMTP.
 */
function getTransporter() {
    const host = process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com";
    const port = parseInt(process.env.BREVO_SMTP_PORT || "587", 10);
    const user = process.env.BREVO_USER || "bc51f1001@smtp-brevo.com";
    const pass = process.env.BREVO_SMTP_KEY;

    if (!pass) {
        console.warn("⚠️ BREVO_SMTP_KEY is not defined in environment variables!");
    }

    return nodemailer.createTransport({
        host,
        port,
        secure: false, // port 587 uses STARTTLS
        auth: { user, pass }
    });
}

/**
 * Mask an email address for privacy (e.g. s***k@gmail.com).
 */
function maskEmail(email) {
    if (!email || typeof email !== "string" || !email.includes("@")) return email || "";
    const [local, domain] = email.split("@");
    if (local.length <= 2) {
        return `${local[0]}*@${domain}`;
    }
    const maskedLocal = `${local[0]}${"*".repeat(Math.max(local.length - 2, 3))}${local[local.length - 1]}`;
    return `${maskedLocal}@${domain}`;
}

/**
 * Generate a cryptographically secure 6-digit numeric verification code.
 */
function generate6DigitCode() {
    return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Create a new verification challenge.
 * Returns { challengeToken, code, expiresAt, maskedEmail }
 */
async function createVerificationChallenge({ email, userId, purpose, metadata = {} }) {
    const code = generate6DigitCode();
    const challengeToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes TTL
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");

    const record = {
        challengeToken,
        email: email.toLowerCase().trim(),
        userId: userId || null,
        purpose, // 'login' | 'role_change' | 'settings_change'
        codeHash,
        metadata,
        expiresAt,
        attempts: 0
    };

    verificationStore.set(challengeToken, record);

    // Optional async write to Supabase if email_verifications table exists
    try {
        await supabase.from("email_verifications").insert({
            challenge_token: challengeToken,
            email: record.email,
            user_id: record.userId,
            purpose: record.purpose,
            code_hash: codeHash,
            expires_at: new Date(expiresAt).toISOString(),
            metadata: record.metadata
        });
    } catch {
        // Table may not exist yet, memory store acts as reliable source
    }

    return {
        challengeToken,
        code,
        expiresAt,
        maskedEmail: maskEmail(email)
    };
}

/**
 * Validate a submitted code against a challenge token.
 * Returns { valid: boolean, reason?: string, record?: object }
 */
async function validateVerificationCode({ challengeToken, code, purpose }) {
    if (!challengeToken || !code) {
        return { valid: false, reason: "Missing verification challenge or code" };
    }

    const cleanCode = code.toString().trim();
    let record = verificationStore.get(challengeToken);

    // If not in memory, try looking up in Supabase
    if (!record) {
        try {
            const { data } = await supabase
                .from("email_verifications")
                .select("*")
                .eq("challenge_token", challengeToken)
                .maybeSingle();

            if (data && new Date(data.expires_at).getTime() > Date.now()) {
                record = {
                    challengeToken: data.challenge_token,
                    email: data.email,
                    userId: data.user_id,
                    purpose: data.purpose,
                    codeHash: data.code_hash,
                    metadata: data.metadata || {},
                    expiresAt: new Date(data.expires_at).getTime(),
                    attempts: data.attempts || 0
                };
            }
        } catch {
            // Ignore DB error, proceed
        }
    }

    if (!record) {
        return { valid: false, reason: "Verification code has expired or is invalid. Please request a new code." };
    }

    if (purpose && record.purpose !== purpose) {
        return { valid: false, reason: "Invalid verification purpose." };
    }

    if (Date.now() > record.expiresAt) {
        verificationStore.delete(challengeToken);
        return { valid: false, reason: "Verification code has expired. Please request a new code." };
    }

    record.attempts += 1;
    if (record.attempts > 5) {
        verificationStore.delete(challengeToken);
        return { valid: false, reason: "Too many failed attempts. Please request a new verification code." };
    }

    const inputHash = crypto.createHash("sha256").update(cleanCode).digest("hex");
    const isMatch = crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(record.codeHash));

    if (!isMatch) {
        const remaining = 5 - record.attempts;
        return {
            valid: false,
            reason: `Incorrect verification code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
        };
    }

    // Success! Consume code (one-time use)
    verificationStore.delete(challengeToken);
    try {
        await supabase
            .from("email_verifications")
            .delete()
            .eq("challenge_token", challengeToken);
    } catch {}

    return { valid: true, record };
}

/**
 * Send an email verification code using Brevo SMTP.
 */
async function sendVerificationEmail({ to, code, purposeTitle, recipientName }) {
    const transporter = getTransporter();
    const senderEmail = process.env.BREVO_SENDER_EMAIL || "21-65955@g.batstate-u.edu.ph";
    const senderName = process.env.BREVO_SENDER_NAME || "Jefferson @ Responde";

    const title = purposeTitle || "Email Verification Code";
    const name = recipientName || "Authorized Personnel";

    const formattedCode = code.split("").join(" ");

    const fontStack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
    const monoStack = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace";

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
    </head>
    <body style="margin: 0; padding: 32px 16px; background-color: #f8fafc; font-family: ${fontStack}; -webkit-font-smoothing: antialiased;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="max-width: 520px; width: 100%; margin: 0 auto; background-color: #ffffff; border-radius: 14px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);">
        <!-- Header -->
        <tr>
          <td style="background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); padding: 32px 28px; text-align: center;">
            <div style="font-size: 24px; font-weight: 800; letter-spacing: 2px; color: #ffffff; margin: 0 0 4px 0;">RESPONDE</div>
            <div style="font-size: 13px; font-weight: 600; color: #93c5fd; letter-spacing: 0.5px; margin: 0 0 6px 0;">Jefferson @ Responde</div>
            <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #bfdbfe; font-weight: 500;">MDRRMO Talisay Batangas Command Center</div>
          </td>
        </tr>

        <!-- Content -->
        <tr>
          <td style="padding: 32px 28px;">
            <div style="font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 10px;">Hello, ${name}</div>
            <div style="font-size: 14px; line-height: 1.6; color: #475569; margin-bottom: 24px;">
              You requested a security verification code for <strong style="color: #0f172a;">${title}</strong>. Enter the 6-digit code below to complete your authorization:
            </div>

            <!-- OTP Code Box -->
            <div style="background-color: #eff6ff; border: 2px dashed #3b82f6; border-radius: 12px; padding: 22px 16px; text-align: center; margin-bottom: 24px;">
              <div style="font-family: ${monoStack}; font-size: 38px; font-weight: 800; letter-spacing: 12px; color: #1e3a8a; padding-left: 12px;">
                ${formattedCode}
              </div>
              <div style="font-size: 12px; font-weight: 600; color: #2563eb; margin-top: 10px; display: inline-block; background-color: #dbeafe; padding: 4px 12px; border-radius: 9999px;">
                ⏱ Expires in 10 minutes
              </div>
            </div>

            <!-- Security Notice -->
            <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 12px 14px; margin-top: 16px;">
              <div style="font-size: 12px; font-weight: 700; color: #92400e; margin-bottom: 4px;">Security Reminder</div>
              <div style="font-size: 12px; line-height: 1.5; color: #78350f;">
                Never share this code with anyone. MDRRMO personnel will never ask for your verification code. If you did not make this request, please contact your System Administrator immediately.
              </div>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 24px; text-align: center;">
            <div style="font-size: 11px; color: #64748b; line-height: 1.5; font-weight: 500;">
              Disaster Intake &amp; Geospatial Analytics System &bull; Talisay, Batangas 4220
            </div>
            <div style="font-size: 10px; color: #94a3b8; margin-top: 6px;">
              This is an automated system message, please do not reply directly to this email.
            </div>
          </td>
        </tr>
      </table>
    </body>
    </html>
    `;

    const mailOptions = {
        from: `"${senderName}" <${senderEmail}>`,
        to,
        subject: `[RESPONDE] ${title}: ${code}`,
        text: `Your Responde MDRRMO verification code for ${title} is: ${code}. It expires in 10 minutes.`,
        html: htmlContent
    };

    return await transporter.sendMail(mailOptions);
}

module.exports = {
    maskEmail,
    createVerificationChallenge,
    validateVerificationCode,
    sendVerificationEmail
};
