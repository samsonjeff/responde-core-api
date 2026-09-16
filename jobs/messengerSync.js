const axios = require("axios");
const supabase = require("../supabase/client");

const API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";

/**
 * Find the Messenger thread ID for a given sender PSID.
 * Uses GET /me/conversations?user_id={psid} to locate the thread.
 * @param {string} psid
 * @param {string} token
 * @returns {Promise<string|null>}
 */
async function findThreadIdForPSID(psid, token) {
    const res = await axios.get(
        `https://graph.facebook.com/${API_VERSION}/me/conversations`,
        { params: { user_id: psid, fields: "id", access_token: token } }
    );
    return res.data?.data?.[0]?.id || null;
}

/**
 * Fetch ALL message IDs (MIDs) in a Messenger thread, following pagination.
 * Returns a Set of MID strings.
 * @param {string} threadId
 * @param {string} token
 * @returns {Promise<Set<string>>}
 */
async function fetchLiveMids(threadId, token) {
    const mids = new Set();
    // Start with the thread's messages endpoint
    let nextUrl = `https://graph.facebook.com/${API_VERSION}/${threadId}/messages`;
    let params = { fields: "id", limit: 200, access_token: token };

    while (nextUrl) {
        const res = await axios.get(nextUrl, { params });
        const messages = res.data?.data || [];
        for (const msg of messages) mids.add(msg.id);

        // Follow pagination until all messages are fetched
        nextUrl = res.data?.paging?.next || null;
        params = {}; // next URL already contains all params
    }

    return mids;
}

/**
 * Core reconciliation logic:
 *  1. Load all unique sender PSIDs + their stored MIDs from the DB
 *  2. For each PSID, find the live Messenger thread via Graph API
 *  3. Fetch all live MIDs in that thread (with pagination)
 *  4. Any stored MID absent from the live thread = user deleted/unsent it
 *  5. Hard-delete those rows from the conversations table
 *
 * This approach is identical to how the scraper detects deleted FB comments —
 * compare what the API says exists vs what we have stored, prune the delta.
 *
 * @returns {Promise<{ checked: number, deleted: number }>}
 */
async function runMessengerSync() {
    const TOKEN = process.env.PAGE_ACCESS_TOKEN;
    if (!TOKEN) throw new Error("PAGE_ACCESS_TOKEN is not set");

    // ── Step 1: Load stored rows from the last 24 hours only ──────────────
    // Optimization: instead of syncing EVERY sender ever, we only check
    // senders with activity in the last 24 hours. This keeps API calls low
    // even as the database grows to thousands of historical conversations.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error: fetchErr } = await supabase
        .from("conversations")
        .select("sender_psid, conversation_id")
        .gte("timestamp", cutoff);

    if (fetchErr) throw new Error(`MessengerSync fetch error: ${fetchErr.message}`);
    if (!rows || rows.length === 0) {
        console.log("💬 MessengerSync: No conversations in DB — nothing to sync");
        return { checked: 0, deleted: 0 };
    }

    // Group stored MIDs by sender PSID
    const bySender = {};
    for (const row of rows) {
        if (!bySender[row.sender_psid]) bySender[row.sender_psid] = [];
        bySender[row.sender_psid].push(row.conversation_id);
    }

    console.log(`💬 MessengerSync: Checking ${Object.keys(bySender).length} sender(s)...`);
    let totalDeleted = 0;

    // ── Step 2: Per-sender reconciliation ────────────────────────────────────
    for (const [psid, storedMids] of Object.entries(bySender)) {
        try {
            // Find the live thread for this sender
            const threadId = await findThreadIdForPSID(psid, TOKEN);

            if (!threadId) {
                // Thread not found — the entire conversation may have been deleted
                // by the user. We treat this conservatively: remove all stored
                // messages for this sender since there is no active thread to match.
                console.log(`🗑️  MessengerSync: Thread gone for PSID ...${psid.slice(-4)} — removing all ${storedMids.length} stored message(s)`);
                await supabase
                    .from("conversations")
                    .delete()
                    .eq("sender_psid", psid);
                totalDeleted += storedMids.length;
                continue;
            }

            // Fetch all live MIDs from the thread (paginated)
            const liveMids = await fetchLiveMids(threadId, TOKEN);

            // Diff: stored MIDs that no longer exist in the live thread
            const deletedMids = storedMids.filter(mid => !liveMids.has(mid));

            if (deletedMids.length > 0) {
                const { error: delErr } = await supabase
                    .from("conversations")
                    .delete()
                    .in("conversation_id", deletedMids);

                if (delErr) throw new Error(delErr.message);

                console.log(`🗑️  MessengerSync: Removed ${deletedMids.length} unsent message(s) for PSID ...${psid.slice(-4)}`);
                totalDeleted += deletedMids.length;
            }

        } catch (err) {
            // Log per-sender errors but continue with the rest
            console.warn(`⚠️  MessengerSync: Skipping PSID ...${psid.slice(-4)}:`, err.message);
        }
    }

    console.log(`✅ MessengerSync: Done — ${totalDeleted} unsent message(s) pruned`);
    return { checked: Object.keys(bySender).length, deleted: totalDeleted };
}

module.exports = { runMessengerSync };
