require("dotenv").config();
const axios = require("axios");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const supabase = require("./supabase/client");
const Conversation = require("./models/Conversation");
const { requireApiKey, verifyFacebookSignature } = require("./utils/auth");
const { getUserProfile } = require("./utils/meta");
const geminiPool = require("./utils/geminiKeyPool");
const nlpClient  = require("./utils/nlpClient");
const nlpWorker  = require("./jobs/nlpWorker");
const { detectBarangay, extractContacts, extractName } = require("./utils/extractors");

const app = express();

// ── Message Deduplication (Supabase-backed, multi-instance safe) ─────────────
// Uses the `processed_messages` table (PRIMARY KEY on mid) as a distributed
// lock.  If two instances race on the same mid, only one INSERT wins;
// the other gets PG error 23505 (unique_violation) and skips processing.
//
// Table DDL (already created in Supabase):
//   CREATE TABLE processed_messages (
//       mid          TEXT PRIMARY KEY,
//       processed_at TIMESTAMPTZ DEFAULT now()
//   );

/**
 * Atomically claims a message ID.
 * @returns {Promise<boolean>} true if this instance claimed it, false if already taken.
 */
async function tryClaimMessage(mid) {
    const { error } = await supabase
        .from("processed_messages")
        .insert({ mid });

    if (error?.code === "23505") return false; // duplicate — another instance beat us
    if (error) {
        // Non-dedup error (e.g. table missing): log and allow processing to continue
        console.error("⚠️  Dedup insert error (allowing through):", error.message);
    }
    return true;
}

// Trust reverse proxy headers (required for deployment platforms like Render/Heroku)
app.set("trust proxy", 1);

// ── Security Middleware ───────────────────────────────────────────────────────
app.use(helmet());

// Preserve raw body buffer for HMAC signature verification in webhooks
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// General rate limiter for standard endpoints
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // Limit each IP to 200 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." }
});
app.use(generalLimiter);

// Dedicated rate limiter for webhook endpoint
const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
});

const PORT = process.env.PORT || 3000;
const SYSTEM_PROMPT = process.env.BOT_SYSTEM_PROMPT || ` ikaw ay tagalog AI bot assistant ng MDRRMC Talisay Batangas 4220 Philippines. kailangan lamang mag tanong at kumuha ng detalye, katulad ng mga:

- tunay na pangalan ng user,
- barangay sa Talisay Batangas,
- landmark o lugar na malapit sa lokasyon,
- numero o contact,
- tulong na kailangan(rescue, medical, emergency, supply at pagkain, at iba pa)

Pag - katapos mag tanong ipapaalala kay user na siguraduhing tama ang mga detalye.
dahil ito ang basihan ng amin team sa pag - sasagawa ng aksyon, na naka depende sa kailangan ng user.
naka focus lamang ang aming team sa mga nasalanta na dulot ng bagyo, lindol, pag - putok ng bulkang Taal, at natural na kalamidad sa Talisay Batangas 4220 Philippines.
Maging maikli at panatilihin ang iyong mga sagot sa ilalim ng 300 na letra(characters).`;

// ── Supabase Connection ───────────────────────────────────────────────────────
console.log("🗄️  Supabase client initialised ✅");
console.log(`   URL : ${process.env.SUPABASE_URL}`);

// ── FB Page Scraper ──────────────────────────────────────────────────────────
app.use("/scraper", require("./routes/scraper"));
const { startCronJobs } = require("./jobs/cron");
startCronJobs();


// ── Health Check ─────────────────────────────────────────────────────────────
// GET / → safe health check status
app.get("/", (req, res) => {
    res.json({
        status: "healthy",
        service: "responde-backend",
        timestamp: new Date().toISOString()
    });
});

// ── Protected Debug / Inspection API ─────────────────────────────────────────
// GET /api/debug/conversations (Requires x-api-key header)
app.get("/api/debug/conversations", requireApiKey, async (req, res) => {
    try {
        const { psid, limit = 100 } = req.query;

        // Fetch bot conversations from Supabase
        let convQuery = supabase
            .from("conversations")
            .select("*")
            .order("timestamp", { ascending: false })
            .limit(parseInt(limit));

        if (psid) convQuery = convQuery.eq("sender_psid", psid);
        const { data: conversations } = await convQuery;

        // Fetch scraped posts
        const { data: posts } = await supabase
            .from("fb_posts")
            .select("*")
            .order("post_date", { ascending: false })
            .limit(parseInt(limit));

        // Fetch scraped comments
        const { data: comments } = await supabase
            .from("fb_comments")
            .select("*")
            .order("comment_date", { ascending: false })
            .limit(parseInt(limit));

        return res.json({
            success: true,
            bot_conversations: {
                total: (conversations || []).length,
                data: conversations || []
            },
            scraped_posts: {
                total: (posts || []).length,
                data: posts || []
            },
            scraped_comments: {
                total: (comments || []).length,
                data: comments || []
            }
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});


// ── Webhook verification (Meta GET challenge) ─────────────────────────────────
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
        console.log("Webhook verified ✅");
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ── Receive messages (Meta POST webhook) ──────────────────────────────────────
app.post("/webhook", webhookLimiter, verifyFacebookSignature, async (req, res) => {
    if (req.body.object !== "page") {
        return res.sendStatus(404);
    }

    res.status(200).send("EVENT_RECEIVED");

    for (const entry of req.body.entry || []) {
        for (const event of entry.messaging || []) {
            if (!event.sender?.id || !event.message?.text) continue;

            const senderPSID = event.sender.id;
            const userMessage = event.message.text;
            const mid = event.message?.mid;

            // ── Dedup: skip if another instance (or a retry) already claimed this mid ──
            if (mid) {
                const claimed = await tryClaimMessage(mid);
                if (!claimed) {
                    console.log(`⏭️  Skipping duplicate message ${mid} from ${senderPSID}`);
                    continue;
                }
            }

            try {
                // Fetch sender's real name & profile pic from Meta Graph API
                const profile = await getUserProfile(senderPSID);

                const { reply: rawReply, provider } = await generateAiResponse(userMessage, senderPSID, profile.name);
                const reply = stripMarkdown(rawReply);
                // Use Facebook message ID if available, otherwise generate a UUID
                const conversationId = event.message?.mid || crypto.randomUUID();

                // Determine the effective sender name to store
                // (will be overridden below if Express extracts a name from text)

                // ── Express-side entity extraction (always runs, no external call) ──
                // Reliable fallback for barangay / contacts / name even when
                // the Python ML server is unavailable.
                const exprBarangay  = detectBarangay(userMessage);  // "Unknown" if not found
                const exprContacts  = extractContacts(userMessage);  // [] if none found
                const exprName      = extractName(userMessage);       // null if no pattern matched

                // ── Independent status fields (per architecture spec) ─────────────
                // location_status: Express deterministic barangay extraction
                const locationStatus = (exprBarangay && exprBarangay !== "Unknown") ? "found" : "not_found";

                // Resolve effective sender name:
                //   1. Facebook profile name (if real)
                //   2. Name extracted from message text (e.g. "ako si Juan")
                //   3. Fall back to "Unknown User"
                const facebookName   = (profile.name && !profile.name.startsWith("User ")) ? profile.name : null;
                const effectiveName  = facebookName || exprName || "Unknown User";

                // ── Save conversation immediately (non-blocking for Facebook Messenger) ──
                // The database trigger will automatically enqueue an outbox job in public.nlp_jobs
                await Conversation.upsert({
                    conversationId,
                    senderPSID,
                    userMessage,
                    aiReply: reply,
                    provider,
                    senderName: effectiveName,
                    // Status fields — independent failure domains
                    mlStatus: "pending",
                    locationStatus,
                    needsReview: false,
                    lowConfidenceFields: null,
                    // NLP semantic fields — initially null, populated asynchronously by nlpWorker
                    intent: null,
                    urgency: null,
                    incidentType: null,
                    intentConfidence: null,
                    urgencyConfidence: null,
                    incidentTypeConfidence: null,
                    // Entity fields — sourced from Express deterministic regex
                    barangay: exprBarangay !== "Unknown" ? exprBarangay : null,
                    contactNumbers: exprContacts.length > 0 ? exprContacts : null,
                });

                // Immediately kick the background queue worker (non-blocking)
                nlpWorker.kick();

                console.log(
                    `📍 Entity: name="${effectiveName}" barangay="${exprBarangay}"` +
                    ` contacts=${exprContacts?.join(", ") || "none"}`
                );
                console.log(
                    `📊 Status: ml_status="pending" location_status="${locationStatus}"`
                );

                // If we resolved a real FB name, retroactively fix stale placeholder rows
                // for this PSID (handles server restarts where old rows still say "User XXXX")
                if (facebookName) {
                    supabase
                        .from("conversations")
                        .update({ sender_name: profile.name })
                        .eq("sender_psid", senderPSID)
                        .or(`sender_name.is.null,sender_name.eq.Unknown User,sender_name.like.User %`)
                        .then(({ error }) => {
                            if (error) console.warn("⚠️ Failed to backfill stale sender_name:", error.message);
                            else console.log(`🔄 Backfilled sender_name for PSID ${senderPSID} → "${profile.name}"`);
                        });
                }

                await sendMessage(senderPSID, reply);
            } catch (err) {
                console.error(`❌ Failed for ${senderPSID}:`, err.message);
                try {
                    await sendMessage(senderPSID, "Sorry, I'm having trouble responding right now.");
                } catch (sendErr) {
                    console.error("❌ Failed to send error message:", sendErr.message);
                }
            }
        }
    }
});

// ── Generate AI response with conversation context ────────────────────────────
async function generateAiResponse(userMessage, senderPSID, senderName) {
    // Check if we have a valid name (not null, not placeholder like "User 1234")
    const hasValidName = senderName && !senderName.startsWith("User ") && senderName !== "Unknown User";

    const personalizedPrompt = hasValidName
        ? `${SYSTEM_PROMPT}\n\nAng pangalan ng kausap mo ay "${senderName}". Gamitin ang kanyang pangalan sa pagbati o sagot nang may paggalang (halimbawa: "Magandang araw po, ${senderName}!"), ngunit HUWAG maglagay ng titulo o prefix tulad ng "G.", "Gng.", "Bb.", "Mr.", o "Ms.". Huwag mo na siyang hingan ng pangalan dahil may record na tayo nito.`
        : `${SYSTEM_PROMPT}\n\nWala pang record ng pangalan ang kausap mo sa system. Batiin lamang siya ng "Magandang araw po!" (HUWAG gumamit ng placeholder tulad ng "User", ID, o numero). Kasama sa mga hihingin mong detalye, siguraduhing magalang na hingin at itanong ang kanyang buong pangalan.`;
    // Fetch conversation history for context
    const { data: history } = await supabase
        .from("conversations")
        .select("user_message, ai_reply")
        .eq("sender_psid", senderPSID)
        .order("timestamp", { ascending: false })
        .limit(10);

    const contextMessages = (history || []).reverse().map(h =>
        `User: ${h.user_message}\nBot: ${h.ai_reply}`
    ).join("\n---\n");

    const contextPrompt = contextMessages
        ? `Previous conversation:\n${contextMessages}\n\nNow respond to:`
        : "First message from user. Respond to:";

    // ── Gemini Multi-Key Pool ────────────────────────────────────────────────
    const maxAttempts = Math.min(geminiPool.pool.length, 3);
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let client, keyIndex;
        try {
            const keyInfo = geminiPool.getNextClient();
            client = keyInfo.client;
            keyIndex = keyInfo.keyIndex;
        } catch (poolErr) {
            console.warn(`⚠️ Pool error: ${poolErr.message}`);
            throw poolErr;
        }

        try {
            console.log(`🤖 Requesting Gemini (attempt ${attempt + 1}/${maxAttempts})...`);
            const result = await client.models.generateContent({
                model: process.env.GEMINI_MODEL || "models/gemini-2.5-flash",
                contents: `${contextPrompt}\n${userMessage}`,
                config: { systemInstruction: personalizedPrompt }
            });

            const reply = result.text;
            if (!reply) throw new Error("Empty response from Gemini");

            console.log("✅ Gemini responded.");
            return { reply, provider: "gemini" };
        } catch (geminiError) {
            lastError = geminiError;
            const is429 = geminiError.message?.includes('429') || geminiError.status === 429;
            const is503 = geminiError.message?.includes('503') || geminiError.status === 503;
            // 401 = key permanently invalid (deleted/disabled service account or project).
            // Disable the key for a long time and try the next one rather than aborting.
            const is401 = geminiError.message?.includes('401') || geminiError.status === 401 ||
                geminiError.message?.includes('UNAUTHENTICATED') ||
                geminiError.message?.includes('ACCOUNT_STATE_INVALID');

            if (is429 || is503) {
                geminiPool.markKeyCooldown(keyIndex);
                console.warn(`⚠️ Gemini key hit ${is429 ? '429' : '503'}. Trying next key in pool...`);
            } else if (is401) {
                // Disable permanently for this server session (24h cooldown)
                geminiPool.markKeyCooldown(keyIndex, 24 * 60 * 60 * 1000);
                console.error(`🔑 Gemini key ${keyIndex + 1} is invalid/disabled (401). Skipping to next key...`);
            } else {
                console.error(`❌ Gemini call failed: ${geminiError.message || geminiError}`);
                throw geminiError;
            }
        }
    }

    throw lastError || new Error("All Gemini attempts failed.");
}

// ── Strip markdown formatting for plain-text channels (e.g. Messenger) ─────────
function stripMarkdown(text) {
    return text
        // Remove <think>...</think> blocks (reasoning/thinking model output)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        // Remove formal prefixes like "G.", "Gng.", "Bb.", "Mr.", "Ms." before names
        .replace(/\b(G\.|Gng\.|Bb\.|Mr\.|Ms\.)\s+/gi, '')
        // Remove bold+italic: ***text*** or ___text___
        .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
        .replace(/___(.+?)___/g, '$1')
        // Remove bold: **text** or __text__
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        // Remove italic: *text* or _text_
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/_(.+?)_/g, '$1')
        // Remove bullet points: lines starting with * or - or +
        .replace(/^[\*\-\+]\s+/gm, '')
        // Remove numbered list dots: "1. ", "2. " etc.
        .replace(/^\d+\.\s+/gm, '')
        // Remove heading hashes: ## Heading
        .replace(/^#{1,6}\s+/gm, '')
        // Remove inline code backticks
        .replace(/`(.+?)`/g, '$1')
        // Collapse multiple blank lines into one
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── Send reply via Messenger ──────────────────────────────────────────────────
async function sendMessage(senderPSID, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || "v25.0"}/me/messages`,
            {
                recipient: { id: senderPSID },
                messaging_type: "RESPONSE",
                message: { text },
            },
            { params: { access_token: process.env.PAGE_ACCESS_TOKEN } }
        );
        console.log("📤 Reply sent ✅");
    } catch (error) {
        console.error("❌ Error sending reply:", error.response?.data || error.message);
    }
}

// ── API: Reset entire database ────────────────────────────────────────────────
app.post("/api/reset-database", requireApiKey, async (req, res) => {
    try {
        const { error, count } = await supabase
            .from("conversations")
            .delete()
            .neq("id", 0); // delete all rows

        if (error) throw new Error(error.message);

        console.log(`🗑️  Database reset! Deleted conversations from Supabase.`);
        res.json({
            success: true,
            message: `Database reset successfully! All conversations deleted.`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── API: Get full conversation history for a user ─────────────────────────────
app.get("/api/user-history/:senderPSID", requireApiKey, async (req, res) => {
    try {
        const { senderPSID } = req.params;
        const { limit = 50 } = req.query;

        const { data: history, error } = await supabase
            .from("conversations")
            .select("*")
            .eq("sender_psid", senderPSID)
            .order("timestamp", { ascending: true })
            .limit(parseInt(limit));

        if (error) throw new Error(error.message);

        // Format for NLP context
        const formattedHistory = (history || []).flatMap(msg => [
            {
                role: "user",
                content: msg.user_message,
                timestamp: msg.timestamp
            },
            {
                role: "assistant",
                content: msg.ai_reply,
                timestamp: msg.timestamp
            }
        ]);

        res.json({
            senderPSID,
            totalMessages: (history || []).length,
            conversationHistory: formattedHistory
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── NLP Retry / Backfill Mechanism (Unified via nlp_jobs queue) ───────────────
/**
 * Re-enqueues failed conversations into public.nlp_jobs and triggers worker processing.
 * @param {{ limit?: number, hoursAgo?: number }} options
 * @returns {Promise<{ re-enqueued: number, message: string }>}
 */
async function requeueFailedMlJobs({ limit = 50, hoursAgo = 24 } = {}) {
    const failedRecords = await Conversation.findFailedMl({ limit, hoursAgo });
    if (!failedRecords || failedRecords.length === 0) {
        return { reEnqueued: 0, message: "No failed ML records found to re-enqueue" };
    }

    console.log(`🔄 NLP Outbox Requeue: Enqueuing ${failedRecords.length} failed record(s)...`);
    let count = 0;

    for (const record of failedRecords) {
        const { error } = await supabase
            .from("nlp_jobs")
            .upsert({
                entity_type: "conversation",
                entity_id: record.conversation_id,
                source_text: record.user_message,
                status: "pending",
                attempts: 0,
                next_attempt_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: "entity_type,entity_id" });

        if (!error) count++;
    }

    // Trigger worker to process immediately
    nlpWorker.kick();

    return { reEnqueued: count, message: `Re-enqueued ${count} job(s) into nlp_jobs queue` };
}

// ── API: Retry failed ML classifications (re-enqueues and kicks worker) ───────
app.post("/api/nlp/retry", requireApiKey, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || req.body?.limit || "50", 10);
        const hoursAgo = parseInt(req.query.hoursAgo || req.body?.hoursAgo || "24", 10);
        const result = await requeueFailedMlJobs({ limit, hoursAgo });
        // Kick asynchronous processing so HTTP response returns immediately without timing out
        nlpWorker.kick();
        res.status(202).json({ success: true, accepted: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Periodic background check: reconcile any orphaned failed records into the outbox
const NLP_BACKFILL_INTERVAL_MS = parseInt(process.env.NLP_BACKFILL_INTERVAL_MS || "900000", 10);
if (NLP_BACKFILL_INTERVAL_MS > 0) {
    setInterval(async () => {
        try {
            await requeueFailedMlJobs({ limit: 25, hoursAgo: 24 });
        } catch (err) {
            console.warn("⚠️ Periodic NLP outbox reconciliation failed:", err.message);
        }
    }, NLP_BACKFILL_INTERVAL_MS);
}

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    const poolStatus = geminiPool.getPoolStatus();
    console.log(`🤖 AI Engine   : Gemini (${poolStatus.totalKeys} keys in pool, model: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"})`);
    console.log(`🔑 Verify token : ${process.env.VERIFY_TOKEN ? "CONFIGURED" : "NOT SET"}`);
    console.log(`🛡️  App secret   : ${process.env.APP_SECRET ? "CONFIGURED" : "NOT SET (Recommended for webhook verification)"}`);
    console.log(`📰 FB Scraper   : active (FB_PAGE_ID: ${process.env.FB_PAGE_ID || 'NOT SET'})`);

    // Check NLP microservice (non-blocking — server starts even if ML is down)
    const nlpUrl    = process.env.NLP_SERVICE_URL || "http://localhost:7860";
    const nlpOnline = await nlpClient.isHealthy().catch(() => false);
    if (nlpOnline) {
        console.log(`🧠 NLP Service  : ONLINE  (${nlpUrl})`);
    } else {
        console.log(`🧠 NLP Service  : OFFLINE (${nlpUrl}) — run: npm run ml:serve`);
    }
});