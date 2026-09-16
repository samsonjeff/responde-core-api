/**
 * scripts/rebalance-dataset.js
 *
 * Reads the newly re-annotated records from annotated_dataset.jsonl (405 rows)
 * and prepares cleaned_real_dataset.jsonl:
 *
 * 1. Preserves real natural disaster hazard rows:
 *    - volcanic_eruption (19)
 *    - landslide (16)
 *    - typhoon (14)
 *    - fire (13)
 *    - earthquake (5)
 *    - flood (capped from 43 down to 35)
 *
 * 2. Downsamples 'none' (295 rows) with stratified preservation of conversational intents:
 *    - CASUAL_OR_GREETING: ~20 rows
 *    - FEEDBACK_OR_THANKS: ~18 rows
 *    - OTHER: ~15 rows
 *    - STATUS_INQUIRY: ~8 rows
 *    (Total 'none' ~61 rows)
 *
 * Total cleaned real dataset: ~163 rows
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DATASETS_DIR = path.resolve(__dirname, "../datasets");
const INPUT_FILE = path.join(DATASETS_DIR, "annotated_dataset.jsonl");
const OUTPUT_FILE = path.join(DATASETS_DIR, "cleaned_real_dataset.jsonl");

const lines = fs.readFileSync(INPUT_FILE, "utf8").trim().split("\n").filter(Boolean);
const records = lines.map(l => JSON.parse(l)).filter(d => d.source !== "synthetic");
console.log(`Loaded ${records.length} real annotated records.`);

const groups = {
    earthquake: [],
    fire: [],
    flood: [],
    landslide: [],
    typhoon: [],
    volcanic_eruption: [],
    none: []
};

records.forEach(r => {
    const inc = groups[r.incident_type] ? r.incident_type : "none";
    groups[inc].push(r);
});

console.log("\nRaw counts from Gemini 3.6 Flash annotation:");
Object.keys(groups).sort().forEach(k => {
    console.log(`  ${k.padEnd(20)}: ${groups[k].length}`);
});

// 1. Cap flood to 35
if (groups.flood.length > 35) {
    groups.flood = groups.flood.slice(0, 35);
}

// 2. Downsample 'none' stratifying across intents
const noneByIntent = {};
groups.none.forEach(r => {
    if (!noneByIntent[r.intent]) noneByIntent[r.intent] = [];
    noneByIntent[r.intent].push(r);
});

console.log("\n'none' records by intent before downsampling:");
Object.keys(noneByIntent).sort().forEach(k => {
    console.log(`  ${k.padEnd(20)}: ${noneByIntent[k].length}`);
});

const selectedNone = [];
const INTENT_CAPS = {
    CASUAL_OR_GREETING: 20,
    FEEDBACK_OR_THANKS: 18,
    OTHER: 15,
    STATUS_INQUIRY: 8
};

Object.keys(INTENT_CAPS).forEach(intent => {
    const pool = noneByIntent[intent] || [];
    const count = Math.min(pool.length, INTENT_CAPS[intent]);
    selectedNone.push(...pool.slice(0, count));
});

groups.none = selectedNone;

const cleanedRows = [];
Object.keys(groups).forEach(k => {
    cleanedRows.push(...groups[k]);
});

console.log(`\nCleaned Real Rows: Total ${cleanedRows.length}`);
const finalCounts = {};
cleanedRows.forEach(r => {
    finalCounts[r.incident_type] = (finalCounts[r.incident_type] || 0) + 1;
});
console.table(finalCounts);

console.log("\nIntent distribution in cleaned real rows:");
const intentCounts = {};
cleanedRows.forEach(r => {
    intentCounts[r.intent] = (intentCounts[r.intent] || 0) + 1;
});
console.table(intentCounts);

fs.writeFileSync(OUTPUT_FILE, cleanedRows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`\nSaved cleaned real records to ${OUTPUT_FILE}`);
