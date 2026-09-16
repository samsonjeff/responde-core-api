require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");
const axios = require("axios");

async function runDiagnostics() {
    console.log("=========================================");
    console.log("🔍 COMPREHENSIVE API KEYS & SERVICES DIAGNOSIS");
    console.log("=========================================\n");

    let hasErrors = false;

    // ── 1. Check Env Variables Presence ──────────────────
    console.log("1️⃣  Checking Environment Variables...");
    const requiredEnv = [
        "SUPABASE_URL",
        "SUPABASE_SERVICE_KEY",
        "PAGE_ACCESS_TOKEN",
        "FB_PAGE_ID"
    ];

    const missing = [];
    requiredEnv.forEach(env => {
        if (!process.env[env] || process.env[env].trim() === "") {
            missing.push(env);
        }
    });

    if (!process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY) {
        missing.push("GEMINI_API_KEYS (or GEMINI_API_KEY)");
    }

    if (missing.length > 0) {
        console.warn(`⚠️  Missing Environment Variables: ${missing.join(", ")}`);
        console.warn("💡 Make sure to set these up in your Render environment settings or local .env file.\n");
    } else {
        console.log("✅ All core environment variables are defined in configuration.\n");
    }

    // ── 2. Test Supabase Connection ─────────────────────
    console.log("2️⃣  Testing Supabase Connection & Schema...");
    try {
        const supabase = require("./supabase/client");

        const startTime = Date.now();
        const { data, error } = await supabase
            .from("conversations")
            .select("id")
            .limit(1);

        if (error) {
            throw error;
        }
        const latency = Date.now() - startTime;
        console.log(`✅ Supabase: Connected successfully! Latency: ${latency}ms`);
        console.log(`   URL: ${process.env.SUPABASE_URL}\n`);
    } catch (err) {
        hasErrors = true;
        console.error("❌ Supabase Test Failed:", err.message);
        console.error("💡 Check SUPABASE_URL and SUPABASE_SERVICE_KEY.\n");
    }

    // ── 3. Test Meta / Facebook Page Access Token ────────
    console.log("3️⃣  Testing Facebook / Meta Graph API Tokens...");
    try {
        if (!process.env.PAGE_ACCESS_TOKEN || !process.env.FB_PAGE_ID) {
            throw new Error("PAGE_ACCESS_TOKEN or FB_PAGE_ID is not set.");
        }
        const version = process.env.GRAPH_API_VERSION || "v25.0";
        const url = `https://graph.facebook.com/${version}/${process.env.FB_PAGE_ID}`;

        const startTime = Date.now();
        const res = await axios.get(url, {
            params: {
                fields: "id,name,link,is_published",
                access_token: process.env.PAGE_ACCESS_TOKEN
            },
            timeout: 8000
        });
        const latency = Date.now() - startTime;

        console.log(`✅ PAGE_ACCESS_TOKEN: Valid!`);
        console.log(`   Page Name: "${res.data.name}"`);
        console.log(`   Page ID:   ${res.data.id}`);
        console.log(`   Published: ${res.data.is_published ?? 'yes'}`);
        console.log(`   Latency:   ${latency}ms\n`);
    } catch (err) {
        hasErrors = true;
        const errMsg = err.response?.data?.error?.message || err.message;
        const errType = err.response?.data?.error?.type || "UnknownError";
        const errCode = err.response?.data?.error?.code || "";
        console.error(`❌ PAGE_ACCESS_TOKEN Test Failed [${errType} ${errCode}]:`, errMsg);
        console.error("💡 Verify PAGE_ACCESS_TOKEN and FB_PAGE_ID.\n");
    }

    // Check optional META_ACCESS_TOKEN
    if (process.env.META_ACCESS_TOKEN) {
        try {
            const version = process.env.GRAPH_API_VERSION || "v25.0";
            const res = await axios.get(`https://graph.facebook.com/${version}/me`, {
                params: { access_token: process.env.META_ACCESS_TOKEN },
                timeout: 8000
            });
            console.log(`✅ META_ACCESS_TOKEN: Valid! (User/Entity: "${res.data.name || res.data.id}")\n`);
        } catch (err) {
            const errMsg = err.response?.data?.error?.message || err.message;
            console.warn(`⚠️  META_ACCESS_TOKEN Check Warning:`, errMsg, "\n");
        }
    }

    // ── 4. Test Gemini API Keys (Individual Live Test for EACH key) ──────────
    console.log("4️⃣  Testing Gemini API Key Pool (Live individual test per key)...");
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const keys = raw.split(",").map(k => k.trim()).filter(Boolean);
    const modelName = process.env.GEMINI_MODEL || "models/gemini-3.6-flash";

    if (keys.length === 0) {
        hasErrors = true;
        console.error("❌ No Gemini API keys found. Set GEMINI_API_KEYS or GEMINI_API_KEY.\n");
    } else {
        console.log(`   Target Model: ${modelName}`);
        console.log(`   Testing ${keys.length} key(s) individually...\n`);

        const validKeys = [];
        const failedKeys = [];

        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const label = `Key-${String(i + 1).padStart(2, "0")}`;
            const masked = key.slice(0, 6) + "..." + key.slice(-4);

            try {
                const startTime = Date.now();
                const client = new GoogleGenAI({ apiKey: key });
                const result = await client.models.generateContent({
                    model: modelName,
                    contents: "Respond with single word: OK",
                    config: {
                        temperature: 0.1,
                        maxOutputTokens: 5
                    }
                });

                const latency = Date.now() - startTime;
                const text = result.text ? result.text.trim() : "";

                console.log(`   ✅ [${label}] ${masked} -> OK (${latency}ms) [Reply: "${text}"]`);
                validKeys.push(key);
            } catch (err) {
                const errMsg = err.message || String(err);
                let reason = "UNKNOWN_ERROR";
                let statusCode = err.status || err.code || "ERR";

                if (errMsg.includes("ACCOUNT_STATE_INVALID") || errMsg.includes("bound service account is deleted or disabled")) {
                    reason = "DISABLED_OR_DELETED_SERVICE_ACCOUNT (401)";
                } else if (errMsg.includes("API_KEY_INVALID") || errMsg.includes("401") || errMsg.includes("UNAUTHENTICATED")) {
                    reason = "INVALID_OR_EXPIRED_KEY (401)";
                } else if (errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("429") || errMsg.includes("quota")) {
                    reason = "RATE_LIMIT_OR_QUOTA_EXHAUSTED (429)";
                } else if (errMsg.includes("PERMISSION_DENIED") || errMsg.includes("403")) {
                    reason = "PERMISSION_DENIED (403)";
                } else if (errMsg.includes("NOT_FOUND") || errMsg.includes("404")) {
                    reason = "MODEL_NOT_FOUND_FOR_KEY (404)";
                }

                console.error(`   ❌ [${label}] ${masked} -> FAILED: [${reason}]`);
                console.error(`      Detail: ${errMsg.slice(0, 150)}...`);
                failedKeys.push({ index: i + 1, label, masked, key, reason, detail: errMsg });
            }
        }

        console.log(`\n   ── Gemini Pool Summary ──`);
        console.log(`   Total Keys:  ${keys.length}`);
        console.log(`   Working:     ${validKeys.length} / ${keys.length}`);
        console.log(`   Failed:      ${failedKeys.length} / ${keys.length}\n`);

        if (failedKeys.length > 0) {
            hasErrors = true;
            console.log("   ⚠️ Failed Keys to Remove or Replace:");
            failedKeys.forEach(f => {
                console.log(`      - ${f.label} (${f.masked}): ${f.reason}`);
            });
            console.log("\n   📋 Working Keys Comma-Separated (Ready for Render GEMINI_API_KEYS):");
            console.log(`   ${validKeys.join(",")}\n`);
        }
    }

    // ── 5. Test NLP Service (if configured) ─────────────
    console.log("5️⃣  Testing NLP Service (Optional)...");
    const nlpUrl = process.env.NLP_SERVICE_URL;
    if (nlpUrl) {
        try {
            const timeout = parseInt(process.env.NLP_TIMEOUT_MS) || 5000;
            const res = await axios.get(`${nlpUrl.replace(/\/$/, '')}/health`, { timeout });
            console.log(`✅ NLP Service is reachable at ${nlpUrl} (Status: ${res.status})\n`);
        } catch (err) {
            console.log(`ℹ️  NLP Service at ${nlpUrl} returned: ${err.message} (Will fallback to zero-shot Gemini pipeline if offline)\n`);
        }
    } else {
        console.log("ℹ️  NLP_SERVICE_URL not configured (System will use zero-shot Gemini pipeline).\n");
    }

    // ── Summary ─────────────────────────────────────────
    console.log("=========================================");
    if (hasErrors) {
        console.log("🔴 DIAGNOSTICS COMPLETED: Some keys/services require attention.");
        console.log("Check the summary above for actionable recommendations.");
    } else {
        console.log("🟢 ALL API KEYS & SERVICES ARE 100% OPERATIONAL & HEALTHY!");
    }
    console.log("=========================================");
}

runDiagnostics();
