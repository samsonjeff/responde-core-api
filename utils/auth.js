const crypto = require("crypto");

/**
 * Timing-safe string comparison using crypto.timingSafeEqual.
 * Prevents side-channel timing attacks when verifying secrets/keys.
 * @param {string} a 
 * @param {string} b 
 * @returns {boolean}
 */
function safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") {
        return false;
    }
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware: Requires a valid `x-api-key` header matching process.env.INTERNAL_API_KEY.
 */
function requireApiKey(req, res, next) {
    const configuredKey = process.env.INTERNAL_API_KEY;

    if (!configuredKey || configuredKey.trim() === "") {
        console.error("❌ Auth Error: INTERNAL_API_KEY is not configured in server environment variables!");
        return res.status(500).json({ error: "Server authentication misconfigured" });
    }

    const clientKey = req.headers["x-api-key"];

    if (!clientKey) {
        return res.status(401).json({ error: "Unauthorized: Missing x-api-key header" });
    }

    if (!safeEqual(clientKey, configuredKey)) {
        return res.status(403).json({ error: "Forbidden: Invalid API key" });
    }

    next();
}

/**
 * Middleware: Verifies the X-Hub-Signature-256 header sent by Meta/Facebook webhook POSTs.
 * Uses process.env.APP_SECRET to compute HMAC-SHA256 of the raw body payload.
 */
function verifyFacebookSignature(req, res, next) {
    let appSecret = process.env.APP_SECRET;

    // If APP_SECRET is configured, strictly enforce HMAC-SHA256 signature verification
    if (appSecret && appSecret.trim() !== "") {
        appSecret = appSecret.trim().replace(/^["']|["']$/g, "");
        const signatureHeader = req.headers["x-hub-signature-256"];

        if (!signatureHeader) {
            console.warn("⚠️ Webhook Warning: Missing X-Hub-Signature-256 header on POST /webhook");
            return res.status(401).send("Missing signature header");
        }

        const [prefix, signatureHash] = signatureHeader.split("=");
        if (prefix !== "sha256" || !signatureHash) {
            console.warn("⚠️ Webhook Warning: Malformed X-Hub-Signature-256 header");
            return res.status(400).send("Malformed signature header");
        }

        const rawBody = req.rawBody || (typeof req.body === "string" ? req.body : JSON.stringify(req.body));
        const expectedHash = crypto
            .createHmac("sha256", appSecret)
            .update(rawBody)
            .digest("hex");

        const cleanSignature = signatureHash.trim().toLowerCase();
        if (!safeEqual(cleanSignature, expectedHash)) {
            console.error("❌ Webhook Security: Signature mismatch for incoming webhook payload!");
            console.error("💡 Hint: Ensure process.env.APP_SECRET on Render exactly matches your Meta App Secret from Meta Developer Dashboard (App Settings -> Basic -> App Secret).");
            return res.status(403).send("Invalid webhook signature");
        }
    } else {
        // Warning logged once if APP_SECRET is missing
        if (!verifyFacebookSignature._warned) {
            console.warn("⚠️ Webhook Notice: APP_SECRET is not set in environment. Webhook signature validation is currently bypassed.");
            verifyFacebookSignature._warned = true;
        }
    }

    next();
}

module.exports = {
    safeEqual,
    requireApiKey,
    verifyFacebookSignature
};
