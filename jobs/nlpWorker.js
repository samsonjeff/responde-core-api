/**
 * jobs/nlpWorker.js
 *
 * Durable Postgres queue worker for NLP classifications.
 * Claims pending/retry/stale-lease jobs from `nlp_jobs` via `FOR UPDATE SKIP LOCKED`,
 * invokes Cloud Run /classify with a 30s cold-start timeout,
 * and patches ML predictions back into `conversations` or `fb_comments`.
 */

"use strict";

const supabase = require("../supabase/client");
const nlpClient = require("../utils/nlpClient");

// Delays in seconds: 10s, 30s, 90s, 5m, 15m, 1h, 4h
const BACKOFF_DELAYS = [10, 30, 90, 300, 900, 3600, 14400];
const MAX_ATTEMPTS = 8;
const WORKER_TIMEOUT_MS = parseInt(process.env.NLP_WORKER_TIMEOUT_MS || "30000", 10);
const LEASE_SECONDS = parseInt(process.env.NLP_JOB_LEASE_SECONDS || "120", 10);

let isRunning = false;

/**
 * Process claimed jobs from public.nlp_jobs.
 * Defaults to batchSize = 1 to prevent sequential head-of-line blocking during cold starts.
 * @param {number} batchSize
 */
async function processNlpJobs(batchSize = 1) {
    if (isRunning) return;
    isRunning = true;

    try {
        // Atomic claim via PostgreSQL stored procedure (SKIP LOCKED + Lease Reclaim)
        const { data: jobs, error: claimError } = await supabase.rpc("claim_nlp_jobs", {
            batch_size: batchSize,
            lease_seconds: LEASE_SECONDS
        });

        if (claimError) {
            if (claimError.code === "42883" || claimError.code === "42P01") {
                console.warn("⚠️ claim_nlp_jobs RPC not found. Run supabase/migrations/20260925_create_nlp_jobs.sql in Supabase SQL Editor.");
            } else {
                console.error("❌ Failed to claim NLP jobs:", claimError.message);
            }
            return;
        }

        if (!jobs || jobs.length === 0) return;

        for (const job of jobs) {
            await handleJob(job);
        }
    } catch (err) {
        console.error("❌ NLP Worker execution error:", err.message);
    } finally {
        isRunning = false;
    }
}

/**
 * Process a single claimed job
 * @param {object} job
 */
async function handleJob(job) {
    try {
        const nlp = await nlpClient.classify(job.source_text, {
            timeoutMs: WORKER_TIMEOUT_MS,
            throwOnError: true
        });

        if (!nlp) {
            throw new Error("NLP server returned empty response");
        }

        // Atomic completion: verifies lease ownership, completes job, and patches parent table in ONE transaction
        const { data: success, error: rpcErr } = await supabase.rpc("complete_nlp_job", {
            p_job_id: job.id,
            p_lock_token: job.lock_token || null,
            p_source_text: job.source_text,
            p_nlp_result: nlp
        });

        if (rpcErr) {
            throw new Error(`complete_nlp_job RPC failed: ${rpcErr.message}`);
        }

        if (!success) {
            console.log(`ℹ️ Outbox job ${job.id} lease expired, requeued, or text edited; parent write cleanly fenced.`);
        } else {
            console.log(`✅ NLP Completed [${job.entity_id}]: intent=${nlp.intent} urgency=${nlp.urgency} incident=${nlp.incident_type}`);
        }

    } catch (err) {
        const status = err.response?.status;
        const isNonRetryable = status === 422 || status === 400 || status === 401 || status === 403;
        const isExhausted = job.attempts >= MAX_ATTEMPTS;

        console.warn(`⚠️ NLP Worker job failed [${job.id}] (Attempt ${job.attempts}/${MAX_ATTEMPTS}): ${err.message}`);

        if (isNonRetryable || isExhausted) {
            // Atomic failure: verifies lease ownership, marks job failed, and sets conversation.ml_status = 'failed' in ONE transaction
            const { data: failedSuccess, error: failRpcErr } = await supabase.rpc("fail_nlp_job", {
                p_job_id: job.id,
                p_lock_token: job.lock_token || null,
                p_source_text: job.source_text,
                p_error_message: err.message || "Unknown error"
            });

            if (failRpcErr) {
                console.warn(`⚠️ fail_nlp_job RPC failed for job ${job.id}:`, failRpcErr.message);
            } else if (!failedSuccess) {
                console.log(`ℹ️ Job ${job.id} lease expired or requeued; failure write cleanly fenced.`);
            }
        } else {
            const delaySec = BACKOFF_DELAYS[job.attempts - 1] || 14400;
            const nextAttempt = new Date(Date.now() + delaySec * 1000).toISOString();

            const { data: retriedRows, error: retryErr } = await supabase
                .from("nlp_jobs")
                .update({
                    status: "retry",
                    next_attempt_at: nextAttempt,
                    last_error: err.message,
                    updated_at: new Date().toISOString()
                })
                .eq("id", job.id)
                .eq("lock_token", job.lock_token)
                .eq("status", "processing")
                .eq("source_text", job.source_text)
                .select();

            if (retryErr) {
                console.warn(`⚠️ Failed to mark job ${job.id} as retry:`, retryErr.message);
            } else if (!retriedRows || retriedRows.length === 0) {
                console.log(`ℹ️ Job ${job.id} lease expired or requeued; retry write cleanly fenced.`);
            }
        }
    }
}

/**
 * Trigger immediate execution without blocking the caller.
 */
function kick() {
    setImmediate(() => {
        processNlpJobs().catch(() => {});
    });
}

module.exports = {
    processNlpJobs,
    kick
};
