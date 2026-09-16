/**
 * scripts/generate-synthetic.js
 *
 * Generates synthetic emergency messages to balance out the core natural disaster
 * incident types in the Talisay, Batangas disaster response dataset.
 *
 * Targeted Natural Disaster Types:
 *   - earthquake         (+33 to reach 35)
 *   - typhoon            (+29 to reach 35)
 *   - fire               (+22 to reach 35)
 *   - volcanic_eruption  (+16 to reach 35)
 *   - landslide          (+15 to reach 35)
 *
 * Merged with datasets/cleaned_real_dataset.jsonl (140 rows: flood:35, none:45, etc.)
 * Output: datasets/annotated_dataset.jsonl (~255 rows, perfectly balanced ~35 each)
 */

"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const geminiPool = require("../utils/geminiKeyPool");
const { BARANGAYS } = require("../utils/extractors");

const DATASETS_DIR = path.resolve(__dirname, "../datasets");
const CLEANED_REAL_JSONL = path.join(DATASETS_DIR, "cleaned_real_dataset.jsonl");
const SYNTHETIC_JSONL = path.join(DATASETS_DIR, "synthetic_dataset.jsonl");
const SYNTHETIC_CSV = path.join(DATASETS_DIR, "synthetic_dataset.csv");
const ANNOTATED_JSONL = path.join(DATASETS_DIR, "annotated_dataset.jsonl");
const ANNOTATED_CSV = path.join(DATASETS_DIR, "annotated_dataset.csv");

// Exact counts needed to reach 35 for every natural disaster hazard
const DEFICIT_COUNTS = {
    earthquake: 30,
    fire: 22,
    typhoon: 21,
    landslide: 19,
    volcanic_eruption: 16
};

const SYSTEM_INSTRUCTION = `You are an expert NLP data generator for 'Responde', a municipal disaster emergency response system in Talisay, Batangas, Philippines.
Talisay is located along the north shore of Taal Lake, facing Taal Volcano.
Official barangays in Talisay:
${JSON.stringify(BARANGAYS, null, 2)}

You generate highly authentic user messages sent by Batangueño residents during natural disasters.
Language style:
- Batangas Tagalog expressions: "dine", "ire", "ga", "ala eh", "nayanig", "pulo", "lawa", "riprap"
- Taglish / conversational social media & Messenger reports
- Pure Tagalog
- Occasional urgent shorthand: "pls", "hndi", "pwd", "brgy", "tulong"

Each message must be realistic and reflect the specific natural disaster.`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function csvEscape(val) {
    if (val === null || val === undefined) return "";
    if (typeof val === "object") val = JSON.stringify(val);
    const s = String(val).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
}

function toCSV(rows) {
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
    for (const r of rows) {
        lines.push([
            csvEscape(r.id),
            csvEscape(r.source),
            csvEscape(r.author),
            csvEscape(r.text),
            csvEscape(r.intent),
            csvEscape(r.urgency),
            csvEscape(r.incident_type),
            csvEscape(r.barangay),
            csvEscape(JSON.stringify(r.ner_spans || []))
        ].join(","));
    }
    return lines.join("\n");
}

async function generateBatchWithGemini(incidentType, count = 5) {
    let clientInfo;
    try {
        clientInfo = geminiPool.getNextClient();
    } catch (e) {
        return null;
    }

    const { client, keyIndex } = clientInfo;
    const prompt = `Generate exactly ${count} diverse and realistic emergency messages in Batangas Tagalog/Taglish reported in Talisay, Batangas for natural disaster: "${incidentType}".
Return ONLY a valid JSON array of objects with keys:
- text: string (the message text)
- intent: one of ["EMERGENCY_REPORT", "RESOURCE_REQUEST", "STATUS_INQUIRY", "CASUALTY_REPORT"]
- urgency: one of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
- barangay: string (must be one of the official Talisay barangays)
- ner_spans: array of {text, label} where label is LOCATION, INCIDENT, PERSON_NAME, or CONTACT_NUMBER.`;

    try {
        const response = await client.models.generateContent({
            model: "gemini-3.6-flash",
            contents: prompt,
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                responseMimeType: "application/json",
                temperature: 0.75
            }
        });
        const rawText = response.text?.trim() || "";
        const parsed = JSON.parse(rawText);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (err) {
        geminiPool.markKeyCooldown(keyIndex, 60 * 1000);
    }
    return null;
}

// ── Rich Procedural Templates for Batangas Natural Disasters ──────────────────

const PROCEDURAL_TEMPLATES = {
    earthquake: [
        {
            template: (brgy, name, phone) => `Napakalakas ng lindol dine sa Brgy ${brgy}! Nayanig ang buong bahay at may malaking bitak sa kalsada. May matanda po kaming hindi makatayo. ${name} - ${phone}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Ramdam na ramdam po ang volcanic tremor dito sa ${brgy} malapit sa tabing lawa. May advisory po ba ang MDRRMC kung kailangan mag-evacuate?`,
            intent: "STATUS_INQUIRY", urgency: "MEDIUM"
        },
        {
            template: (brgy, name) => `Tulong po! Gumuho ang pader ng kapitbahay namin dahil sa lindol kanina dito sa ${brgy}, may naipit po sa loob! Si ${name} po ito bilisan nyo po!`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy, name, phone) => `Lumindol po nang magnitude 5+, nagka-fissure ang semento sa harapan ng kapilya sa ${brgy}. Delikado pong daanan ng sasakyan. Tawag po kayo kay ${name} sa ${phone}.`,
            intent: "EMERGENCY_REPORT", urgency: "HIGH"
        },
        {
            template: (brgy) => `Sunod-sunod po ang aftershocks dine sa ${brgy} mula kagabi. Wala na pong kuryente at natatakot na ang mga bata pumasok sa bahay.`,
            intent: "STATUS_INQUIRY", urgency: "MEDIUM"
        },
        {
            template: (brgy, name, phone) => `May tatlong sugatan po dito sa Sitio Ilaya, ${brgy} gawa ng bumagsak na hollow blocks nung lumindol. Kailangan po ng medic at first aid kit! ${name} ${phone}`,
            intent: "CASUALTY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Kailangan po namin ng evacuation tent dito sa open field ng ${brgy}. Ayaw na po magsiuwi ng mga residente dahil sa patuloy na pagyanig ng lupa.`,
            intent: "RESOURCE_REQUEST", urgency: "HIGH"
        },
        {
            template: (brgy, name) => `Report ko lang po may lumubog na bahagi ng kalsada dahil sa lindol papuntang ${brgy}. Ingat po ang mga dadaan. Reported by ${name}.`,
            intent: "EMERGENCY_REPORT", urgency: "MEDIUM"
        }
    ],
    typhoon: [
        {
            template: (brgy, name, phone) => `Napakalakas po ng bugso ng hangin ng bagyo dito sa ${brgy}, nilipad na po ang bubong ng bahay namin! Bumabagyo po ng husto, pakirescue po kami! ${name} - ${phone}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Signal No. 3 na po ba sa Talisay Batangas? Sobrang lakas na po ng unos at ulan dito sa ${brgy}, may abiso na po ba ng forced evacuation?`,
            intent: "STATUS_INQUIRY", urgency: "HIGH"
        },
        {
            template: (brgy, name, phone) => `Dahil sa hagupit ng bagyo, nagkaroon po ng storm surge at malalaking alon galing sa Taal Lake dito sa baybayin ng ${brgy}. Pinasok na ang mga bahay! ${name} ${phone}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy, name) => `Bumagsak po ang malaking puno ng mangga sa kable ng kuryente dahil sa malakas na hangin ng bagyo dito sa ${brgy}. Putol po ang linya. ${name}`,
            intent: "EMERGENCY_REPORT", urgency: "HIGH"
        },
        {
            template: (brgy, name, phone) => `May nasugatan pong residente dito sa ${brgy} nang tamaan ng lumilipad na yero dulot ng bagyo. Kailangan po ng ambulansya agad! ${name} ${phone}`,
            intent: "CASUALTY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Humihingi po kami ng trapal at emergency lights dito sa evacuation center sa ${brgy}, nawalan po ng power buong gabi gawa ng bagyo.`,
            intent: "RESOURCE_REQUEST", urgency: "HIGH"
        },
        {
            template: (brgy) => `Malakas pa rin po ba ang ulan at hangin ng habagat sa lawa? Pwede na po bang bumiyahe pabalik ng ${brgy}?`,
            intent: "STATUS_INQUIRY", urgency: "LOW"
        },
        {
            template: (brgy, name) => `Emergency! Nagsisimula nang matanggal ang mga dingding ng mga barong-barong dito sa baywalk ng ${brgy} dahil sa unos. Tulong po rescue, ${name}.`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        }
    ],
    fire: [
        {
            template: (brgy, name, phone) => `May malaking sunog po dine sa Purok 3 ng Brgy ${brgy}! Mabilis kumakalat ang apoy dahil sa hangin! Bumbero po agad! Tawag kay ${name} ${phone}!`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy, name, phone) => `Grassfire / sunog sa talahiban dito sa bundok malapit sa ${brgy}. Papalapit na po ang apoy sa mga kabahayan! Responde please! ${name} ${phone}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy, name) => `Nasusunog po ang isang residential house dito sa ${brgy} malapit sa palengke. May nakulong po sa loob na bata! Tulong po! ${name}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Under control na po ba ang sunog sa may ${brgy}? Mausok pa rin po kasi at hirap huminga ang mga senior citizen.`,
            intent: "STATUS_INQUIRY", urgency: "MEDIUM"
        },
        {
            template: (brgy, name, phone) => `Dalawa po ang nagtamo ng third-degree burns sa nangyaring sunog dito sa ${brgy}. Kailangan po ng agarang medical transport sa ospital! ${name} ${phone}`,
            intent: "CASUALTY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Humihingi po kami ng mga damit, kumot, at pansamantalang matutuluyan para sa mga pamilyang naabutan ng sunog sa ${brgy}.`,
            intent: "RESOURCE_REQUEST", urgency: "HIGH"
        },
        {
            template: (brgy, name) => `May sumabog pong tangke ng LPG at nagliyab ang kusina dito sa ${brgy}. Tumawag na po kami sa BFP pero kailangan po ng backup. ${name}`,
            intent: "EMERGENCY_REPORT", urgency: "HIGH"
        }
    ],
    volcanic_eruption: [
        {
            template: (brgy, name, phone) => `May makapal na bagsak ng abo dine sa Brgy. ${brgy}, nangangamoy asupre na po at madilim ang paligid. Kailangan na po namin lumikas. Ako po si ${name}, ${phone}.`,
            intent: "EMERGENCY_REPORT", urgency: "HIGH"
        },
        {
            template: (brgy) => `Pumutok na naman po ba ang Bulkang Taal? Umusok ng mataas at lumindol dine sa ${brgy}, safe pa po ba kami?`,
            intent: "STATUS_INQUIRY", urgency: "MEDIUM"
        },
        {
            template: (brgy, name) => `Emergency! Nagsisimula na umulan ng bato at makapal na buhangin galing sa bulkan dito sa ${brgy} malapit sa lawa. Help rescue po, ${name}.`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Napakalakas ng amoy sulfur dine sa tabing lawa ng ${brgy}. Nahihirapan na huminga ang mga bata, kailangan po namin ng N95 masks at sasakyan papuntang evacuation center.`,
            intent: "RESOURCE_REQUEST", urgency: "HIGH"
        },
        {
            template: (brgy, name, phone) => `Alert Level 3 na daw ang bulkang Taal? Pakikumpirma naman po MDRRMC Talisay. Mag-evacuate na po ba kami dito sa ${brgy}? ${name} po - ${phone}`,
            intent: "STATUS_INQUIRY", urgency: "MEDIUM"
        },
        {
            template: (brgy, name, phone) => `May mga mangingisda pong naabutan ng phreatomagmatic eruption sa Volcano Island malapit sa ${brgy}. Hindi pa po nakakabalik! Rescue po kay ${name} ${phone}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        }
    ],
    landslide: [
        {
            template: (brgy, name, phone) => `Gumuho po ang lupa at riprap sa may kalsada sa ${brgy}! Natabunan po ang isang van at hindi makadaan ang mga sasakyan. Tulong po agad! ${name} ${phone}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy, name) => `May malaking landslide dito sa gilid ng bundok sa ${brgy} dahil sa walang tigil na ulan. Nanganganib pong matabunan ang tatlong bahay sa ibaba! ${name}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Passable na po ba ang kalsada galing Tanauan papuntang ${brgy} Talisay o sarado pa rin dahil sa gumuhong riprap?`,
            intent: "STATUS_INQUIRY", urgency: "LOW"
        },
        {
            template: (brgy, name, phone) => `May naipit po sa natabunang bahay dahil sa pagguho ng lupa sa Sitio Gulod, ${brgy}. Kailangan po ng backhoe at rescue team ngayon na! ${name} ${phone}`,
            intent: "EMERGENCY_REPORT", urgency: "CRITICAL"
        },
        {
            template: (brgy) => `Humihingi po kami ng tulong na mai-evacuate ang mga taga-ibabang bahagi ng ${brgy} dahil patuloy na gumuguho ang putik mula sa itaas ng ridge.`,
            intent: "RESOURCE_REQUEST", urgency: "HIGH"
        }
    ]
};

const SAMPLE_NAMES = [
    "Juan Dimaculangan", "Maria Teresa Malabanan", "Rodel De Castro", "Jocelyn Punzalan",
    "Arnel Hernandez", "Edgar Carandang", "Rosalie Mendoza", "Mark Anthony Laurel",
    "Lilibeth Macatangay", "Dennis Magpantay", "Maricel Villanueva", "Renato Balmes",
    "Jobert Austria", "Joel Manalo", "Bonggoy Alvarez", "Justine Villegas"
];

function generateProceduralSample(incidentType, index) {
    const templates = PROCEDURAL_TEMPLATES[incidentType];
    const item = templates[index % templates.length];
    const brgy = BARANGAYS[Math.floor(Math.random() * BARANGAYS.length)];
    const name = SAMPLE_NAMES[Math.floor(Math.random() * SAMPLE_NAMES.length)];
    const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`;

    const text = item.template(brgy, name, phone);
    return {
        text,
        author: name,
        intent: item.intent,
        urgency: item.urgency,
        incident_type: incidentType,
        barangay: brgy,
        ner_spans: [
            { text: brgy, label: "LOCATION" },
            { text: name, label: "PERSON_NAME" },
            { text: phone, label: "CONTACT_NUMBER" }
        ]
    };
}

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║   Responde Natural Disaster Synthetic Generator & Balancer   ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    if (!fs.existsSync(CLEANED_REAL_JSONL)) {
        console.error(`❌ Cannot find ${CLEANED_REAL_JSONL}. Run rebalance-dataset.js first.`);
        process.exit(1);
    }

    const cleanedRealRows = fs.readFileSync(CLEANED_REAL_JSONL, "utf8")
        .trim().split("\n").filter(Boolean).map(l => JSON.parse(l));

    console.log(`Loaded ${cleanedRealRows.length} cleaned real records.`);

    const allGenerated = [];

    for (const [incidentType, countNeeded] of Object.entries(DEFICIT_COUNTS)) {
        console.log(`\n⏳ Generating ${countNeeded} samples for '${incidentType}'...`);
        let typeSamples = [];
        let remaining = countNeeded;

        // Try Gemini in batches of 10 if API key is active
        while (remaining > 0) {
            const fetchN = Math.min(remaining, 10);
            process.stdout.write(`   Fetching ${fetchN} via Gemini API... `);
            const geminiBatch = await generateBatchWithGemini(incidentType, fetchN);
            if (geminiBatch && geminiBatch.length > 0) {
                console.log(`✅ received ${geminiBatch.length}`);
                typeSamples.push(...geminiBatch);
                remaining -= geminiBatch.length;
            } else {
                console.log(`⚠️ using high-diversity Batangas procedural generator`);
                for (let i = 0; i < remaining; i++) {
                    typeSamples.push(generateProceduralSample(incidentType, i));
                }
                remaining = 0;
            }
        }

        const formatted = typeSamples.map((raw, idx) => {
            const hash = crypto.randomBytes(4).toString("hex");
            const now = new Date(Date.now() - Math.floor(Math.random() * 7 * 86400000));
            return {
                source: "synthetic",
                id: `synth_${incidentType}_${hash}_${idx + 1}`,
                text: (raw.text || "").trim(),
                author: raw.author || "Resident of Talisay",
                timestamp: now.toISOString(),
                barangay: raw.barangay || "Unknown",
                incident_type: incidentType,
                intent: raw.intent || "EMERGENCY_REPORT",
                urgency: raw.urgency || "HIGH",
                ner_spans: Array.isArray(raw.ner_spans) ? raw.ner_spans : []
            };
        });

        allGenerated.push(...formatted);
        console.log(`   ✨ Finished ${formatted.length} synthetic rows for '${incidentType}'.`);
    }

    // Save synthetic files
    fs.writeFileSync(SYNTHETIC_JSONL, allGenerated.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
    fs.writeFileSync(SYNTHETIC_CSV, toCSV(allGenerated), "utf8");

    // Combine cleaned real records + new synthetic records
    const combined = [...cleanedRealRows, ...allGenerated];
    fs.writeFileSync(ANNOTATED_JSONL, combined.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
    fs.writeFileSync(ANNOTATED_CSV, toCSV(combined), "utf8");

    console.log(`\n==============================================================`);
    console.log(`✅ FINAL BALANCED DATASET GENERATED! Total Rows: ${combined.length}`);
    console.log(`==============================================================`);

    const finalCounts = {};
    combined.forEach(d => {
        finalCounts[d.incident_type] = (finalCounts[d.incident_type] || 0) + 1;
    });
    console.table(finalCounts);
}

main().catch(err => {
    console.error("❌ Fatal Error:", err);
    process.exit(1);
});
