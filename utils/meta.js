const axios = require("axios");
const supabase = require("../supabase/client");

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v25.0";
const PAGE_ID = process.env.FB_PAGE_ID;

// ── In-memory profile cache ───────────────────────────────────────────────────
// Avoids hitting Meta's Graph API rate limits for repeat messages from the same
// user within a single server process lifetime.
const profileCache = new Map();

/**
 * Fetch a Messenger user's real name.
 * 1. In-memory profileCache
 * 2. Supabase conversations history check
 * 3. Direct PSID query (works if user is app tester/admin or User Profile API is granted)
 * 4. Page conversations participants fallback (works without Advanced User Profile API permissions)
 *
 * @param {string} senderPSID        - Page-Scoped User ID from the webhook event.
 * @param {string} [accessToken]     - Optional override; defaults to PAGE_ACCESS_TOKEN env var.
 * @returns {Promise<{ name: string, firstName: string, lastName: string }>}
 */
async function getUserProfile(senderPSID, accessToken) {
    // 1. Return cached result if already fetched this session
    if (profileCache.has(senderPSID)) {
        return profileCache.get(senderPSID);
    }

    // 2. Check Supabase if this user already has a valid saved name
    try {
        const { data: existing } = await supabase
            .from("conversations")
            .select("sender_name")
            .eq("sender_psid", senderPSID)
            .neq("sender_name", `User ${senderPSID.slice(-4)}`)
            .neq("sender_name", "Unknown User")
            .not("sender_name", "is", null)
            .order("timestamp", { ascending: false })
            .limit(1);

        if (existing && existing.length > 0 && existing[0].sender_name) {
            const fullName = existing[0].sender_name;
            const parts = fullName.split(" ");
            const profile = {
                firstName: parts[0] || fullName,
                lastName: parts.slice(1).join(" "),
                name: fullName
            };
            profileCache.set(senderPSID, profile);
            console.log(`👤 Profile found in DB: ${profile.name} (PSID: ${senderPSID})`);
            return profile;
        }
    } catch (dbErr) {
        // Continue to Graph API if DB check fails
    }

    // PSIDs require the Page Access Token of the connected page to resolve names
    const token = accessToken || process.env.PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;

    // 3. Try direct PSID lookup
    try {
        const { data } = await axios.get(
            `https://graph.facebook.com/${GRAPH_VERSION}/${senderPSID}`,
            {
                params: {
                    fields: "first_name,last_name",
                    access_token: token
                }
            }
        );

        if (data.first_name || data.last_name) {
            const profile = {
                firstName: data.first_name || "",
                lastName: data.last_name || "",
                name: `${data.first_name || ""} ${data.last_name || ""}`.trim()
            };
            profileCache.set(senderPSID, profile);
            console.log(`👤 Profile fetched (direct): ${profile.name} (PSID: ${senderPSID})`);
            return profile;
        }
    } catch (err) {
        // Direct PSID lookup often returns "Unsupported get request" for users without App Review
    }

    // 4. Fallback: Search participants via Page inbox conversations (paginated)
    try {
        const pageId = process.env.FB_PAGE_ID || PAGE_ID;
        let url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/conversations`;
        let params = { fields: "participants", access_token: token };
        const MAX_PAGES = 5; // Safety limit — up to ~125 conversations

        for (let page = 0; page < MAX_PAGES; page++) {
            const { data } = await axios.get(url, { params });

            for (const convo of data.data || []) {
                for (const p of convo.participants?.data || []) {
                    if (p.id === senderPSID && p.name) {
                        const fullName = p.name;
                        const parts = fullName.split(" ");
                        const profile = {
                            firstName: parts[0] || fullName,
                            lastName: parts.slice(1).join(" "),
                            name: fullName
                        };
                        profileCache.set(senderPSID, profile);
                        console.log(`👤 Profile fetched (via Page conversations, page ${page + 1}): ${profile.name} (PSID: ${senderPSID})`);
                        return profile;
                    }
                }
            }

            // Follow pagination cursor if available
            const nextUrl = data.paging?.next;
            if (!nextUrl) break;
            url = nextUrl;
            params = {}; // next URL already includes all params
        }
    } catch (convoErr) {
        const reason = convoErr.response?.data?.error?.message || convoErr.message;
        console.warn(`⚠️  Could not fetch /conversations for PSID ${senderPSID}: ${reason}`);
    }

    // Graceful fallback — bot continues running even if profile fetch fails
    const fallbackProfile = {
        firstName: "",
        lastName: "",
        name: null,
        profilePic: null
    };
    return fallbackProfile;
}

module.exports = { getUserProfile };
