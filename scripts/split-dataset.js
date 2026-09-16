/**
 * scripts/split-dataset.js
 *
 * Splits datasets/annotated_dataset.jsonl into stratified train / val / test sets.
 *
 * Stratified on "incident_type" so rare classes (earthquake, typhoon, accident)
 * always appear in every split.  For groups with ≤ 5 rows the script guarantees
 * at least 1 row in val and 1 in test by pulling from what would have been train.
 *
 * Output (all written to datasets/):
 *   train.jsonl  +  train.csv
 *   val.jsonl    +  val.csv
 *   test.jsonl   +  test.csv
 *
 * Usage:
 *   npm run split:dataset
 *   node scripts/split-dataset.js
 *   node scripts/split-dataset.js --seed 42
 *   node scripts/split-dataset.js --ratio 70,15,15
 *   node scripts/split-dataset.js --overwrite
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : def;
};

const SEED      = parseInt(getArg("--seed", "12345"), 10);
const OVERWRITE = args.includes("--overwrite");

// Parse ratio  e.g. "80,10,10" → [0.80, 0.10, 0.10]
const ratioRaw   = getArg("--ratio", "80,10,10").split(",").map(Number);
const ratioTotal = ratioRaw.reduce((a, b) => a + b, 0);
const [TRAIN_RATIO, VAL_RATIO, TEST_RATIO] = ratioRaw.map(r => r / ratioTotal);

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATASETS_DIR   = path.resolve(__dirname, "../datasets");
const INPUT_FILE     = path.join(DATASETS_DIR, "annotated_dataset.jsonl");
const SPLIT_NAMES    = ["train", "val", "test"];

// ── Deterministic LCG RNG (no external deps) ─────────────────────────────────

/**
 * Linear Congruential Generator — deterministic pseudo-random number generator.
 * Returns a function that yields values in [0, 1).
 */
function makeLCG(seed) {
    // Constants from Numerical Recipes
    const M = 2 ** 31;
    const A = 1664525;
    const C = 1013904223;
    let state = seed >>> 0;
    return () => {
        state = ((A * state + C) >>> 0) % M;
        return state / M;
    };
}

/** Fisher-Yates shuffle using our seeded RNG */
function shuffle(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function csvEscape(val) {
    if (val === null || val === undefined) return "";
    if (typeof val === "object") val = JSON.stringify(val);
    const s = String(val).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
}

const CSV_HEADERS = ["id", "source", "author", "text", "intent", "urgency",
                     "incident_type", "barangay", "ner_spans", "timestamp"];

function toCSV(rows) {
    const lines = [CSV_HEADERS.join(",")];
    for (const row of rows) {
        lines.push(CSV_HEADERS.map(h => csvEscape(row[h])).join(","));
    }
    return lines.join("\n");
}

// ── Write helpers ─────────────────────────────────────────────────────────────

function writeFiles(name, rows) {
    const jsonlPath = path.join(DATASETS_DIR, `${name}.jsonl`);
    const csvPath   = path.join(DATASETS_DIR, `${name}.csv`);

    if (!OVERWRITE) {
        if (fs.existsSync(jsonlPath) || fs.existsSync(csvPath)) {
            console.error(`\n❌  Output file already exists: ${name}.jsonl / ${name}.csv`);
            console.error("    Use --overwrite to replace existing split files.\n");
            process.exit(1);
        }
    }

    fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join("\n"), "utf8");
    fs.writeFileSync(csvPath,   toCSV(rows),                                  "utf8");
}

// ── Stratified split ──────────────────────────────────────────────────────────

/**
 * Splits one group of rows into [train, val, test] while guaranteeing
 * at least minInVal rows in val and minInTest rows in test.
 */
function splitGroup(rows, rng, minInVal = 1, minInTest = 1) {
    const n = rows.length;

    // Calculate ideal counts
    let trainN = Math.floor(n * TRAIN_RATIO);
    let valN   = Math.floor(n * VAL_RATIO);
    let testN  = n - trainN - valN;  // absorbs rounding remainder

    // Guarantee minimums (deduct from train first, then val)
    if (valN < minInVal) {
        const deficit = minInVal - valN;
        valN   += deficit;
        trainN -= deficit;
    }
    if (testN < minInTest) {
        const deficit = minInTest - testN;
        testN  += deficit;
        trainN -= deficit;
    }
    // Safety net — if a group is so tiny that train would go negative
    if (trainN < 0) trainN = 0;

    const shuffled = shuffle(rows, rng);
    const train = shuffled.slice(0, trainN);
    const val   = shuffled.slice(trainN, trainN + valN);
    const test  = shuffled.slice(trainN + valN);

    return { train, val, test };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    // ── Banner ────────────────────────────────────────────────────────────────
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║      Responde NLP Dataset — Stratified Split Tool           ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");
    console.log(`  Input     : ${INPUT_FILE}`);
    console.log(`  Seed      : ${SEED}`);
    console.log(`  Ratios    : train=${(TRAIN_RATIO * 100).toFixed(0)}%  val=${(VAL_RATIO * 100).toFixed(0)}%  test=${(TEST_RATIO * 100).toFixed(0)}%`);
    console.log(`  Overwrite : ${OVERWRITE}\n`);

    // ── Load data ─────────────────────────────────────────────────────────────
    if (!fs.existsSync(INPUT_FILE)) {
        console.error(`❌  Input file not found: ${INPUT_FILE}`);
        console.error("    Run `npm run annotate:dataset` first.");
        process.exit(1);
    }

    const rawLines = fs.readFileSync(INPUT_FILE, "utf8")
        .split("\n")
        .filter(l => l.trim());

    const records = [];
    for (const line of rawLines) {
        try { records.push(JSON.parse(line)); }
        catch (_) { /* skip malformed JSONL lines */ }
    }

    console.log(`  📂  Loaded ${records.length} records from annotated_dataset.jsonl`);
    if (records.length === 0) {
        console.error("❌  No records found. Aborting.");
        process.exit(1);
    }

    // ── Skip the one known empty-text row ─────────────────────────────────────
    const valid   = records.filter(r => r.text && r.text.trim().length > 0);
    const skipped = records.length - valid.length;
    if (skipped > 0) {
        console.log(`  ⚠️   Skipped ${skipped} row(s) with empty/null text (will not appear in any split).`);
    }

    // ── Group by (incident_type, intent) composite key for joint stratification ──
    const groups = {};
    for (const rec of valid) {
        const key = (rec.incident_type || "none") + "__" + (rec.intent || "OTHER");
        if (!groups[key]) groups[key] = [];
        groups[key].push(rec);
    }

    // ── Stratified split ──────────────────────────────────────────────────────
    const rng = makeLCG(SEED);
    const splits = { train: [], val: [], test: [] };

    for (const [key, rows] of Object.entries(groups)) {
        // Guarantee at least 1 in val and 1 in test if group has at least 3 rows
        const minV = rows.length >= 3 ? 1 : 0;
        const minT = rows.length >= 3 ? 1 : (rows.length >= 2 ? 1 : 0);

        const { train, val, test } = splitGroup(rows, rng, minV, minT);
        splits.train.push(...train);
        splits.val.push(...val);
        splits.test.push(...test);
    }

    // Summary tables
    console.log("\n  📊  Split per incident_type:\n");
    console.log("  " + "Incident Type".padEnd(26) + "Total".padStart(6) +
                "Train".padStart(7) + "Val".padStart(6) + "Test".padStart(6));
    console.log("  " + "─".repeat(51));

    const incTotals = {};
    ["train", "val", "test"].forEach(sp => {
        splits[sp].forEach(r => {
            const t = r.incident_type || "none";
            if (!incTotals[t]) incTotals[t] = { Total: 0, train: 0, val: 0, test: 0 };
            incTotals[t][sp]++;
            incTotals[t].Total++;
        });
    });

    Object.keys(incTotals).sort().forEach(t => {
        const row = incTotals[t];
        console.log(
            "  " + t.padEnd(26) +
            String(row.Total).padStart(6) +
            String(row.train).padStart(7) +
            String(row.val).padStart(6) +
            String(row.test).padStart(6)
        );
    });

    console.log("\n  📊  Split per intent:\n");
    console.log("  " + "Intent".padEnd(26) + "Total".padStart(6) +
                "Train".padStart(7) + "Val".padStart(6) + "Test".padStart(6));
    console.log("  " + "─".repeat(51));

    const intentTotals = {};
    ["train", "val", "test"].forEach(sp => {
        splits[sp].forEach(r => {
            const it = r.intent || "OTHER";
            if (!intentTotals[it]) intentTotals[it] = { Total: 0, train: 0, val: 0, test: 0 };
            intentTotals[it][sp]++;
            intentTotals[it].Total++;
        });
    });

    Object.keys(intentTotals).sort().forEach(it => {
        const row = intentTotals[it];
        console.log(
            "  " + it.padEnd(26) +
            String(row.Total).padStart(6) +
            String(row.train).padStart(7) +
            String(row.val).padStart(6) +
            String(row.test).padStart(6)
        );
    });

    console.log("  " + "─".repeat(51));
    console.log(
        "  " + "TOTAL".padEnd(26) +
        String(valid.length).padStart(6) +
        String(splits.train.length).padStart(7) +
        String(splits.val.length).padStart(6) +
        String(splits.test.length).padStart(6)
    );

    // ── Sanity checks ─────────────────────────────────────────────────────────
    const sumCheck = splits.train.length + splits.val.length + splits.test.length;
    if (sumCheck !== valid.length) {
        console.error(`\n❌  Row count mismatch! ${sumCheck} ≠ ${valid.length}. Aborting.`);
        process.exit(1);
    }

    // Verify no duplicates across splits
    const allIds = [
        ...splits.train.map(r => r.id),
        ...splits.val.map(r => r.id),
        ...splits.test.map(r => r.id),
    ];
    const uniqueIds = new Set(allIds);
    if (uniqueIds.size !== allIds.length) {
        console.error(`\n❌  Duplicate IDs detected across splits! Aborting.`);
        process.exit(1);
    }

    // ── Write output files ────────────────────────────────────────────────────
    console.log("\n  💾  Writing split files...");
    for (const name of SPLIT_NAMES) {
        writeFiles(name, splits[name]);
        console.log(`  ✅  ${name}.jsonl + ${name}.csv   (${splits[name].length} rows)`);
    }

    // ── Final summary ─────────────────────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║                     Split Complete!                         ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`\n  Seed used  : ${SEED}  (re-use to get the same split)`);
    console.log(`  train.jsonl: ${splits.train.length} rows  (${(splits.train.length / valid.length * 100).toFixed(1)}%)`);
    console.log(`  val.jsonl  : ${splits.val.length}   rows  (${(splits.val.length   / valid.length * 100).toFixed(1)}%)`);
    console.log(`  test.jsonl : ${splits.test.length}   rows  (${(splits.test.length  / valid.length * 100).toFixed(1)}%)`);
    if (skipped > 0) {
        console.log(`\n  ℹ️   ${skipped} empty-text row(s) were excluded from all splits.`);
    }
    console.log("\n  ✅  All rows accounted for. No duplicates across splits.");
    console.log("\n  Next step: train your NLP model on train.jsonl,");
    console.log("             validate with val.jsonl, benchmark with test.jsonl.\n");
}

main();
