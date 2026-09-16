const { runScraper } = require("../routes/scraper");
const { runMessengerSync } = require("./messengerSync");
const supabase = require("../supabase/client");

let isScraping = false;
let isSyncing = false;

function startCronJobs() {
    // ── FB Scraper ────────────────────────────────────────────────────────────
    const scraperIntervalSec = parseInt(process.env.SCRAPER_INTERVAL_SECONDS || "300", 10);
    const scraperIntervalMs = Math.max(scraperIntervalSec, 10) * 1000; // min 10s

    console.log(`📰 Cron: FB Scraper scheduled (running every ${scraperIntervalSec}s)`);

    setInterval(async () => {
        if (isScraping) {
            console.log("⏳ Scraper: Previous scrape still in progress, skipping this tick...");
            return;
        }

        isScraping = true;
        console.log("⏰ Cron: Running scheduled FB Page scrape...");
        try {
            await runScraper();
        } catch (err) {
            console.error("❌ Cron scraper error:", err.message);
        } finally {
            isScraping = false;
        }
    }, scraperIntervalMs);

    // ── Messenger message sync ────────────────────────────────────────────────
    // Polls the Graph API to detect messages the user deleted/unsent.
    // Compares live thread MIDs against stored conversation_id values and
    // removes any rows whose messages no longer exist in Messenger.
    const syncIntervalSec = parseInt(process.env.MESSENGER_SYNC_INTERVAL_SECONDS || "300", 10);
    const syncIntervalMs = Math.max(syncIntervalSec, 30) * 1000; // min 30s

    console.log(`💬 Cron: Messenger sync scheduled (running every ${syncIntervalSec}s)`);

    // Run once immediately on startup to catch anything already deleted
    runMessengerSync().catch(err =>
        console.error("❌ Initial messenger sync error:", err.message)
    );

    setInterval(async () => {
        if (isSyncing) {
            console.log("⏳ MessengerSync: Previous sync still in progress, skipping...");
            return;
        }

        isSyncing = true;
        console.log("⏰ Cron: Running Messenger message sync...");
        try {
            await runMessengerSync();
        } catch (err) {
            console.error("❌ Cron messenger sync error:", err.message);
        } finally {
            isSyncing = false;
        }
    }, syncIntervalMs);
    // ── Dedup table cleanup ────────────────────────────────────────────────────
    const CLEANUP_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours
    const DEDUP_TTL_MINUTES = 60;                 // 1 hour TTL

    console.log(`🧹 Cron: Dedup cleanup scheduled (runs every 4 hours, purges >1 hour old)`);

    setInterval(async () => {
        try {
            const cutoff = new Date(Date.now() - DEDUP_TTL_MINUTES * 60 * 1000).toISOString();
            const { error, count } = await supabase
                .from("processed_messages")
                .delete()
                .lt("processed_at", cutoff);

            if (error) throw error;
            console.log(`🧹 Dedup cleanup: removed ${count ?? 0} stale entries.`);
        } catch (err) {
            console.error("❌ Dedup cleanup error:", err.message);
        }
    }, CLEANUP_INTERVAL_MS);
}

module.exports = { startCronJobs };


