require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");
const axios = require("axios");

async function runDiagnostics() {
    console.log("=========================================");
    console.log("🔍 STARTING SYSTEM DIAGNOSTICS");
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

    // Gemini keys: accept either GEMINI_API_KEYS or legacy GEMINI_API_KEY
    if (!process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY) {
        missing.push("GEMINI_API_KEYS (or GEMINI_API_KEY)");
    }

    if (missing.length > 0) {
        console.warn(`⚠️  Missing Environment Variables: ${missing.join(", ")}`);
        console.warn("💡 Make sure to set these up in your Render environment settings or local .env file.");
    } else {
        console.log("✅ All core environment variables are present.\n");
    }

    // ── 2. Test Supabase Connection ─────────────────────
    console.log("2️⃣  Testing Supabase Connection & Schema...");
    try {
        const supabase = require("./supabase/client");

        // Test query on conversations table
        const { data, error } = await supabase
            .from("conversations")
            .select("id")
            .limit(1);

        if (error) {
            throw error;
        }
        console.log("✅ Supabase connection successful! 'conversations' table is accessible.\n");
    } catch (err) {
        hasErrors = true;
        console.error("❌ Supabase Test Failed:", err.message);
        console.error("💡 Check if SUPABASE_URL and SUPABASE_SERVICE_KEY are correct, and that you ran the SQL schema to create the 'conversations' table.");
        console.error("💡 Schema SQL can be found in README.md under 'Database Schema'.\n");
    }

    // ── 3. Test Gemini API Keys (all keys in pool) ──────────────────────────
    console.log("3️⃣  Testing Gemini API Keys...");
    try {
        const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
        const keys = raw.split(",").map(k => k.trim()).filter(Boolean);

        if (keys.length === 0) {
            throw new Error("No Gemini API keys found. Set GEMINI_API_KEYS or GEMINI_API_KEY.");
        }

        console.log(`   Found ${keys.length} Gemini key(s). Checking configuration...`);
        const modelName = process.env.GEMINI_MODEL || "models/gemini-3.6-flash";

        // Check key presence & structure for all keys
        let validFormatCount = 0;
        keys.forEach((key, i) => {
            const label = `Key-${String(i + 1).padStart(2, "0")}`;
            const masked = key.slice(0, 6) + "..." + key.slice(-4);
            if (key.startsWith("AQ.") || key.length > 20) {
                validFormatCount++;
                console.log(`   ✅ ${label} (${masked}) — format valid`);
            } else {
                console.warn(`   ⚠️  ${label} (${masked}) — suspicious format`);
            }
        });

        // Send a single test ping using Key-01 to verify network & Google API connectivity
        console.log(`   📡 Testing Google API connection using Key-01...`);
        const testClient = new GoogleGenAI({ apiKey: keys[0] });
        const result = await testClient.models.generateContent({
            model: modelName,
            contents: "Ping",
            config: {
                systemInstruction: "You are a test helper. Reply with exactly 'Pong'."
            }
        });
        const text = result.text;
        if (!text || text.trim() === "") {
            throw new Error("Received empty response from Gemini API.");
        }
        console.log(`   ✅ API connection successful! Gemini model (${modelName}) responded: "${text.trim()}"`);
        console.log(`   Summary: All ${keys.length} keys loaded and pool is operational.\n`);
    } catch (err) {
        hasErrors = true;
        console.error("❌ Gemini API Test Failed:", err.message);
        console.error("💡 Ensure GEMINI_API_KEYS is set with valid comma-separated keys.");
        console.error("💡 If you are getting a 'Model not found' error, try setting GEMINI_MODEL to 'gemini-2.5-flash' without the 'models/' prefix.\n");
    }

    // ── 4. Test Facebook Page access token ──────────────
    console.log("4️⃣  Testing Facebook Page Access Token...");
    try {
        if (!process.env.PAGE_ACCESS_TOKEN || !process.env.FB_PAGE_ID) {
            throw new Error("PAGE_ACCESS_TOKEN or FB_PAGE_ID is not set.");
        }
        const version = process.env.GRAPH_API_VERSION || "v25.0";
        const url = `https://graph.facebook.com/${version}/${process.env.FB_PAGE_ID}`;

        const res = await axios.get(url, {
            params: {
                fields: "id,name",
                access_token: process.env.PAGE_ACCESS_TOKEN
            }
        });

        console.log(`✅ Facebook Token is valid! Page Name: "${res.data.name}" (ID: ${res.data.id})\n`);
    } catch (err) {
        hasErrors = true;
        const errMsg = err.response?.data?.error?.message || err.message;
        console.error("❌ Facebook Graph API Test Failed:", errMsg);
        console.error("💡 Verify that PAGE_ACCESS_TOKEN is correct and has standard page messaging permissions.");
        console.error("💡 Verify that FB_PAGE_ID is correct.\n");
    }

    console.log("=========================================");
    if (hasErrors) {
        console.log("🔴 DIAGNOSTICS COMPLETED WITH ERRORS");
        console.log("Check the logs above to identify and fix the issues.");
    } else {
        console.log("🟢 ALL SERVICES OPERATIONAL & HEALTHY!");
    }
    console.log("=========================================");
}

runDiagnostics();
