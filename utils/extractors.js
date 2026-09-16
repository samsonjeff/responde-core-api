/**
 * utils/extractors.js
 *
 * Rule-based entity & keyword extraction for the Responde system:
 *  - Official 21 Talisay Batangas barangays & colloquial aliases
 *  - Incident keywords (Filipino & English)
 *  - Philippine mobile/landline numbers
 *  - Conversational sender name patterns
 */

/**
 * Official list of 21 barangays in Talisay, Batangas, Philippines.
 */
const BARANGAYS = [
    "Aya",
    "Balas",
    "Banga",
    "Buco",
    "Caloocan",
    "Leynes",
    "Miranda",
    "Poblacion Barangay 1",
    "Poblacion Barangay 2",
    "Poblacion Barangay 3",
    "Poblacion Barangay 4",
    "Poblacion Barangay 5",
    "Poblacion Barangay 6",
    "Poblacion Barangay 7",
    "Poblacion Barangay 8",
    "Quiling",
    "Sampaloc",
    "San Guillermo",
    "Santa Maria",
    "Tranca",
    "Tumaway"
];

/**
 * Common shorthand / colloquial aliases → canonical barangay name.
 * Checked BEFORE the canonical name list so that "pob 1" matches
 * "Poblacion Barangay 1" and not just a partial "Poblacion" hit.
 */
const BARANGAY_ALIASES = {
    // Poblacion shorthand (pob / pobl / poblacion + number)
    "pob 1": "Poblacion Barangay 1", "poblacion 1": "Poblacion Barangay 1", "pobl 1": "Poblacion Barangay 1", "brgy 1": "Poblacion Barangay 1", "barangay 1": "Poblacion Barangay 1",
    "pob 2": "Poblacion Barangay 2", "poblacion 2": "Poblacion Barangay 2", "pobl 2": "Poblacion Barangay 2", "brgy 2": "Poblacion Barangay 2", "barangay 2": "Poblacion Barangay 2",
    "pob 3": "Poblacion Barangay 3", "poblacion 3": "Poblacion Barangay 3", "pobl 3": "Poblacion Barangay 3", "brgy 3": "Poblacion Barangay 3", "barangay 3": "Poblacion Barangay 3",
    "pob 4": "Poblacion Barangay 4", "poblacion 4": "Poblacion Barangay 4", "pobl 4": "Poblacion Barangay 4", "brgy 4": "Poblacion Barangay 4", "barangay 4": "Poblacion Barangay 4",
    "pob 5": "Poblacion Barangay 5", "poblacion 5": "Poblacion Barangay 5", "pobl 5": "Poblacion Barangay 5", "brgy 5": "Poblacion Barangay 5", "barangay 5": "Poblacion Barangay 5",
    "pob 6": "Poblacion Barangay 6", "poblacion 6": "Poblacion Barangay 6", "pobl 6": "Poblacion Barangay 6", "brgy 6": "Poblacion Barangay 6", "barangay 6": "Poblacion Barangay 6",
    "pob 7": "Poblacion Barangay 7", "poblacion 7": "Poblacion Barangay 7", "pobl 7": "Poblacion Barangay 7", "brgy 7": "Poblacion Barangay 7", "barangay 7": "Poblacion Barangay 7",
    "pob 8": "Poblacion Barangay 8", "poblacion 8": "Poblacion Barangay 8", "pobl 8": "Poblacion Barangay 8", "brgy 8": "Poblacion Barangay 8", "barangay 8": "Poblacion Barangay 8",
    // Santa Maria variants
    "sta. maria": "Santa Maria", "sta maria": "Santa Maria", "santamaria": "Santa Maria",
    // San Guillermo variants
    "san guillermo": "San Guillermo", "san gil": "San Guillermo",
    // Other common shorthands
    "brgy balas": "Balas", "brgy buco": "Buco", "brgy aya": "Aya",
    "brgy banga": "Banga", "brgy caloocan": "Caloocan", "brgy leynes": "Leynes",
    "brgy miranda": "Miranda", "brgy quiling": "Quiling", "brgy sampaloc": "Sampaloc",
    "brgy tranca": "Tranca", "brgy tumaway": "Tumaway",
};

/**
 * Incident keywords (Filipino + English).
 * Maps keyword patterns to canonical incident types.
 */
const INCIDENT_KEYWORDS = {
    // Flood
    "flood": "flood",
    "baha": "flood",
    "binaha": "flood",
    "bumabaha": "flood",
    "flash flood": "flood",
    "lubog": "flood",
    "lumubog": "flood",

    // Fire
    "fire": "fire",
    "sunog": "fire",
    "nasunog": "fire",
    "nasusunog": "fire",
    "apoy": "fire",
    "nagliliyab": "fire",
    "wildfire": "fire",
    "grassfire": "fire",

    // Earthquake
    "earthquake": "earthquake",
    "lindol": "earthquake",
    "lumindol": "earthquake",
    "yanig": "earthquake",
    "nayanig": "earthquake",
    "fissure": "earthquake",
    "tremor": "earthquake",

    // Landslide
    "landslide": "landslide",
    "guho": "landslide",
    "pagguho": "landslide",
    "gumuho": "landslide",
    "natabunan ng lupa": "landslide",
    "natabunan ng putik": "landslide",
    "natabunan ng potek": "landslide",
    "riprap": "landslide",

    // Typhoon
    "typhoon": "typhoon",
    "bagyo": "typhoon",
    "bumabagyo": "typhoon",
    "storm": "typhoon",
    "hangin": "typhoon",
    "habagat": "typhoon",
    "unos": "typhoon",
    "storm surge": "typhoon",
    "signal no": "typhoon",

    // Volcanic Eruption
    "volcano": "volcanic_eruption",
    "pumutok": "volcanic_eruption",
    "sumabog": "volcanic_eruption",
    "bolkan": "volcanic_eruption",
    "bulkan": "volcanic_eruption",
    "volcanic eruption": "volcanic_eruption",
    "vulcan": "volcanic_eruption",
    "eruption": "volcanic_eruption",
    "asupre": "volcanic_eruption",
    "sulfur": "volcanic_eruption",
    "abo": "volcanic_eruption",
    "ashfall": "volcanic_eruption"
};

/**
 * Detect a Talisay barangay name from free text.
 * Checks aliases first (e.g. "pob 1"), then canonical names longest-first.
 * @param {string} text
 * @returns {string} Matched barangay name or "Unknown"
 */
function detectBarangay(text) {
    if (!text) return "Unknown";
    const lower = text.toLowerCase();

    // 1. Check aliases first (sorted longest → shortest to avoid partial hits)
    const sortedAliases = Object.keys(BARANGAY_ALIASES).sort((a, b) => b.length - a.length);
    for (const alias of sortedAliases) {
        if (lower.includes(alias)) {
            return BARANGAY_ALIASES[alias];
        }
    }

    // 2. Check canonical names (longest first so "Poblacion Barangay 1" beats "Barangay")
    const sorted = [...BARANGAYS].sort((a, b) => b.length - a.length);
    for (const brgy of sorted) {
        if (lower.includes(brgy.toLowerCase())) {
            return brgy;
        }
    }

    return "Unknown";
}

/**
 * Extract Philippine mobile/landline numbers from free text.
 *
 * Handles formats:
 *   09XXXXXXXXX  |  +639XXXXXXXXX  |  09XX-XXX-XXXX  |  (02) XXXX-XXXX
 *
 * @param {string} text
 * @returns {string[]} Array of normalised phone strings (spaces/dashes stripped)
 */
const _CONTACT_RE = /(?:\+63|0)\s*9\d{2}[\s\-]?\d{3}[\s\-]?\d{4}|09\d{9}|\+639\d{9}/g;

function extractContacts(text) {
    if (!text) return [];
    const matches = text.match(_CONTACT_RE) || [];
    // Normalise: strip all spaces and dashes
    return [...new Set(matches.map(m => m.replace(/[\s\-]/g, "")))];
}

/**
 * Extract a person's name from common Tagalog / English introduction patterns.
 *
 * Matched patterns (case-insensitive):
 *   "ako si <Name>"          (most common Tagalog)
 *   "si <Name> ako"          (inverted)
 *   "ako po si <Name>"
 *   "pangalan ko ay <Name>"
 *   "pangalan ko po ay <Name>"
 *   "ang pangalan ko ay <Name>"
 *   "my name is <Name>"
 *   "name is <Name>"
 *   "i am <Name>"
 *   "tawagin nyo ako as <Name>"
 *   "tawagin nila ako ng <Name>"
 *
 * Returns the captured token(s) with each word Title-Cased.
 * Returns null if no pattern matches.
 *
 * @param {string} text
 * @returns {string|null}
 */
const _NAME_PATTERNS = [
    // Tagalog — "ako si Juan" / "ako po si Juan"
    /\bako\s+(?:po\s+)?si\s+([A-ZÑa-zñ][a-zñ]+(?:\s+[A-ZÑa-zñ][a-zñ]+){0,3})/i,
    // Tagalog — "si Juan ako" / "si Maria Santos ako"
    /\bsi\s+([A-ZÑa-zñ][a-zñ]+(?:\s+[A-ZÑa-zñ][a-zñ]+){0,3})\s+(?:po\s+)?ako\b/i,
    // Tagalog — "pangalan ko [po] ay Juan"
    /\bpangalan\s+ko\s+(?:po\s+)?ay\s+([A-ZÑa-zñ][a-zñ]+(?:\s+[A-ZÑa-zñ][a-zñ]+){0,3})/i,
    // Tagalog — "ang pangalan ko ay Juan"
    /\bang\s+pangalan\s+ko\s+(?:po\s+)?ay\s+([A-ZÑa-zñ][a-zñ]+(?:\s+[A-ZÑa-zñ][a-zñ]+){0,3})/i,
    // Tagalog — "tawagin nyo ako as/ng Juan" / "tawagin nila ako ng Juan"
    /\btawagin\s+(?:nyo|nila|mo)\s+(?:ako|ko)\s+(?:as|ng)\s+([A-ZÑa-zñ][a-zñ]+(?:\s+[A-ZÑa-zñ][a-zñ]+){0,2})/i,
    // English — "my name is Juan" / "name is Juan"
    /\b(?:my\s+)?name\s+is\s+([A-ZÑa-zñ][a-zñ]+(?:\s+[A-ZÑa-zñ][a-zñ]+){0,3})/i,
    // English — "i am Juan"
    /\bi\s+am\s+([A-ZÑa-zñ][a-zñ]+(?:\s+[A-ZÑa-zñ][a-zñ]+){0,3})/i,
];

function extractName(text) {
    if (!text) return null;
    for (const pattern of _NAME_PATTERNS) {
        const m = text.match(pattern);
        if (m && m[1]) {
            // Title-case each word (handles "JUAN" or "juan" → "Juan")
            return m[1]
                .trim()
                .split(/\s+/)
                .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join(" ");
        }
    }
    return null;
}

/**
 * Detect incident type from free text.
 * @param {string} text
 * @returns {string|null} Canonical incident type or null
 */
function detectIncidentType(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    // Sort keywords by length descending so "flash flood" matches before "flood"
    const sortedKeywords = Object.keys(INCIDENT_KEYWORDS)
        .sort((a, b) => b.length - a.length);

    for (const keyword of sortedKeywords) {
        if (lower.includes(keyword)) {
            return INCIDENT_KEYWORDS[keyword];
        }
    }
    return null;
}

module.exports = {
    BARANGAYS,
    BARANGAY_ALIASES,
    INCIDENT_KEYWORDS,
    detectBarangay,
    detectIncidentType,
    extractContacts,
    extractName,
};
