/**
 * scripts/export-dataset.js
 *
 * Exports raw records from Supabase for NLP training:
 *   - conversations  → datasets/conversations.jsonl + datasets/conversations.csv
 *   - fb_comments    → datasets/fb_comments.jsonl   + datasets/fb_comments.csv
 *   - fb_posts       → datasets/fb_posts.jsonl      + datasets/fb_posts.csv
 *
 * Also writes a merged file: datasets/merged_training.jsonl
 * (all sources in a unified schema ready for annotation tooling)
 *
 * Usage:
 *   node scripts/export-dataset.js
 *   node scripts/export-dataset.js --limit 500   (default: all rows)
 *   node scripts/export-dataset.js --format csv  (csv | jsonl | both)  default: both
 */

"use strict";

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌  Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CLI args ──────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : def;
};

const LIMIT  = parseInt(getArg("--limit", "0"), 10);   // 0 = fetch ALL (paginated)
const FORMAT = getArg("--format", "both");              // csv | jsonl | both
const OUT_DIR = path.resolve(__dirname, "../datasets");

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Fetch ALL rows from a Supabase table using cursor-based pagination.
 * If `hardLimit` is set, stops after that many rows.
 */
async function fetchAll(table, columns = "*", hardLimit = 0) {
    const PAGE_SIZE = 1000;
    let allRows = [];
    let offset  = 0;

    while (true) {
        const remaining  = hardLimit > 0 ? hardLimit - allRows.length : PAGE_SIZE;
        const pageSize   = hardLimit > 0 ? Math.min(PAGE_SIZE, remaining) : PAGE_SIZE;

        const { data, error } = await supabase
            .from(table)
            .select(columns)
            .range(offset, offset + pageSize - 1);

        if (error) throw new Error(`[${table}] Supabase error: ${error.message}`);
        if (!data || data.length === 0) break;

        allRows = allRows.concat(data);
        offset += data.length;

        process.stdout.write(`\r  Fetched ${allRows.length} rows from ${table}…`);

        if (data.length < pageSize) break;                    // last page
        if (hardLimit > 0 && allRows.length >= hardLimit) break; // hit limit
    }

    console.log(); // newline after progress
    return allRows;
}

/** Escape a CSV field value. */
function csvField(val) {
    if (val === null || val === undefined) return "";
    const s = String(val).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
}

/** Convert an array of objects to CSV string. */
function toCSV(rows) {
    if (!rows.length) return "";
    const headers = Object.keys(rows[0]);
    const lines   = [headers.join(",")];
    for (const row of rows) {
        lines.push(headers.map(h => csvField(row[h])).join(","));
    }
    return lines.join("\n");
}

/** Write .jsonl – one JSON object per line. */
function writeJSONL(filePath, rows) {
    const content = rows.map(r => JSON.stringify(r)).join("\n");
    fs.writeFileSync(filePath, content, "utf8");
}

/** Write .csv */
function writeCSV(filePath, rows) {
    fs.writeFileSync(filePath, toCSV(rows), "utf8");
}

/**
 * Normalise a raw row into the unified training schema:
 * {
 *   source:     "messenger" | "fb_comment" | "fb_post"
 *   id:         unique row identifier
 *   text:       the raw user text to train on
 *   author:     display name of the sender / commenter
 *   timestamp:  ISO string
 *   barangay:   string | null
 *   incident_type: string | null
 *   -- annotation placeholders (fill in later) --
 *   intent:     null
 *   urgency:    null
 *   ner_spans:  null
 * }
 */
function normaliseConversation(row) {
    return {
        source:        "messenger",
        id:            row.conversation_id,
        text:          row.user_message || "",
        author:        row.sender_name  || "Unknown",
        timestamp:     row.timestamp,
        barangay:      null,
        incident_type: null,
        // annotation placeholders
        intent:        null,
        urgency:       null,
        ner_spans:     null,
        // extra context
        ai_reply:      row.ai_reply     || "",
        provider:      row.provider     || ""
    };
}

function normaliseFbComment(row) {
    return {
        source:        "fb_comment",
        id:            row.id,
        text:          row.comment_text || "",
        author:        row.user_name    || "Unknown",
        timestamp:     row.comment_date
                           ? `${row.comment_date}T${row.comment_time || "00:00:00"}`
                           : null,
        barangay:      row.barangay      || null,
        incident_type: row.incident_type || null,
        // annotation placeholders
        intent:        null,
        urgency:       null,
        ner_spans:     null
    };
}

function normaliseFbPost(row) {
    return {
        source:        "fb_post",
        id:            row.id,
        text:          row.caption  || "",
        author:        null,
        timestamp:     row.post_date || null,
        barangay:      row.barangay  || null,
        incident_type: null,
        // annotation placeholders
        intent:        null,
        urgency:       null,
        ner_spans:     null
    };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    ensureDir(OUT_DIR);

    console.log("╔══════════════════════════════════════════════╗");
    console.log("║     Responde NLP Dataset Export Tool         ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log(`  Output dir : ${OUT_DIR}`);
    console.log(`  Row limit  : ${LIMIT > 0 ? LIMIT : "ALL (paginated)"}`);
    console.log(`  Format     : ${FORMAT}`);
    console.log();

    const results = {};

    // ── 1. conversations ──────────────────────────────────────────────────────
    console.log("📨  Exporting conversations…");
    const convRows = await fetchAll(
        "conversations",
        "conversation_id, sender_name, user_message, ai_reply, provider, timestamp",
        LIMIT
    );
    results.conversations = convRows;
    const convNorm = convRows.map(normaliseConversation);

    if (FORMAT !== "csv") {
        writeJSONL(path.join(OUT_DIR, "conversations.jsonl"), convRows);
        console.log(`  ✅  conversations.jsonl  (${convRows.length} rows)`);
    }
    if (FORMAT !== "jsonl") {
        writeCSV(path.join(OUT_DIR, "conversations.csv"), convRows);
        console.log(`  ✅  conversations.csv    (${convRows.length} rows)`);
    }

    // ── 2. fb_comments ────────────────────────────────────────────────────────
    console.log("\n💬  Exporting fb_comments…");
    const commentRows = await fetchAll(
        "fb_comments",
        "id, post_id, user_name, comment_text, comment_date, comment_time, barangay, incident_type, created_at",
        LIMIT
    );
    results.fb_comments = commentRows;
    const commentNorm = commentRows.map(normaliseFbComment);

    if (FORMAT !== "csv") {
        writeJSONL(path.join(OUT_DIR, "fb_comments.jsonl"), commentRows);
        console.log(`  ✅  fb_comments.jsonl   (${commentRows.length} rows)`);
    }
    if (FORMAT !== "jsonl") {
        writeCSV(path.join(OUT_DIR, "fb_comments.csv"), commentRows);
        console.log(`  ✅  fb_comments.csv     (${commentRows.length} rows)`);
    }

    // ── 3. fb_posts ───────────────────────────────────────────────────────────
    console.log("\n📄  Exporting fb_posts…");
    const postRows = await fetchAll(
        "fb_posts",
        "id, caption, post_date, barangay, created_at",
        LIMIT
    );
    results.fb_posts = postRows;
    const postNorm = postRows.map(normaliseFbPost);

    if (FORMAT !== "csv") {
        writeJSONL(path.join(OUT_DIR, "fb_posts.jsonl"), postRows);
        console.log(`  ✅  fb_posts.jsonl      (${postRows.length} rows)`);
    }
    if (FORMAT !== "jsonl") {
        writeCSV(path.join(OUT_DIR, "fb_posts.csv"), postRows);
        console.log(`  ✅  fb_posts.csv        (${postRows.length} rows)`);
    }

    // ── 4. Merged training file ───────────────────────────────────────────────
    console.log("\n🔀  Merging into unified training set…");
    const merged = [...convNorm, ...commentNorm, ...postNorm];
    writeJSONL(path.join(OUT_DIR, "merged_training.jsonl"), merged);
    console.log(`  ✅  merged_training.jsonl  (${merged.length} total rows)`);

    // ── 5. Summary ────────────────────────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║                   Summary                   ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log(`  conversations  : ${convRows.length.toString().padStart(6)} rows`);
    console.log(`  fb_comments    : ${commentRows.length.toString().padStart(6)} rows`);
    console.log(`  fb_posts       : ${postRows.length.toString().padStart(6)} rows`);
    console.log(`  ─────────────────────────────`);
    console.log(`  TOTAL          : ${merged.length.toString().padStart(6)} rows`);
    console.log();
    console.log(`  Run \`node scripts/inspect-samples.js\` to audit the exported data.`);
    console.log();
    console.log("  ℹ️  processed_messages was intentionally skipped:");
    console.log("     it only contains (mid, processed_at) — no text to train on.");
    console.log();
}

main().catch(err => {
    console.error("\n❌  Export failed:", err.message);
    process.exit(1);
});
