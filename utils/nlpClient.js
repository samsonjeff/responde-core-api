/**
 * utils/nlpClient.js
 *
 * Thin HTTP client that calls the Python FastAPI NLP inference server.
 *
 * The Python server (responde-ml-api/app.py) is hosted separately:
 *   - Production: Hugging Face Spaces  (set NLP_SERVICE_URL in Render env vars)
 *   - Local dev:  http://localhost:7860 (run uvicorn app:app --port 7860 in responde-ml-api/)
 *
 * If the server is unavailable this module returns null — the Node.js app
 * continues to work normally without NLP classification (graceful degradation).
 *
 * Usage:
 *   const nlpClient = require('./utils/nlpClient');
 *   const result = await nlpClient.classify("may sunoj dito sa brgy banga!");
 *   // result → { intent, urgency, incident_type,
 *   //            intent_confidence, urgency_confidence, incident_type_confidence }
 *   // or null if the ML server is down / not yet trained
 */

"use strict";

const axios = require("axios");

const NLP_BASE_URL = process.env.NLP_SERVICE_URL || "http://localhost:7860";
const NLP_TIMEOUT  = parseInt(process.env.NLP_TIMEOUT_MS || "3000", 10); // 3 s max

let _serverAvailable = true;   // optimistic start; set false on first failure
let _cooldownUntil   = 0;      // exponential back-off: don't retry until this time

/**
 * Classify a single text string.
 *
 * @param {string} text  The raw user message to classify.
 * @param {number|{ timeoutMs?: number, throwOnError?: boolean }} [options] Timeout in ms or options object.
 * @returns {Promise<{
 *   intent: string,
 *   urgency: string,
 *   incident_type: string,
 *   intent_confidence: number,
 *   urgency_confidence: number,
 *   incident_type_confidence: number,
 *   barangay: string|null,
 *   contact_numbers: string[]
 * }|null>} Classification result, or null if the ML server is unavailable.
 */
async function classify(text, options = {}) {
    if (!text || !text.trim()) return null;

    const timeoutMs = typeof options === "number" ? options : (options.timeoutMs || NLP_TIMEOUT);
    const throwOnError = typeof options === "object" && options.throwOnError === true;

    // Back-off: skip call if server recently failed (unless throwOnError is explicitly requested by a retry worker)
    if (!throwOnError && !_serverAvailable && Date.now() < _cooldownUntil) {
        return null;
    }

    try {
        const response = await axios.post(
            `${NLP_BASE_URL}/classify`,
            { text },
            {
                timeout: timeoutMs,
                headers: { "Content-Type": "application/json" }
            }
        );

        // Mark server as available again after a successful call
        _serverAvailable = true;
        _cooldownUntil   = 0;

        return response.data;
    } catch (err) {
        if (throwOnError) {
            throw err;
        }

        // Log only on first failure; don't spam logs on every message
        if (_serverAvailable) {
            const reason = err.code === "ECONNREFUSED"
                ? "connection refused (NLP server not running)"
                : err.response?.status === 503
                    ? "NLP server not ready (model not trained yet)"
                    : err.message;

            console.warn(`⚠️  NLP service unavailable: ${reason}`);
            console.warn("    Classification will be skipped. Start with: npm run ml:serve");
        }

        // Exponential back-off: suppress further retries for 30 s
        _serverAvailable = false;
        _cooldownUntil   = Date.now() + 30_000;

        return null;
    }
}

/**
 * Quick health check — useful at startup to log model status.
 *
 * @returns {Promise<boolean>}
 */
async function isHealthy() {
    try {
        const res = await axios.get(`${NLP_BASE_URL}/health`, { timeout: 2000 });
        return res.data?.model_loaded === true;
    } catch (_) {
        return false;
    }
}

module.exports = { classify, isHealthy };
