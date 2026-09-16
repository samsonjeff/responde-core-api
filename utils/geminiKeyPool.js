/**
 * Gemini API Key Pool — Round-robin rotation across multiple keys
 * 
 * Distributes Gemini API calls across N free-tier project keys so each key
 * stays under its per-project quota.  When a key hits 429, only *that* key
 * goes on cooldown; the remaining keys continue serving requests.
 *
 * Usage:
 *   const pool = require('./utils/geminiKeyPool');
 *   const { client, keyIndex } = pool.getNextClient();
 *   // ... use client ...
 *   // On 429:  pool.markKeyCooldown(keyIndex);
 */

const { GoogleGenAI } = require("@google/genai");

// ── Configuration ────────────────────────────────────────────────────────────
const DEFAULT_COOLDOWN_MS = 60 * 1000; // 60 seconds per key

// ── Parse keys from environment ──────────────────────────────────────────────
function parseKeys() {
    // Prefer comma-separated GEMINI_API_KEYS; fall back to single GEMINI_API_KEY
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const keys = raw
        .split(",")
        .map(k => k.trim())
        .filter(Boolean);

    if (keys.length === 0) {
        throw new Error(
            "No Gemini API keys found. Set GEMINI_API_KEYS (comma-separated) " +
            "or GEMINI_API_KEY in your .env file."
        );
    }
    return keys;
}

// ── Build the pool ───────────────────────────────────────────────────────────
const keys = parseKeys();

const pool = keys.map((key, i) => ({
    key,
    client: new GoogleGenAI({ apiKey: key }),
    cooldownUntil: 0,
    totalCalls: 0,
    label: `Key-${String(i + 1).padStart(2, "0")}`,   // Key-01 … Key-15
}));

let currentIndex = 0;   // round-robin pointer

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the next available { client, keyIndex }.
 * Skips keys that are on cooldown.
 * Throws if ALL keys are on cooldown.
 */
function getNextClient() {
    const now = Date.now();
    const total = pool.length;

    for (let attempt = 0; attempt < total; attempt++) {
        const idx = currentIndex % total;
        currentIndex = (currentIndex + 1) % total;
        const entry = pool[idx];

        if (now >= entry.cooldownUntil) {
            entry.totalCalls++;
            console.log(`🔑 Using ${entry.label} (calls: ${entry.totalCalls})`);
            return { client: entry.client, keyIndex: idx };
        }
    }

    // Every key is on cooldown
    const soonest = Math.min(...pool.map(e => e.cooldownUntil));
    const waitSecs = Math.ceil((soonest - now) / 1000);
    throw new Error(
        `All ${total} Gemini keys are on cooldown. ` +
        `Earliest available in ${waitSecs}s.`
    );
}

/**
 * Put a specific key on cooldown after a 429.
 * @param {number} keyIndex - index returned by getNextClient()
 * @param {number} [durationMs] - cooldown length (default 60s)
 */
function markKeyCooldown(keyIndex, durationMs = DEFAULT_COOLDOWN_MS) {
    const entry = pool[keyIndex];
    entry.cooldownUntil = Date.now() + durationMs;
    const secs = Math.ceil(durationMs / 1000);
    console.warn(`⏸️  ${entry.label} on cooldown for ${secs}s (429 rate-limited)`);
}

/**
 * Returns a status snapshot — useful for diagnostics and startup logs.
 */
function getPoolStatus() {
    const now = Date.now();
    const active = pool.filter(e => now >= e.cooldownUntil).length;
    const onCooldown = pool.length - active;
    return {
        totalKeys: pool.length,
        activeKeys: active,
        cooldownKeys: onCooldown,
        keys: pool.map(e => ({
            label: e.label,
            totalCalls: e.totalCalls,
            onCooldown: now < e.cooldownUntil,
            cooldownRemainingSecs: now < e.cooldownUntil
                ? Math.ceil((e.cooldownUntil - now) / 1000)
                : 0,
        })),
    };
}

module.exports = { getNextClient, markKeyCooldown, getPoolStatus, pool };
