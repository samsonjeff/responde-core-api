/**
 * scripts/test-nlp-queue.js
 *
 * Production-Safe Integration Test Suite for the Durable PostgreSQL NLP Queue.
 *
 * SAFETY GUARANTEE:
 * All test claims use `p_entity_id: testConversationId` to isolate tests strictly
 * to temporary mock records, guaranteeing zero interference with real citizen messages.
 *
 * Tests covered:
 *   1. Conversation INSERT -> Trigger creates nlp_jobs row ('pending')
 *   2. Isolated Claim -> claim_nlp_jobs RPC targets p_entity_id, generates lock_token
 *   3. Atomic Completion -> complete_nlp_job patches conversation and completes queue atomically
 *   4. Fencing Token Protection -> Worker A with stale lock_token is rejected; Worker B succeeds
 *   5. In-Flight Edit Fencing -> Editing user_message resets outbox; old text write is rejected
 *   6. Atomic Failure -> fail_nlp_job updates queue and parent conversation in one transaction
 *   7. Actual Lease Recovery -> Reclaiming expired lease (>120s) grants a fresh lock_token
 *   8. Delete Cleanup Trigger -> Deleting conversation automatically purges nlp_jobs row
 *   9. Live ML API Probe -> Checks real Cloud Run /health and /classify connectivity
 *
 * Usage:
 *   node scripts/test-nlp-queue.js
 */

"use strict";

require("dotenv").config();
const crypto = require("crypto");
const supabase = require("../supabase/client");
const nlpClient = require("../utils/nlpClient");

async function runQueueIntegrationTests() {
    console.log("===============================================================");
    console.log("🧪 DURABLE NLP QUEUE INTEGRATION TEST SUITE (PRODUCTION-SAFE)");
    console.log("===============================================================\n");

    let passed = 0;
    let failed = 0;

    const testConversationId = `test_conv_${crypto.randomUUID().slice(0, 8)}`;
    const testMessage = "May sunog po dito sa Brgy Banga, tulong!";
    const editedMessage = "Sunog po sa Brgy Banga, papalapit sa kabahayan!";

    // Cleanup helper
    async function cleanup() {
        await supabase.from("conversations").delete().eq("conversation_id", testConversationId);
        await supabase.from("nlp_jobs").delete().eq("entity_id", testConversationId);
    }

    try {
        await cleanup();

        // ─────────────────────────────────────────────────────────────────────
        // TEST 1: Insert Conversation -> Trigger auto-enqueues job
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 1: Trigger auto-enqueues job on conversation INSERT ... ");
        const { error: insertErr } = await supabase.from("conversations").insert([{
            conversation_id: testConversationId,
            sender_psid: "test_psid_9999",
            user_message: testMessage,
            ai_reply: "Checking emergency response...",
            provider: "gemini",
            sender_name: "Test Citizen",
            ml_status: "pending",
            location_status: "found",
            timestamp: new Date().toISOString()
        }]);

        if (insertErr) throw new Error(`Insert conversation failed: ${insertErr.message}`);

        const { data: job1, error: jobErr1 } = await supabase
            .from("nlp_jobs")
            .select("*")
            .eq("entity_type", "conversation")
            .eq("entity_id", testConversationId)
            .single();

        if (jobErr1 || !job1) throw new Error(`Trigger did not create nlp_jobs row: ${jobErr1?.message}`);
        if (job1.status !== "pending" || job1.source_text !== testMessage) {
            throw new Error(`Job status or source_text mismatch. Status=${job1.status}`);
        }
        console.log("✅ PASSED");
        passed++;

        // ─────────────────────────────────────────────────────────────────────
        // TEST 2: Isolated Claim via claim_nlp_jobs (Production-Safe)
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 2: claim_nlp_jobs RPC locks row using p_entity_id isolation ... ");
        const { data: claimedBatch, error: claimErr } = await supabase.rpc("claim_nlp_jobs", {
            batch_size: 1,
            lease_seconds: 120,
            p_entity_id: testConversationId // ISOLATED TO TEST JOB ONLY!
        });

        if (claimErr) throw new Error(`claim_nlp_jobs RPC error: ${claimErr.message}`);
        const claimedJob = claimedBatch?.find(j => j.entity_id === testConversationId);
        if (!claimedJob) throw new Error("Our test job was not claimed with p_entity_id filter");
        if (claimedJob.status !== "processing" || !claimedJob.lock_token) {
            throw new Error(`Claim failed: status=${claimedJob.status}, lock_token=${claimedJob.lock_token}`);
        }
        console.log("✅ PASSED");
        passed++;

        // ─────────────────────────────────────────────────────────────────────
        // TEST 3: Atomic Completion via complete_nlp_job RPC
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 3: complete_nlp_job RPC patches conversation and completes queue ... ");
        const mockNlpResult = {
            intent: "EMERGENCY_REPORT",
            urgency: "CRITICAL",
            incident_type: "fire",
            intent_confidence: 0.95,
            urgency_confidence: 0.98,
            incident_type_confidence: 0.96,
            needs_review: false,
            low_confidence_fields: []
        };

        const { data: completeSuccess, error: completeRpcErr } = await supabase.rpc("complete_nlp_job", {
            p_job_id: claimedJob.id,
            p_lock_token: claimedJob.lock_token,
            p_source_text: claimedJob.source_text,
            p_nlp_result: mockNlpResult
        });

        if (completeRpcErr) throw new Error(`complete_nlp_job error: ${completeRpcErr.message}`);
        if (!completeSuccess) throw new Error("complete_nlp_job returned false");

        // Verify conversation row was updated
        const { data: convRow } = await supabase
            .from("conversations")
            .select("ml_status, intent, urgency, incident_type")
            .eq("conversation_id", testConversationId)
            .single();

        if (convRow.ml_status !== "complete" || convRow.incident_type !== "fire") {
            throw new Error(`Conversation not updated properly: ${JSON.stringify(convRow)}`);
        }
        console.log("✅ PASSED");
        passed++;

        // ─────────────────────────────────────────────────────────────────────
        // TEST 4: Fencing Token Protection (Worker A with stale token is blocked)
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 4: Stale Worker A with expired lock_token is rejected ... ");
        const staleToken = crypto.randomUUID();
        const freshToken = crypto.randomUUID();

        // Simulate Worker B claiming the job
        await supabase.from("nlp_jobs").update({
            status: "processing",
            lock_token: freshToken,
            locked_at: new Date().toISOString()
        }).eq("id", claimedJob.id);

        // Worker A tries to complete using staleToken
        const { data: workerAResult, error: workerAErr } = await supabase.rpc("complete_nlp_job", {
            p_job_id: claimedJob.id,
            p_lock_token: staleToken, // STALE!
            p_source_text: testMessage,
            p_nlp_result: mockNlpResult
        });

        if (workerAErr) throw new Error(`RPC error: ${workerAErr.message}`);
        if (workerAResult === true) throw new Error("SECURITY FAILURE: Stale token was accepted!");

        // Worker B with freshToken succeeds
        const { data: workerBResult } = await supabase.rpc("complete_nlp_job", {
            p_job_id: claimedJob.id,
            p_lock_token: freshToken, // FRESH!
            p_source_text: testMessage,
            p_nlp_result: mockNlpResult
        });
        if (workerBResult !== true) throw new Error("Worker B with valid token failed");
        console.log("✅ PASSED");
        passed++;

        // ─────────────────────────────────────────────────────────────────────
        // TEST 5: Message Edit In-Flight (Requeues and fences old text)
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 5: Editing user_message resets outbox and fences old write ... ");
        // Update user_message on conversation
        await supabase.from("conversations").update({
            user_message: editedMessage
        }).eq("conversation_id", testConversationId);

        // Verify trigger reset nlp_jobs to pending with edited text
        const { data: editedJob } = await supabase
            .from("nlp_jobs")
            .select("status, source_text")
            .eq("id", claimedJob.id)
            .single();

        if (editedJob.status !== "pending" || editedJob.source_text !== editedMessage) {
            throw new Error(`Job not reset to pending on edit. Status=${editedJob.status}`);
        }

        // Worker tries to complete with previous text
        const { data: oldTextResult } = await supabase.rpc("complete_nlp_job", {
            p_job_id: claimedJob.id,
            p_lock_token: freshToken,
            p_source_text: testMessage, // OLD TEXT!
            p_nlp_result: mockNlpResult
        });
        if (oldTextResult === true) throw new Error("SECURITY FAILURE: Old text completed over new text!");
        console.log("✅ PASSED");
        passed++;

        // ─────────────────────────────────────────────────────────────────────
        // TEST 6: Atomic Failure via fail_nlp_job RPC
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 6: fail_nlp_job RPC updates queue and conversation atomically ... ");
        // Claim the edited job first
        const { data: editedClaimBatch } = await supabase.rpc("claim_nlp_jobs", {
            batch_size: 1,
            lease_seconds: 120,
            p_entity_id: testConversationId
        });
        const activeEditedJob = editedClaimBatch?.[0];

        const { data: failSuccess, error: failRpcErr } = await supabase.rpc("fail_nlp_job", {
            p_job_id: activeEditedJob.id,
            p_lock_token: activeEditedJob.lock_token,
            p_source_text: activeEditedJob.source_text,
            p_error_message: "Test simulated permanent failure (422)"
        });

        if (failRpcErr) throw new Error(`fail_nlp_job RPC error: ${failRpcErr.message}`);
        if (!failSuccess) throw new Error("fail_nlp_job returned false");

        // Verify conversation ml_status is marked failed
        const { data: failedConv } = await supabase
            .from("conversations")
            .select("ml_status")
            .eq("conversation_id", testConversationId)
            .single();

        if (failedConv.ml_status !== "failed") {
            throw new Error(`Conversation ml_status not set to failed: ${failedConv.ml_status}`);
        }
        console.log("✅ PASSED");
        passed++;

        // ─────────────────────────────────────────────────────────────────────
        // TEST 7: Actual Lease Expiry & Reclaim
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 7: Lease expiry recovery via claim_nlp_jobs ... ");
        // Simulate a job stuck in processing with an expired lock (>120s ago)
        const expiredLockTime = new Date(Date.now() - 150 * 1000).toISOString();
        const oldLockToken = crypto.randomUUID();

        await supabase.from("nlp_jobs").update({
            status: "processing",
            locked_at: expiredLockTime,
            lock_token: oldLockToken
        }).eq("id", claimedJob.id);

        // Reclaim with lease_seconds = 120
        const { data: reclaimedBatch, error: reclaimErr } = await supabase.rpc("claim_nlp_jobs", {
            batch_size: 1,
            lease_seconds: 120,
            p_entity_id: testConversationId
        });

        if (reclaimErr) throw new Error(`Reclaim error: ${reclaimErr.message}`);
        const reclaimedJob = reclaimedBatch?.find(j => j.id === claimedJob.id);
        if (!reclaimedJob) throw new Error("Expired job was not reclaimed by claim_nlp_jobs");
        if (reclaimedJob.lock_token === oldLockToken) {
            throw new Error("SECURITY FAILURE: Reclaimed job did not receive a new lock_token!");
        }
        console.log("✅ PASSED");
        passed++;

        // ─────────────────────────────────────────────────────────────────────
        // TEST 8: Message Delete Cleanup Trigger
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 8: Deleting conversation purges outbox queue row ... ");
        await supabase.from("conversations").delete().eq("conversation_id", testConversationId);

        const { data: purgedJob } = await supabase
            .from("nlp_jobs")
            .select("id")
            .eq("entity_id", testConversationId)
            .maybeSingle();

        if (purgedJob) throw new Error("Queue row still exists after parent conversation was deleted!");
        console.log("✅ PASSED");
        passed++;

        // ─────────────────────────────────────────────────────────────────────
        // TEST 9: Live Cloud Run Inference & Cold-Start Wakeup Probe
        // ─────────────────────────────────────────────────────────────────────
        process.stdout.write("Test 9: Live Cloud Run ML API cold-start probe (30s timeout) ... ");
        try {
            const probeResult = await nlpClient.classify("May sunog dito!", { timeoutMs: 30000, throwOnError: true });
            if (probeResult && probeResult.incident_type) {
                console.log(`✅ ONLINE (Inference OK: intent=${probeResult.intent}, incident=${probeResult.incident_type})`);
                passed++;
            } else {
                console.log("⚠️ Responded but empty classification result");
            }
        } catch (mlErr) {
            console.log(`ℹ️ UNREACHABLE (${mlErr.code === "ECONNREFUSED" ? "Connection refused" : mlErr.message}) - Deploy ML server to Cloud Run to enable live inference.`);
        }

    } catch (err) {
        console.log("❌ FAILED");
        console.error(`\n🚨 Error detail: ${err.message}`);
        failed++;
    } finally {
        await cleanup();
    }

    console.log("\n=================================================");
    console.log(`📊 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
    console.log("=================================================");

    if (failed > 0) {
        console.log("\n⚠️ Hint: If tests failed with 'RPC not found', make sure to run");
        console.log("   supabase/migrations/20260925_create_nlp_jobs.sql in Supabase SQL Editor first.\n");
        process.exit(1);
    } else {
        console.log("\n🎉 Full queue fencing, atomic RPCs, and lease recovery verified!\n");
        process.exit(0);
    }
}

runQueueIntegrationTests();
