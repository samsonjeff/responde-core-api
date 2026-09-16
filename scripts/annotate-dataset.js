/**
 * scripts/annotate-dataset.js
 *
 * Semi-Automated NLP Annotation using Gemini & Key Pool Rotation.
 *
 * Reads:
 *   - datasets/merged_training.jsonl
 *
 * Writes:
 *   - datasets/annotated_dataset.jsonl (complete JSON format with NER spans)
 *   - datasets/annotated_dataset.csv   (friendly spreadsheet format for human review)
 *
 * Features:
 *   - Resumable: skips already-annotated IDs so you can stop & restart anytime.
 *   - Batched: processes 5 records per prompt to optimize quota & speed.
 *   - Uses geminiKeyPool with automatic key rotation and 429 cooldown.
 *   - Enforces the Responde Talisay Batangas schema (21 official barangays).
 *
 * Usage:
 *   npm run annotate:dataset
 *   node scripts/annotate-dataset.js --batch 5
 *   node scripts/annotate-dataset.js --limit 20   (for a quick test run)
 */

"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const geminiPool = require("../utils/geminiKeyPool");
const { BARANGAYS } = require("../utils/extractors");

// ── Paths ─────────────────────────────────────────────────────────────────────

const INPUT_FILE = path.resolve(__dirname, "../datasets/merged_training.jsonl");
const OUTPUT_JSONL = path.resolve(__dirname, "../datasets/annotated_dataset.jsonl");
const OUTPUT_CSV = path.resolve(__dirname, "../datasets/annotated_dataset.csv");

// ── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : def;
};

const BATCH_SIZE = parseInt(getArg("--batch", "5"), 10);
const LIMIT = parseInt(getArg("--limit", "0"), 10); // 0 = all

// ── Annotation Instructions & Prompt ──────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You are an expert NLP data annotator for 'Responde', an emergency response system in Talisay, Batangas, Philippines.
You analyze incoming messages in Tagalog, English, Taglish, and Batangas dialect (e.g., using "dine" for "dito", "ga", etc.).

For each text, you must output a structured JSON object with:
1. "intent": Exactly one of:
   - "EMERGENCY_REPORT" (Active danger, rising flood waters, active fire, entrapment, immediate threat to life or property)
   - "RESOURCE_REQUEST" (Asking for food, potable water, relief packs, evacuation shelter, rescue boats, supplies, medicine)
   - "STATUS_INQUIRY" (Asking for updates on water level, typhoon signal, alert level, road passability, rescue ETA)
   - "CASUALTY_REPORT" (Specifically reporting dead, injured, wounded, or missing persons)
   - "CASUAL_OR_GREETING" (Greetings, "Hello po", "Magandang umaga", "Musta", test messages)
   - "FEEDBACK_OR_THANKS" (Expressing gratitude, thanking responders, "Salamat po", "Maraming salamat")
   - "OTHER" (Spam, random words, confirmations like "Opo" or "Hindi", or unclassifiable text)

2. "urgency": Exactly one of:
   - "CRITICAL" (Immediate danger to life: drowning, active fire, trapped under debris, severe bleeding/casualty)
   - "HIGH" (Rising flood entering home, live wires down in water, approaching storm/fire, urgent resource need)
   - "MEDIUM" (Needs food/clean water, stranded but safe, relief supply inquiries)
   - "LOW" (Inquiries, greetings, gratitude, status checks, general chitchat)

3. "incident_type": Exactly one of the 7 core natural disaster hazard categories:
   ["earthquake", "fire", "flood", "landslide", "none", "typhoon", "volcanic_eruption"]
   Important rules for incident_type:
   - MUST reflect the physical natural disaster hazard.
   - Use "none" if the message is a greeting, thank you, confirmation, general chitchat, or does not mention a natural disaster.
   - Food and water requests have intent "RESOURCE_REQUEST", but incident_type is "none" unless a specific disaster (e.g. baha, bagyo, bulkan) is explicitly mentioned.
   - Everyday car crashes or police/medical issues without a natural disaster have incident_type "none".

4. "barangay": The canonical name of the Talisay barangay mentioned, or "Unknown" if not in Talisay or not mentioned.
   Valid barangays: ${JSON.stringify(BARANGAYS)}
   Note: Map colloquial terms (e.g. "pob 1" -> "Poblacion Barangay 1", "brgy tranca" -> "Tranca", "tumaway" -> "Tumaway").

5. "ner_spans": An array of extracted entities found verbatim in the text:
   Each entity is: { "text": string, "label": "LOCATION" | "INCIDENT" | "PERSON_NAME" | "CONTACT_NUMBER" }
   - "LOCATION": Specific place, street, landmark, or barangay (e.g., "tumaway", "7/11", "malapit sa palengke", "dine sa tuya")
   - "INCIDENT": Emergency event term (e.g., "sunog", "baha", "nagtumbahang poste", "nalunod na bata")
   - "PERSON_NAME": Names of people reported (e.g., "rosmary", "John Big Dih", "manang")
   - "CONTACT_NUMBER": Phone numbers (e.g., "098373376111")
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadExistingAnnotations() {
    if (!fs.existsSync(OUTPUT_JSONL)) return new Map();
    const map = new Map();
    const lines = fs.readFileSync(OUTPUT_JSONL, "utf8").split("\n").filter(l => l.trim());
    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            if (obj.id) map.set(obj.id, obj);
        } catch (_) {}
    }
    return map;
}

function csvEscape(val) {
    if (val === null || val === undefined) return "";
    if (typeof val === "object") val = JSON.stringify(val);
    const s = String(val).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
}

function saveCSV(allAnnotated) {
    const headers = [
        "id",
        "source",
        "author",
        "text",
        "intent",
        "urgency",
        "incident_type",
        "barangay",
        "ner_spans"
    ];

    const lines = [headers.join(",")];
    for (const row of allAnnotated) {
        lines.push(headers.map(h => csvEscape(row[h])).join(","));
    }
    fs.writeFileSync(OUTPUT_CSV, lines.join("\n"), "utf8");
}

// ── Gemini Call with Retries ──────────────────────────────────────────────────

async function annotateBatchWithGemini(batch) {
    const promptPayload = batch.map((item, idx) => ({
        index: idx,
        id: item.id,
        text: item.text || "(empty text)"
    }));

    const userPrompt = `Annotate the following array of records according to the instructions.
Return ONLY a valid JSON array of objects, each containing:
{
  "index": number,
  "id": string,
  "intent": string,
  "urgency": string,
  "incident_type": string,
  "barangay": string,
  "ner_spans": [ { "text": string, "label": string } ]
}

Input items:
${JSON.stringify(promptPayload, null, 2)}`;

    const maxAttempts = 50;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let client, keyIndex;
        try {
            const keyInfo = geminiPool.getNextClient();
            client = keyInfo.client;
            keyIndex = keyInfo.keyIndex;
        } catch (poolErr) {
            console.warn(`⏳ Keys in cooldown. Waiting 20s for quota reset...`);
            await sleep(20000);
            continue;
        }

        try {
            const response = await client.models.generateContent({
                model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
                contents: userPrompt,
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    responseMimeType: "application/json",
                    temperature: 0.1
                }
            });

            const text = response.text?.trim() || "";
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) throw new Error("Expected JSON array from Gemini response.");
            return parsed;
        } catch (err) {
            const is429 = err.message?.includes("429") || err.status === 429;
            const is503 = err.message?.includes("503") || err.status === 503;
            const is401 = err.message?.includes("401") || err.status === 401 || err.message?.includes("ACCOUNT_STATE_INVALID");

            if (is401) {
                // Permanently disable this dead key for this run
                geminiPool.markKeyCooldown(keyIndex, 24 * 60 * 60 * 1000);
                console.warn(`🚫 Key permanently disabled (401/service account invalid).`);
                await sleep(500);
            } else if (is429 || is503) {
                geminiPool.markKeyCooldown(keyIndex);
                console.warn(`⚠️ Key on cooldown (${is429 ? "429" : "503"}). Rotating...`);
                await sleep(1000);
            } else {
                console.warn(`⚠️ Error processing batch (attempt ${attempt + 1}): ${err.message}`);
                await sleep(2000);
            }
        }
    }

    throw new Error("Failed to annotate batch after multiple attempts.");
}

// ── Main Process ──────────────────────────────────────────────────────────────

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║     Responde AI-Assisted Auto-Annotation Tool (Gemini)       ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    if (!fs.existsSync(INPUT_FILE)) {
        console.error(`❌ Input file not found: ${INPUT_FILE}`);
        console.error("   Run `npm run export:dataset` first.");
        process.exit(1);
    }

    const rawLines = fs.readFileSync(INPUT_FILE, "utf8").split("\n").filter(l => l.trim());
    let allRecords = rawLines.map(l => JSON.parse(l));

    if (LIMIT > 0) {
        allRecords = allRecords.slice(0, LIMIT);
        console.log(`🔍 Limit set: Processing only first ${LIMIT} records.`);
    }

    const FORCE = args.includes("--force") || args.includes("--fresh");
    const existingMap = FORCE ? new Map() : loadExistingAnnotations();
    console.log(`📁 Total records in input: ${allRecords.length}`);
    console.log(`🔄 Already annotated:     ${existingMap.size}${FORCE ? " (ignored due to --force)" : ""}`);

    const pending = FORCE ? allRecords : allRecords.filter(r => !existingMap.has(r.id));
    console.log(`⚡ Pending annotation:     ${pending.length}\n`);

    if (pending.length === 0) {
        console.log("✅ All records are already annotated! Generating latest CSV...");
        saveCSV(Array.from(existingMap.values()));
        console.log(`📄 CSV updated: ${OUTPUT_CSV}`);
        return;
    }

    const appendStream = fs.createWriteStream(OUTPUT_JSONL, { flags: FORCE ? "w" : "a", encoding: "utf8" });

    // Process in batches
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const batch = pending.slice(i, i + BATCH_SIZE);
        const progress = Math.min(i + BATCH_SIZE, pending.length);
        process.stdout.write(`⏳ Annotating records ${i + 1} to ${progress} of ${pending.length}... `);

        try {
            const results = await annotateBatchWithGemini(batch);

            for (const item of batch) {
                const aiResult = results.find(r => r.id === item.id) || {};
                    const VALID_HAZARDS = ["earthquake", "fire", "flood", "landslide", "none", "typhoon", "volcanic_eruption"];
                    const incidentType = VALID_HAZARDS.includes(aiResult.incident_type) ? aiResult.incident_type : "none";
                    const annotatedRecord = {
                        ...item,
                        intent: aiResult.intent || "OTHER",
                        urgency: aiResult.urgency || "LOW",
                        incident_type: incidentType,
                        barangay: (aiResult.barangay && aiResult.barangay !== "Unknown")
                            ? aiResult.barangay
                            : (item.barangay || "Unknown"),
                        ner_spans: aiResult.ner_spans || []
                    };

                existingMap.set(item.id, annotatedRecord);
                appendStream.write(JSON.stringify(annotatedRecord) + "\n");
            }

            console.log("✅ Done");
        } catch (err) {
            console.error(`\n❌ Batch failed: ${err.message}`);
            break;
        }

        // Small courtesy delay between batches
        await sleep(500);
    }

    appendStream.end();

    // Export to CSV for Excel / Google Sheets human review
    const finalRecords = Array.from(existingMap.values());
    saveCSV(finalRecords);

    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║                 Annotation Complete!                         ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`✅ JSONL Dataset : ${OUTPUT_JSONL}`);
    console.log(`✅ CSV for Review: ${OUTPUT_CSV} (${finalRecords.length} rows)`);
    console.log("\n💡 Next step:");
    console.log("   1. Open `datasets/annotated_dataset.csv` in Excel or Google Sheets to inspect/tweak.");
    console.log("   2. When satisfied, proceed to split into train / val / test sets!");
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
