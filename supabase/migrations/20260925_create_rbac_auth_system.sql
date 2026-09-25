-- ==============================================================================
-- Migration: RBAC Authentication & Authorization System
-- ==============================================================================
-- Roles:
--   super_admin  → Full access + role management (password + supabase auth required)
--   admin        → Full access EXCEPT role editing (read, update, delete)
--   staff        → Dashboard view only — no data read/update/delete
--
-- Features:
--   · 7-day persistent sessions (survives browser close)
--   · 5 wrong-password attempts → 24-hour account block
--   · Forgot password via Supabase Auth email
--   · Role promotion to super_admin requires both password + Supabase OTP
--   · Super admin can generate time-limited invite URLs (rotates every 1 hour)
--   · One email per account enforced at DB level
-- ==============================================================================


-- -----------------------------------------------------------------------------
-- 1. ENUM: User Roles
-- -----------------------------------------------------------------------------
do $$ begin
    create type public.user_role as enum ('super_admin', 'admin', 'staff');
exception
    when duplicate_object then null;
end $$;


-- -----------------------------------------------------------------------------
-- 2. TABLE: system_users
--    Core account table. Linked 1-to-1 with Supabase Auth (auth.users) via
--    auth_user_id. Password hash is managed by Supabase Auth.
-- -----------------------------------------------------------------------------
create table if not exists public.system_users (
    id                  uuid primary key default gen_random_uuid(),

    -- Auth identity (Supabase Auth user row)
    auth_user_id        uuid unique references auth.users(id) on delete cascade,

    -- Display / login identity
    username            text not null unique,           -- immutable after creation
    email               text not null unique,           -- managed via Supabase Auth; one email = one account
    phone_number        text,                           -- optional, editable by user

    -- Role-Based Access Control
    role                public.user_role not null default 'staff',

    -- Account health
    is_active           boolean not null default true,
    failed_login_count  integer not null default 0,
    locked_until        timestamptz,                    -- set to now() + 24h on 5th failed attempt

    -- Audit
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    last_login_at       timestamptz,

    -- Constraints
    constraint username_length check (char_length(username) between 3 and 50),
    constraint username_format check (username ~ '^[a-zA-Z0-9_\-\.]+$'),
    constraint phone_format    check (phone_number is null or phone_number ~ '^\+?[0-9\s\-\(\)]{7,20}$')
);

-- Partial index: fast lookup of currently-locked accounts
create index if not exists idx_system_users_locked
    on public.system_users (locked_until)
    where locked_until is not null;

-- Index for role-based queries (e.g. listing all admins)
create index if not exists idx_system_users_role
    on public.system_users (role);

-- Auto-update updated_at on any row change
create or replace function public.set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists trg_system_users_updated_at on public.system_users;
create trigger trg_system_users_updated_at
before update on public.system_users
for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. TABLE: user_sessions
--    Persistent 7-day sessions. Survives browser close.
--    Token is stored as an httpOnly cookie by the API layer.
-- -----------------------------------------------------------------------------
create table if not exists public.user_sessions (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references public.system_users(id) on delete cascade,

    -- Opaque session token sent to the client (httpOnly cookie)
    session_token   text not null unique default encode(gen_random_bytes(48), 'hex'),

    -- Device / client metadata (for audit trail)
    ip_address      inet,
    user_agent      text,

    -- Lifecycle
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null default (now() + interval '7 days'),
    last_active_at  timestamptz not null default now(),
    is_revoked      boolean not null default false
);

-- Fast token validation lookup
create index if not exists idx_user_sessions_token
    on public.user_sessions (session_token)
    where is_revoked = false;

-- Fast expiry cleanup
create index if not exists idx_user_sessions_expires
    on public.user_sessions (expires_at)
    where is_revoked = false;

-- Fast lookup of all sessions for a given user (e.g. "revoke all sessions")
create index if not exists idx_user_sessions_user_id
    on public.user_sessions (user_id);


-- -----------------------------------------------------------------------------
-- 4. TABLE: login_audit_log
--    Immutable append-only log of every login attempt.
-- -----------------------------------------------------------------------------
create table if not exists public.login_audit_log (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references public.system_users(id) on delete set null,
    username_tried  text,                   -- capture attempt even if user does not exist
    success         boolean not null,
    failure_reason  text,                   -- 'bad_password' | 'account_locked' | 'not_found' | etc.
    ip_address      inet,
    user_agent      text,
    attempted_at    timestamptz not null default now()
);

create index if not exists idx_login_audit_user_id
    on public.login_audit_log (user_id, attempted_at desc);

create index if not exists idx_login_audit_ip
    on public.login_audit_log (ip_address, attempted_at desc);


-- -----------------------------------------------------------------------------
-- 5. TABLE: invite_tokens
--    Super admins generate one-time invite URLs for new account creation.
--    Each token is valid for 1 hour; only one active token per issuer at a time.
-- -----------------------------------------------------------------------------
create table if not exists public.invite_tokens (
    id              uuid primary key default gen_random_uuid(),
    token           text not null unique default encode(gen_random_bytes(32), 'hex'),
    issued_by       uuid not null references public.system_users(id) on delete cascade,

    -- The role the new account will be granted upon registration
    target_role     public.user_role not null default 'staff',

    -- Lifecycle
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null default (now() + interval '1 hour'),
    used_at         timestamptz,            -- set when token is consumed
    used_by_user_id uuid references public.system_users(id) on delete set null,
    is_revoked      boolean not null default false
);

-- Fast token lookup on registration page
create index if not exists idx_invite_tokens_token
    on public.invite_tokens (token)
    where used_at is null and is_revoked = false;

-- Enforce only ONE active token per issuer at a time
create unique index if not exists idx_invite_tokens_one_per_issuer
    on public.invite_tokens (issued_by)
    where used_at is null and is_revoked = false and expires_at > now();


-- -----------------------------------------------------------------------------
-- 6. TABLE: role_change_audit_log
--    Every role change is recorded here with confirmation flags.
--    Promotions to super_admin additionally require Supabase Auth OTP.
-- -----------------------------------------------------------------------------
create table if not exists public.role_change_audit_log (
    id                      uuid primary key default gen_random_uuid(),
    changed_by              uuid not null references public.system_users(id) on delete cascade,
    target_user_id          uuid not null references public.system_users(id) on delete cascade,
    old_role                public.user_role not null,
    new_role                public.user_role not null,
    password_confirmed      boolean not null default false,   -- super_admin entered their password
    supabase_auth_confirmed boolean not null default false,   -- required when new_role = 'super_admin'
    changed_at              timestamptz not null default now(),
    notes                   text
);

create index if not exists idx_role_change_audit_target
    on public.role_change_audit_log (target_user_id, changed_at desc);

create index if not exists idx_role_change_audit_changed_by
    on public.role_change_audit_log (changed_by, changed_at desc);


-- -----------------------------------------------------------------------------
-- 7. FUNCTION: record_login_attempt
--    Called by the backend on every login attempt.
--    Increments failed counter and locks the account after 5 failures (24h).
--    Resets counter on success and records last_login_at.
-- -----------------------------------------------------------------------------
create or replace function public.record_login_attempt(
    p_user_id        uuid,
    p_username_tried text,
    p_success        boolean,
    p_failure_reason text  default null,
    p_ip_address     inet  default null,
    p_user_agent     text  default null
)
returns jsonb as $$
declare
    v_new_count    integer;
    v_locked_until timestamptz;
begin
    -- Always write an immutable audit log row
    insert into public.login_audit_log
        (user_id, username_tried, success, failure_reason, ip_address, user_agent)
    values
        (p_user_id, p_username_tried, p_success, p_failure_reason, p_ip_address, p_user_agent);

    -- If user does not exist (wrong username), we are done
    if p_user_id is null then
        return jsonb_build_object('ok', false, 'reason', 'user_not_found');
    end if;

    if p_success then
        -- Successful login: reset failure counter, record last login
        update public.system_users
        set failed_login_count = 0,
            locked_until       = null,
            last_login_at      = now(),
            updated_at         = now()
        where id = p_user_id;

        return jsonb_build_object('ok', true);
    else
        -- Failed login: increment counter
        update public.system_users
        set failed_login_count = failed_login_count + 1,
            updated_at         = now()
        where id = p_user_id
        returning failed_login_count, locked_until
        into v_new_count, v_locked_until;

        -- Lock account on 5th (or more) failure for 24 hours
        if v_new_count >= 5 then
            update public.system_users
            set locked_until = now() + interval '24 hours',
                updated_at   = now()
            where id = p_user_id
            returning locked_until into v_locked_until;

            return jsonb_build_object(
                'ok',           false,
                'reason',       'account_locked',
                'locked_until', v_locked_until,
                'attempts',     v_new_count
            );
        end if;

        return jsonb_build_object(
            'ok',       false,
            'reason',   coalesce(p_failure_reason, 'bad_password'),
            'attempts', v_new_count,
            'remaining', (5 - v_new_count)
        );
    end if;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.record_login_attempt(uuid, text, boolean, text, inet, text)
    from public, anon, authenticated;
grant  execute on function public.record_login_attempt(uuid, text, boolean, text, inet, text)
    to service_role;


-- -----------------------------------------------------------------------------
-- 8. FUNCTION: create_user_session
--    Issues a fresh 7-day session token for an authenticated user.
--    Returns the token so the backend can set it as an httpOnly cookie.
-- -----------------------------------------------------------------------------
create or replace function public.create_user_session(
    p_user_id uuid,
    p_ip      inet default null,
    p_agent   text default null
)
returns text as $$
declare
    v_token text;
begin
    insert into public.user_sessions (user_id, ip_address, user_agent)
    values (p_user_id, p_ip, p_agent)
    returning session_token into v_token;

    return v_token;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.create_user_session(uuid, inet, text) from public, anon, authenticated;
grant  execute on function public.create_user_session(uuid, inet, text) to service_role;


-- -----------------------------------------------------------------------------
-- 9. FUNCTION: validate_session
--    Backend calls this on every authenticated request.
--    Slides last_active_at (rolling heartbeat) and returns user profile + role.
-- -----------------------------------------------------------------------------
create or replace function public.validate_session(p_token text)
returns jsonb as $$
declare
    v_session public.user_sessions%rowtype;
    v_user    public.system_users%rowtype;
begin
    select * into v_session
    from public.user_sessions
    where session_token = p_token
      and is_revoked    = false
      and expires_at    > now();

    if not found then
        return jsonb_build_object('valid', false, 'reason', 'session_not_found_or_expired');
    end if;

    select * into v_user
    from public.system_users
    where id        = v_session.user_id
      and is_active = true;

    if not found then
        return jsonb_build_object('valid', false, 'reason', 'user_inactive_or_deleted');
    end if;

    -- Check if account is locked
    if v_user.locked_until is not null and v_user.locked_until > now() then
        return jsonb_build_object(
            'valid',        false,
            'reason',       'account_locked',
            'locked_until', v_user.locked_until
        );
    end if;

    -- Slide the last_active_at (session heartbeat)
    update public.user_sessions
    set last_active_at = now()
    where id = v_session.id;

    return jsonb_build_object(
        'valid',        true,
        'user_id',      v_user.id,
        'auth_user_id', v_user.auth_user_id,
        'username',     v_user.username,
        'email',        v_user.email,
        'phone_number', v_user.phone_number,
        'role',         v_user.role,
        'expires_at',   v_session.expires_at
    );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.validate_session(text) from public, anon, authenticated;
grant  execute on function public.validate_session(text) to service_role;


-- -----------------------------------------------------------------------------
-- 10. FUNCTION: revoke_session / revoke_all_sessions
--     Single logout or sign-out-everywhere for a user.
-- -----------------------------------------------------------------------------
create or replace function public.revoke_session(p_token text)
returns boolean as $$
declare v_count int;
begin
    update public.user_sessions
    set is_revoked = true
    where session_token = p_token and is_revoked = false;

    get diagnostics v_count = row_count;
    return v_count > 0;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create or replace function public.revoke_all_sessions(p_user_id uuid)
returns integer as $$
declare v_count int;
begin
    update public.user_sessions
    set is_revoked = true
    where user_id = p_user_id and is_revoked = false;

    get diagnostics v_count = row_count;
    return v_count;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.revoke_session(text)      from public, anon, authenticated;
revoke execute on function public.revoke_all_sessions(uuid) from public, anon, authenticated;
grant  execute on function public.revoke_session(text)      to service_role;
grant  execute on function public.revoke_all_sessions(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 11. FUNCTION: generate_invite_token
--     Super admin generates a 1-hour registration invite URL token.
--     Revokes any existing live token from the same issuer first.
-- -----------------------------------------------------------------------------
create or replace function public.generate_invite_token(
    p_issued_by   uuid,
    p_target_role public.user_role default 'staff'
)
returns text as $$
declare
    v_token text;
begin
    -- Revoke any existing live token from this issuer
    update public.invite_tokens
    set is_revoked = true
    where issued_by  = p_issued_by
      and used_at    is null
      and is_revoked = false
      and expires_at > now();

    -- Issue fresh 1-hour token
    insert into public.invite_tokens (issued_by, target_role)
    values (p_issued_by, p_target_role)
    returning token into v_token;

    return v_token;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.generate_invite_token(uuid, public.user_role) from public, anon, authenticated;
grant  execute on function public.generate_invite_token(uuid, public.user_role) to service_role;


-- -----------------------------------------------------------------------------
-- 12. FUNCTION: consume_invite_token
--     Called during account registration. Validates the token, marks it used,
--     returns the target_role so the backend can assign it to the new user.
--     Returns null if token is invalid, expired, or already used.
-- -----------------------------------------------------------------------------
create or replace function public.consume_invite_token(
    p_token       text,
    p_new_user_id uuid
)
returns public.user_role as $$
declare
    v_role public.user_role;
begin
    update public.invite_tokens
    set used_at         = now(),
        used_by_user_id = p_new_user_id
    where token      = p_token
      and used_at    is null
      and is_revoked = false
      and expires_at > now()
    returning target_role into v_role;

    return v_role; -- null if no matching row (invalid/expired/used)
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.consume_invite_token(text, uuid) from public, anon, authenticated;
grant  execute on function public.consume_invite_token(text, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 13. FUNCTION: change_user_role
--     Only callable by the backend AFTER it has verified:
--       a) the calling super_admin's password     (p_password_confirmed = true)
--       b) Supabase Auth OTP if promoting to super_admin
--     Writes to role_change_audit_log for full traceability.
-- -----------------------------------------------------------------------------
create or replace function public.change_user_role(
    p_changed_by              uuid,
    p_target_user_id          uuid,
    p_new_role                public.user_role,
    p_password_confirmed      boolean,
    p_supabase_auth_confirmed boolean default false,
    p_notes                   text    default null
)
returns jsonb as $$
declare
    v_changer  public.system_users%rowtype;
    v_target   public.system_users%rowtype;
    v_old_role public.user_role;
begin
    -- Only super_admin can change roles
    select * into v_changer from public.system_users where id = p_changed_by;
    if not found or v_changer.role <> 'super_admin' then
        return jsonb_build_object('ok', false, 'reason', 'forbidden_not_super_admin');
    end if;

    -- Password must always be confirmed
    if not p_password_confirmed then
        return jsonb_build_object('ok', false, 'reason', 'password_not_confirmed');
    end if;

    -- Promoting to super_admin requires Supabase Auth OTP as well
    if p_new_role = 'super_admin' and not p_supabase_auth_confirmed then
        return jsonb_build_object('ok', false, 'reason', 'supabase_auth_required_for_super_admin');
    end if;

    select * into v_target from public.system_users where id = p_target_user_id;
    if not found then
        return jsonb_build_object('ok', false, 'reason', 'target_user_not_found');
    end if;

    v_old_role := v_target.role;

    update public.system_users
    set role       = p_new_role,
        updated_at = now()
    where id = p_target_user_id;

    insert into public.role_change_audit_log
        (changed_by, target_user_id, old_role, new_role, password_confirmed, supabase_auth_confirmed, notes)
    values
        (p_changed_by, p_target_user_id, v_old_role, p_new_role, p_password_confirmed, p_supabase_auth_confirmed, p_notes);

    return jsonb_build_object(
        'ok',       true,
        'old_role', v_old_role,
        'new_role', p_new_role
    );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.change_user_role(uuid, uuid, public.user_role, boolean, boolean, text)
    from public, anon, authenticated;
grant  execute on function public.change_user_role(uuid, uuid, public.user_role, boolean, boolean, text)
    to service_role;


-- -----------------------------------------------------------------------------
-- 14. FUNCTION: cleanup_expired_sessions
--     Purge expired and revoked sessions older than 30 days.
--     Run via pg_cron or a nightly backend job.
-- -----------------------------------------------------------------------------
create or replace function public.cleanup_expired_sessions()
returns integer as $$
declare v_count int;
begin
    delete from public.user_sessions
    where (expires_at < now() or is_revoked = true)
      and created_at  < now() - interval '30 days';

    get diagnostics v_count = row_count;
    return v_count;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.cleanup_expired_sessions() from public, anon, authenticated;
grant  execute on function public.cleanup_expired_sessions() to service_role;


-- -----------------------------------------------------------------------------
-- 15. FUNCTION: cleanup_expired_invites
--     Soft-revoke invite tokens that passed their 1-hour TTL.
-- -----------------------------------------------------------------------------
create or replace function public.cleanup_expired_invites()
returns integer as $$
declare v_count int;
begin
    update public.invite_tokens
    set is_revoked = true
    where expires_at < now()
      and used_at    is null
      and is_revoked = false;

    get diagnostics v_count = row_count;
    return v_count;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.cleanup_expired_invites() from public, anon, authenticated;
grant  execute on function public.cleanup_expired_invites() to service_role;


-- -----------------------------------------------------------------------------
-- 16. ROW LEVEL SECURITY
--     All tables are locked down. Only the service_role key (used by your
--     backend API) can read or write these tables. anon and authenticated
--     JWT roles have zero direct access.
-- -----------------------------------------------------------------------------
alter table public.system_users          enable row level security;
alter table public.user_sessions         enable row level security;
alter table public.login_audit_log       enable row level security;
alter table public.invite_tokens         enable row level security;
alter table public.role_change_audit_log enable row level security;

drop policy if exists "Service role full access to system_users"          on public.system_users;
drop policy if exists "Service role full access to user_sessions"         on public.user_sessions;
drop policy if exists "Service role full access to login_audit_log"       on public.login_audit_log;
drop policy if exists "Service role full access to invite_tokens"         on public.invite_tokens;
drop policy if exists "Service role full access to role_change_audit_log" on public.role_change_audit_log;

create policy "Service role full access to system_users"
    on public.system_users for all to service_role using (true) with check (true);

create policy "Service role full access to user_sessions"
    on public.user_sessions for all to service_role using (true) with check (true);

create policy "Service role full access to login_audit_log"
    on public.login_audit_log for all to service_role using (true) with check (true);

create policy "Service role full access to invite_tokens"
    on public.invite_tokens for all to service_role using (true) with check (true);

create policy "Service role full access to role_change_audit_log"
    on public.role_change_audit_log for all to service_role using (true) with check (true);


-- -----------------------------------------------------------------------------
-- 17. SUPABASE AUTH HOOK: auto-create system_users row on signup
--     When a new Supabase Auth user is created (after consuming an invite link),
--     this trigger inserts a matching system_users row.
--     The backend must pass username and role via user_metadata on signup.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger as $$
declare
    v_username text;
    v_role     public.user_role;
    v_phone    text;
begin
    v_username := new.raw_user_meta_data ->> 'username';
    v_phone    := new.raw_user_meta_data ->> 'phone_number';

    -- Safely cast role from metadata; default to 'staff'
    begin
        v_role := (new.raw_user_meta_data ->> 'role')::public.user_role;
    exception when invalid_text_representation then
        v_role := 'staff';
    end;

    -- Fallback: use email prefix as username if not provided
    if v_username is null then
        v_username := split_part(new.email, '@', 1);
    end if;

    insert into public.system_users
        (auth_user_id, username, email, phone_number, role)
    values
        (new.id, v_username, new.email, v_phone, coalesce(v_role, 'staff'))
    on conflict (auth_user_id) do nothing; -- idempotent

    return new;
end;
$$ language plpgsql security definer set search_path = public, auth, pg_temp;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();


-- -----------------------------------------------------------------------------
-- 18. SUPABASE AUTH HOOK: sync email changes back to system_users
--     When a user updates their email via Supabase Auth (forgot password flow
--     or manual change), keep our system_users table in sync.
-- -----------------------------------------------------------------------------
create or replace function public.handle_auth_user_email_update()
returns trigger as $$
begin
    if new.email is distinct from old.email then
        update public.system_users
        set email      = new.email,
            updated_at = now()
        where auth_user_id = new.id;
    end if;
    return new;
end;
$$ language plpgsql security definer set search_path = public, auth, pg_temp;

drop trigger if exists trg_on_auth_user_email_updated on auth.users;
create trigger trg_on_auth_user_email_updated
after update of email on auth.users
for each row execute function public.handle_auth_user_email_update();


-- ==============================================================================
-- MIGRATION COMPLETE
-- ==============================================================================
-- Tables created:
--   public.system_users          -- core account data + RBAC role
--   public.user_sessions         -- 7-day persistent token-based sessions
--   public.login_audit_log       -- immutable failed/success login log
--   public.invite_tokens         -- 1-hour rotating registration invite URLs
--   public.role_change_audit_log -- full audit trail of all role edits
--
-- RPC functions (service_role only):
--   record_login_attempt()       -- handles 5-attempt lockout logic
--   create_user_session()        -- issues a 7-day session token
--   validate_session()           -- validates token + slides last_active_at
--   revoke_session()             -- single logout
--   revoke_all_sessions()        -- sign out everywhere
--   generate_invite_token()      -- super_admin issues a new invite URL
--   consume_invite_token()       -- registration page consumes + assigns role
--   change_user_role()           -- guarded role change with audit trail
--   cleanup_expired_sessions()   -- housekeeping (run via pg_cron or backend job)
--   cleanup_expired_invites()    -- housekeeping (run via pg_cron or backend job)
--
-- Auth triggers (auth.users):
--   trg_on_auth_user_created     -- auto-creates system_users row on signup
--   trg_on_auth_user_email_updated -- syncs email changes to system_users
-- ==============================================================================
