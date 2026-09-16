require("dotenv").config();
const axios = require("axios");
const supabase = require("./supabase/client");
const { getUserProfile } = require("./utils/meta");

const PAGE_ID = process.env.FB_PAGE_ID || "1110390105498978";
const TOKEN = process.env.PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
const GRAPH_VERSION = process.env.FB_GRAPH_API_VERSION || "v25.0";

async function getParticipantsFromConversations() {
    const map = new Map();
    try {
        const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PAGE_ID}/conversations?fields=participants&access_token=${TOKEN}`;
        const { data } = await axios.get(url);
        for (const convo of data.data || []) {
            for (const p of convo.participants?.data || []) {
                if (p.id !== PAGE_ID && p.name) {
                    map.set(p.id, p.name);
                }
            }
        }
    } catch (e) {
        console.warn("⚠️ Could not fetch /conversations participants:", e.response?.data || e.message);
    }
    return map;
}

async function backfillNames() {
    console.log("🔄 Starting backfill for conversation sender names...");

    // 1. Fetch participants map from Meta Page conversations
    const participantMap = await getParticipantsFromConversations();
    console.log(`💬 Found ${participantMap.size} named participants from Page inbox.`);

    // 2. Fetch all unique sender_psid from Supabase
    const { data: rows, error } = await supabase
        .from("conversations")
        .select("sender_psid");

    if (error) {
        console.error("❌ Failed to query conversations:", error.message);
        process.exit(1);
    }

    const uniquePsids = [...new Set((rows || []).map(r => r.sender_psid).filter(Boolean))];
    console.log(`📋 Found ${uniquePsids.length} unique sender PSID(s) in Supabase.`);

    let updatedCount = 0;

    for (const psid of uniquePsids) {
        let name = participantMap.get(psid);

        // If not in participants map, try direct PSID profile lookup
        if (!name) {
            const profile = await getUserProfile(psid);
            if (profile && profile.name && !profile.name.startsWith("User ")) {
                name = profile.name;
            }
        }

        if (name) {
            const { error: updateError } = await supabase
                .from("conversations")
                .update({ sender_name: name })
                .eq("sender_psid", psid);

            if (updateError) {
                console.error(`❌ Failed to update PSID ${psid}:`, updateError.message);
            } else {
                console.log(`✅ Updated PSID ${psid} -> "${name}"`);
                updatedCount++;
            }
        } else {
            console.log(`⚠️ No name found for PSID ${psid}`);
        }
    }

    console.log(`\n🎉 Backfill complete! Successfully updated ${updatedCount} user(s).`);
}

backfillNames()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
