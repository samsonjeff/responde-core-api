-- ==============================================================================
-- Migration: Create Durable NLP Jobs Outbox & Queue (Atomic Transactional Fencing)
-- ==============================================================================

-- 1. Create durable outbox table (safe for fresh runs and re-runs)
create table if not exists public.nlp_jobs (
    id uuid primary key default gen_random_uuid(),
    entity_type text not null check (entity_type in ('conversation', 'fb_comment')),
    entity_id text not null,
    source_text text not null,
    status text not null default 'pending' check (status in ('pending', 'processing', 'retry', 'complete', 'failed')),
    attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    locked_at timestamptz,
    lock_token uuid,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (entity_type, entity_id)
);

-- Ensure lock_token column exists if table was previously created
alter table public.nlp_jobs add column if not exists lock_token uuid;

-- Index for high-performance worker polling with SKIP LOCKED and lease timeout
create index if not exists idx_nlp_jobs_queue 
on public.nlp_jobs (status, next_attempt_at, locked_at) 
where status in ('pending', 'retry', 'processing');

-- Enable Row Level Security (RLS) for privacy & compliance
alter table public.nlp_jobs enable row level security;

-- Only service-role key (used by backend/workers) has access; anon/public cannot read raw texts
drop policy if exists "Service role full access to nlp_jobs" on public.nlp_jobs;
create policy "Service role full access to nlp_jobs"
on public.nlp_jobs
for all
to service_role
using (true)
with check (true);

-- 2. Atomic claim function with LEASE TIMEOUT, FENCING LOCK TOKEN, and optional ENTITY ISOLATION
-- Drop old overloads to prevent ambiguous function signature errors in PostgREST
drop function if exists public.claim_nlp_jobs(integer);
drop function if exists public.claim_nlp_jobs(integer, integer);
drop function if exists public.claim_nlp_jobs(integer, integer, text);

create or replace function public.claim_nlp_jobs(
    batch_size int default 1,
    lease_seconds int default 120,
    p_entity_id text default null
)
returns setof public.nlp_jobs as $$
with claimed as (
    select id
    from public.nlp_jobs
    where (
        -- Optional specific entity targeting (for safe isolated testing or dedicated entity workers)
        (p_entity_id is null or entity_id = p_entity_id)
        and
        (
            -- Standard eligible pending or retry jobs
            (status in ('pending', 'retry') and next_attempt_at <= now())
            or
            -- Lease expiry: reclaim jobs stuck in processing if worker crashed or timed out
            (status = 'processing' and locked_at < now() - (lease_seconds || ' seconds')::interval)
        )
    )
    order by created_at asc
    for update skip locked
    limit batch_size
)
update public.nlp_jobs j
set status = 'processing',
    locked_at = now(),
    lock_token = gen_random_uuid(),
    attempts = attempts + 1,
    updated_at = now()
from claimed
where j.id = claimed.id
returning j.*;
$$ language sql security definer set search_path = public, pg_temp;

-- Revoke public execution of claim RPC; grant strictly to service role
revoke execute on function public.claim_nlp_jobs(int, int, text) from public, anon, authenticated;
grant execute on function public.claim_nlp_jobs(int, int, text) to service_role;

-- 3. Atomic Completion Function (Fences both parent row and queue update in one transaction)
create or replace function public.complete_nlp_job(
    p_job_id uuid,
    p_lock_token uuid,
    p_source_text text,
    p_nlp_result jsonb
)
returns boolean as $$
declare
    v_job public.nlp_jobs%rowtype;
    v_rows_affected int;
begin
    -- Step 1: Verify active lease ownership. Fail closed if lock_token does not match.
    update public.nlp_jobs
    set status = 'complete',
        updated_at = now()
    where id = p_job_id
      and lock_token = p_lock_token
      and status = 'processing'
      and source_text = p_source_text
    returning * into v_job;

    if not found then
        -- Expired lease, stolen by another worker, or text changed: cleanly discard
        return false;
    end if;

    -- Step 2: Atomically patch parent table in the exact same transaction
    if v_job.entity_type = 'conversation' then
        update public.conversations
        set ml_status = 'complete',
            ml_last_attempted_at = now(),
            intent = p_nlp_result->>'intent',
            urgency = p_nlp_result->>'urgency',
            incident_type = p_nlp_result->>'incident_type',
            intent_confidence = (p_nlp_result->>'intent_confidence')::numeric,
            urgency_confidence = (p_nlp_result->>'urgency_confidence')::numeric,
            incident_type_confidence = (p_nlp_result->>'incident_type_confidence')::numeric,
            needs_review = coalesce((p_nlp_result->>'needs_review')::boolean, false),
            low_confidence_fields = p_nlp_result->'low_confidence_fields'
        where conversation_id = v_job.entity_id
          and user_message = p_source_text;

        get diagnostics v_rows_affected = row_count;
        if v_rows_affected != 1 then
            raise exception 'Parent conversation % was not updated (affected % rows)', v_job.entity_id, v_rows_affected;
        end if;
    elsif v_job.entity_type = 'fb_comment' then
        update public.fb_comments
        set incident_type = p_nlp_result->>'incident_type'
        where id = v_job.entity_id
          and comment_text = p_source_text;

        get diagnostics v_rows_affected = row_count;
        if v_rows_affected != 1 then
            raise exception 'Parent fb_comment % was not updated (affected % rows)', v_job.entity_id, v_rows_affected;
        end if;
    end if;

    return true;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.complete_nlp_job(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_nlp_job(uuid, uuid, text, jsonb) to service_role;

-- 4. Atomic Failure Function (Fences both parent row and queue update in one transaction)
create or replace function public.fail_nlp_job(
    p_job_id uuid,
    p_lock_token uuid,
    p_source_text text,
    p_error_message text
)
returns boolean as $$
declare
    v_job public.nlp_jobs%rowtype;
    v_rows_affected int;
begin
    -- Step 1: Verify active lease ownership. Fail closed if lock_token does not match.
    update public.nlp_jobs
    set status = 'failed',
        last_error = p_error_message,
        updated_at = now()
    where id = p_job_id
      and lock_token = p_lock_token
      and status = 'processing'
      and source_text = p_source_text
    returning * into v_job;

    if not found then
        -- Fenced! Worker was preempted or text changed; do not alter parent table
        return false;
    end if;

    -- Step 2: Atomically mark parent conversation as failed
    if v_job.entity_type = 'conversation' then
        update public.conversations
        set ml_status = 'failed',
            ml_last_attempted_at = now()
        where conversation_id = v_job.entity_id
          and user_message = p_source_text;

        get diagnostics v_rows_affected = row_count;
        if v_rows_affected != 1 then
            raise exception 'Parent conversation % was not updated to failed (affected % rows)', v_job.entity_id, v_rows_affected;
        end if;
    end if;

    return true;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.fail_nlp_job(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_nlp_job(uuid, uuid, text, text) to service_role;

-- 4. Trigger function to auto-enqueue jobs
create or replace function public.enqueue_nlp_job()
returns trigger as $$
begin
    if tg_table_name = 'conversations' then
        if (TG_OP = 'INSERT') or (TG_OP = 'UPDATE' and old.user_message is distinct from new.user_message) then
            insert into public.nlp_jobs (entity_type, entity_id, source_text, status)
            values ('conversation', new.conversation_id, new.user_message, 'pending')
            on conflict (entity_type, entity_id) do update
            set source_text = excluded.source_text,
                status = 'pending',
                next_attempt_at = now(),
                attempts = 0,
                updated_at = now();
        end if;
    elsif tg_table_name = 'fb_comments' then
        if (TG_OP = 'INSERT') or (TG_OP = 'UPDATE' and old.comment_text is distinct from new.comment_text) then
            insert into public.nlp_jobs (entity_type, entity_id, source_text, status)
            values ('fb_comment', new.id, new.comment_text, 'pending')
            on conflict (entity_type, entity_id) do update
            set source_text = excluded.source_text,
                status = 'pending',
                next_attempt_at = now(),
                attempts = 0,
                updated_at = now();
        end if;
    end if;
    return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Triggers (restricted strictly to text columns to prevent classification loops)
drop trigger if exists trg_conversations_nlp_job on public.conversations;
create trigger trg_conversations_nlp_job
after insert or update of user_message on public.conversations
for each row execute function public.enqueue_nlp_job();

drop trigger if exists trg_fb_comments_nlp_job on public.fb_comments;
create trigger trg_fb_comments_nlp_job
after insert or update of comment_text on public.fb_comments
for each row execute function public.enqueue_nlp_job();

-- 5. Delete cleanup triggers: automatically purge outbox jobs when parent row is deleted
create or replace function public.cleanup_deleted_nlp_job()
returns trigger as $$
begin
    if tg_table_name = 'conversations' then
        delete from public.nlp_jobs
        where entity_type = 'conversation' and entity_id = old.conversation_id;
    elsif tg_table_name = 'fb_comments' then
        delete from public.nlp_jobs
        where entity_type = 'fb_comment' and entity_id = old.id;
    end if;
    return old;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists trg_conversations_cleanup_nlp_job on public.conversations;
create trigger trg_conversations_cleanup_nlp_job
after delete on public.conversations
for each row execute function public.cleanup_deleted_nlp_job();

drop trigger if exists trg_fb_comments_cleanup_nlp_job on public.fb_comments;
create trigger trg_fb_comments_cleanup_nlp_job
after delete on public.fb_comments
for each row execute function public.cleanup_deleted_nlp_job();
