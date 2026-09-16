/**
 * scripts/inspect-samples.js
 *
 * Audits the exported NLP training dataset and prints:
 *   1. Volume summary per source
 *   2. Language distribution (Tagalog / English / Taglish heuristic)
 *   3. Empty-text warnings
 *   4. Barangay coverage
 *   5. Incident type distribution
 *   6. Random sample rows (5 per source)
 *
 * Must be run AFTER export-dataset.js has produced datasets/merged_training.jsonl
 *
 * Usage:
 *   node scripts/inspect-samples.js
 *   node scripts/inspect-samples.js --samples 10   (rows to preview per source)
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const readline = require("readline");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const getArg     = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const SAMPLE_N   = parseInt(getArg("--samples", "5"), 10);
const MERGED_FILE = path.resolve(__dirname, "../datasets/merged_training.jsonl");

// ── Language heuristics ───────────────────────────────────────────────────────

/**
 * Very lightweight Tagalog/Taglish/English classifier.
 * Based on high-frequency Tagalog function words.
 * Returns: "tagalog" | "taglish" | "english" | "unknown"
 */
const TAGALOG_KEYWORDS = new Set([
    "po", "ho", "ang", "ng", "mga", "sa", "na", "at", "ay", "ito",
    "ako", "ikaw", "siya", "kami", "tayo", "kayo", "sila",
    "hindi", "oo", "opo", "hinde", "wala", "meron", "mayroon",
    "sunog", "baha", "lindol", "bagyo", "aksidente", "tulungan",
    "tulong", "rescue", "pwede", "para", "pero", "kasi", "dahil",
    "parang", "naman", "talaga", "lang", "din", "rin", "dito",
    "doon", "dyan", "punta", "pumunta", "may", "malapit", "malayo",
    "barangay", "brgy", "purok", "sitio", "kapitbahay", "kapitbahayan",
    "namatay", "nasugatan", "natrapik", "naka", "nakita", "narinig"
]);

const ENGLISH_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "i", "you", "we",
    "they", "it", "my", "your", "our", "their", "this", "that",
    "please", "help", "fire", "flood", "earthquake", "accident",
    "near", "here", "there", "need", "want", "can", "have"
]);

function detectLanguage(text) {
    if (!text || text.trim().length === 0) return "unknown";
    const tokens = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return "unknown";

    let tagCount = 0;
    let engCount = 0;
    for (const t of tokens) {
        if (TAGALOG_KEYWORDS.has(t)) tagCount++;
        if (ENGLISH_WORDS.has(t))    engCount++;
    }

    const tagRatio = tagCount / tokens.length;
    const engRatio = engCount / tokens.length;

    if (tagRatio > 0.1 && engRatio > 0.05) return "taglish";
    if (tagRatio > 0.08)  return "tagalog";
    if (engRatio > 0.1)   return "english";
    return "unknown";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJSONL(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`❌  File not found: ${filePath}`);
        console.error(`    Run \`node scripts/export-dataset.js\` first.`);
        process.exit(1);
    }

    const lines  = fs.readFileSync(filePath, "utf8").split("\n").filter(l => l.trim());
    const parsed = [];
    for (const line of lines) {
        try { parsed.push(JSON.parse(line)); }
        catch (_) { /* skip malformed lines */ }
    }
    return parsed;
}

/** Pick N evenly-spaced random elements from an array. */
function sample(arr, n) {
    if (arr.length <= n) return [...arr];
    const result = [];
    const step = Math.floor(arr.length / n);
    for (let i = 0; i < n; i++) result.push(arr[i * step]);
    return result;
}

/** Simple bar chart using block characters. */
function bar(value, max, width = 30) {
    const filled = Math.round((value / Math.max(max, 1)) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Format a count + percentage. */
function pct(count, total) {
    return `${count.toString().padStart(6)} (${((count / Math.max(total, 1)) * 100).toFixed(1).padStart(5)}%)`;
}

/** Truncate a string for display. */
function trunc(s, len = 90) {
    if (!s) return "(empty)";
    return s.length > len ? s.slice(0, len - 3) + "…" : s;
}

// ── Analysis ──────────────────────────────────────────────────────────────────

function analyseSource(rows, sourceName) {
    const total       = rows.length;
    const emptyCnt    = rows.filter(r => !r.text || r.text.trim() === "").length;
    const langCounts  = { tagalog: 0, taglish: 0, english: 0, unknown: 0 };
    const barangayCnt = {};
    const incidentCnt = {};

    for (const row of rows) {
        const lang = detectLanguage(row.text);
        langCounts[lang]++;

        if (row.barangay && row.barangay !== "Unknown") {
            barangayCnt[row.barangay] = (barangayCnt[row.barangay] || 0) + 1;
        }
        if (row.incident_type) {
            const key = String(row.incident_type) || "null";
            incidentCnt[key] = (incidentCnt[key] || 0) + 1;
        }
    }

    // Sort barangay and incident counts
    const topBarangays = Object.entries(barangayCnt).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const topIncidents = Object.entries(incidentCnt).sort((a, b) => b[1] - a[1]).slice(0, 8);

    console.log(`\n${"═".repeat(66)}`);
    console.log(`  Source: ${sourceName.toUpperCase()}   (${total} rows)`);
    console.log(`${"═".repeat(66)}`);

    // Volume + empties
    console.log(`\n  📊  Volume`);
    console.log(`      Total rows   : ${total}`);
    console.log(`      Empty texts  : ${emptyCnt}  ${emptyCnt > 0 ? "⚠️" : "✅"}`);

    // Language distribution
    console.log(`\n  🌐  Language Distribution`);
    const maxLang = Math.max(...Object.values(langCounts));
    for (const [lang, cnt] of Object.entries(langCounts)) {
        console.log(`      ${lang.padEnd(10)} ${bar(cnt, maxLang, 25)}  ${pct(cnt, total)}`);
    }

    // Barangay coverage
    if (topBarangays.length > 0) {
        console.log(`\n  📍  Top Barangays`);
        const maxB = topBarangays[0][1];
        for (const [brgy, cnt] of topBarangays) {
            console.log(`      ${String(brgy).padEnd(20)} ${bar(cnt, maxB, 20)}  ${cnt}`);
        }
        const untagged = rows.filter(r => !r.barangay || r.barangay === "Unknown").length;
        console.log(`      (untagged: ${untagged})`);
    } else {
        console.log(`\n  📍  Barangay: not tracked in this source.`);
    }

    // Incident types
    if (topIncidents.length > 0) {
        console.log(`\n  🚨  Incident Types`);
        const maxI = topIncidents[0][1];
        for (const [type, cnt] of topIncidents) {
            console.log(`      ${String(type).padEnd(20)} ${bar(cnt, maxI, 20)}  ${cnt}`);
        }
    }

    // Sample rows
    console.log(`\n  📝  Sample Rows (${SAMPLE_N} of ${total})`);
    const samples = sample(rows, SAMPLE_N);
    for (let i = 0; i < samples.length; i++) {
        const r = samples[i];
        console.log(`\n  [${i + 1}] id       : ${r.id}`);
        console.log(`      author   : ${r.author || "(none)"}`);
        console.log(`      timestamp: ${r.timestamp || "(none)"}`);
        console.log(`      language : ${detectLanguage(r.text)}`);
        console.log(`      text     : ${trunc(r.text)}`);
        if (r.barangay)      console.log(`      barangay : ${r.barangay}`);
        if (r.incident_type !== undefined && r.incident_type !== null)
            console.log(`      incident : ${r.incident_type}`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║          Responde NLP Dataset Inspector                         ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");
    console.log(`  Reading: ${MERGED_FILE}\n`);

    const rows = readJSONL(MERGED_FILE);

    if (rows.length === 0) {
        console.error("⚠️  merged_training.jsonl is empty. Run the export script first.");
        process.exit(0);
    }

    // Overall summary
    const sources = ["messenger", "fb_comment", "fb_post"];
    const grouped = {};
    for (const s of sources) grouped[s] = rows.filter(r => r.source === s);

    console.log("╔══════════════════════════════════════════════╗");
    console.log("║              Overall Volume                  ║");
    console.log("╚══════════════════════════════════════════════╝");
    const maxVol = Math.max(...sources.map(s => grouped[s].length));
    for (const s of sources) {
        const cnt = grouped[s].length;
        console.log(`  ${s.padEnd(12)} ${bar(cnt, maxVol, 30)}  ${pct(cnt, rows.length)}`);
    }
    console.log(`  ${"─".repeat(55)}`);
    console.log(`  ${"TOTAL".padEnd(12)} ${" ".repeat(32)} ${rows.length} rows`);

    // Per-source analysis
    for (const s of sources) {
        if (grouped[s].length > 0) {
            analyseSource(grouped[s], s);
        } else {
            console.log(`\n  ℹ️  ${s}: no rows found.`);
        }
    }

    // Overall language across all rows
    console.log(`\n${"═".repeat(66)}`);
    console.log("  OVERALL LANGUAGE DISTRIBUTION (all sources combined)");
    console.log(`${"═".repeat(66)}`);
    const allLang = { tagalog: 0, taglish: 0, english: 0, unknown: 0 };
    for (const r of rows) allLang[detectLanguage(r.text)]++;
    const maxL = Math.max(...Object.values(allLang));
    for (const [lang, cnt] of Object.entries(allLang)) {
        console.log(`  ${lang.padEnd(10)} ${bar(cnt, maxL, 30)}  ${pct(cnt, rows.length)}`);
    }

    // Annotation readiness check
    console.log(`\n${"═".repeat(66)}`);
    console.log("  ANNOTATION READINESS");
    console.log(`${"═".repeat(66)}`);
    const noBarangay = rows.filter(r => !r.barangay || r.barangay === "Unknown").length;
    const noIncident = rows.filter(r => !r.incident_type).length;
    const noIntent   = rows.filter(r => !r.intent).length;
    console.log(`  Rows missing barangay label   : ${noBarangay} / ${rows.length}`);
    console.log(`  Rows missing incident label   : ${noIncident} / ${rows.length}`);
    console.log(`  Rows missing intent label     : ${noIntent} / ${rows.length}`);
    console.log();
    if (noIntent === rows.length) {
        console.log("  ⚠️  No rows have been annotated yet.");
        console.log("     Next step: open datasets/merged_training.jsonl in Label Studio");
        console.log("     or run your annotation script to add intent / urgency / ner_spans.");
    } else {
        const annotated = rows.length - noIntent;
        console.log(`  ✅  ${annotated} rows already annotated (${((annotated/rows.length)*100).toFixed(1)}%)`);
    }
    console.log();
}

main();
