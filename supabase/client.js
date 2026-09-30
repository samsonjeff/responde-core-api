require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL || "https://placeholder.supabase.co";
const key = process.env.SUPABASE_SERVICE_KEY || "placeholder-key";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.warn("⚠️ Warning: SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from environment variables.");
}

const supabase = createClient(url, key, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    }
});

function createEphemeralClient() {
    return createClient(url, key, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        }
    });
}

module.exports = supabase;
module.exports.supabase = supabase;
module.exports.createEphemeralClient = createEphemeralClient;
