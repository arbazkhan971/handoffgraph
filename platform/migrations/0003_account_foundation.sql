-- Hosted account, session, membership, entitlement, and atomic quota
-- foundation. This migration intentionally does NOT guess entitlements for
-- legacy workspaces: missing entitlements fail hosted ingest closed until an
-- operator explicitly provisions or suspends them.

-- Workstream protocol IDs are scoped by the authenticated workspace. The v1
-- schema used a global id primary key, allowing another tenant's known ID to
-- suppress this tenant's derived projection. Rebuild with the tenant-scoped
-- identity used by every platform query.
ALTER TABLE workstreams RENAME TO workstreams_legacy_0003;

CREATE TABLE workstreams (
    id                 TEXT NOT NULL,
    workspace_id       TEXT NOT NULL,
    repository_id      TEXT,
    title              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active',
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    title_event_at_ms  INTEGER,
    title_event_id     TEXT,
    status_event_at_ms INTEGER,
    status_event_id    TEXT,
    PRIMARY KEY (workspace_id, id)
);

INSERT INTO workstreams
    (id, workspace_id, repository_id, title, status, created_at, updated_at,
     title_event_at_ms, title_event_id, status_event_at_ms, status_event_id)
SELECT id, workspace_id, repository_id, title, status, created_at, updated_at,
       title_event_at_ms, title_event_id, status_event_at_ms, status_event_id
FROM workstreams_legacy_0003;

DROP TABLE workstreams_legacy_0003;
CREATE INDEX idx_workstreams_workspace ON workstreams(workspace_id);

CREATE TABLE users (
    id                    TEXT PRIMARY KEY
                          CHECK(length(id) = 30 AND substr(id, 1, 4) = 'usr_' AND
                                substr(id, 5, 1) GLOB '[0-7]' AND
                                substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    email                 TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(email)) > 0),
    display_name          TEXT,
    avatar_url            TEXT,
    email_verified        INTEGER NOT NULL DEFAULT 0
                          CHECK(email_verified IN (0, 1)),
    status                TEXT NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active', 'disabled', 'deleted')),
    personal_workspace_id TEXT NOT NULL UNIQUE
                          REFERENCES workspaces(id) ON DELETE RESTRICT
                          CHECK(length(personal_workspace_id) = 30 AND
                                substr(personal_workspace_id, 1, 4) = 'wsp_' AND
                                substr(personal_workspace_id, 5, 1) GLOB '[0-7]' AND
                                substr(personal_workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    created_at            INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at            INTEGER NOT NULL CHECK(updated_at >= created_at)
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE provider_identities (
    provider         TEXT NOT NULL CHECK(length(provider) > 0),
    provider_subject TEXT NOT NULL CHECK(length(provider_subject) > 0),
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email            TEXT COLLATE NOCASE,
    created_at       INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at       INTEGER NOT NULL CHECK(updated_at >= created_at),
    PRIMARY KEY (provider, provider_subject)
);
CREATE INDEX idx_provider_identities_user ON provider_identities(user_id);
CREATE INDEX idx_provider_identities_email ON provider_identities(email);

CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member'
                 CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
    status       TEXT NOT NULL DEFAULT 'active'
                 CHECK(status IN ('active', 'suspended', 'removed')),
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX idx_workspace_members_workspace_status
    ON workspace_members(workspace_id, status);

CREATE TABLE account_sessions (
    id           TEXT PRIMARY KEY
                 CHECK(length(id) = 30 AND substr(id, 1, 4) = 'acs_' AND
                       substr(id, 5, 1) GLOB '[0-7]' AND
                       substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE
                 CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    csrf_hash    TEXT NOT NULL
                 CHECK(length(csrf_hash) = 64 AND csrf_hash NOT GLOB '*[^0-9a-f]*'),
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    expires_at   INTEGER NOT NULL CHECK(expires_at > created_at),
    last_seen_at INTEGER,
    revoked_at   INTEGER,
    CHECK(last_seen_at IS NULL OR last_seen_at >= created_at),
    CHECK(revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX idx_account_sessions_user ON account_sessions(user_id);
CREATE INDEX idx_account_sessions_expiry ON account_sessions(expires_at);
CREATE INDEX idx_account_sessions_active_user
    ON account_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

-- OAuth start currently uses short-lived host-only cookies, but this table is
-- retained as a fail-closed persistence option for future providers. Only the
-- hash of the opaque state token is durable.
CREATE TABLE auth_states (
    id            TEXT PRIMARY KEY
                  CHECK(length(id) = 30 AND substr(id, 1, 4) = 'ast_' AND
                        substr(id, 5, 1) GLOB '[0-7]' AND
                        substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    state_hash    TEXT NOT NULL UNIQUE
                  CHECK(length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
    code_verifier TEXT NOT NULL CHECK(length(code_verifier) >= 43),
    intent        TEXT NOT NULL CHECK(length(intent) > 0),
    return_to     TEXT NOT NULL DEFAULT '/',
    created_at    INTEGER NOT NULL CHECK(created_at >= 0),
    expires_at    INTEGER NOT NULL CHECK(expires_at > created_at)
);
CREATE INDEX idx_auth_states_expiry ON auth_states(expires_at);

-- Temporary global lifetime-issuance ceiling for the hosted Basic beta. The
-- historical active_accounts column is intentionally never decremented: a
-- cancelled/deleted beta account does not create another free allocation.
-- This bounds aggregate cost before public abuse controls are provisioned.
CREATE TABLE hosted_beta_capacity (
    id              TEXT PRIMARY KEY CHECK(id = 'global'),
    max_accounts    INTEGER NOT NULL DEFAULT 50 CHECK(max_accounts >= 0),
    active_accounts INTEGER NOT NULL DEFAULT 0
                    CHECK(active_accounts >= 0 AND active_accounts <= max_accounts)
);
INSERT INTO hosted_beta_capacity (id) VALUES ('global');

CREATE TABLE workspace_entitlements (
    workspace_id          TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_id               TEXT NOT NULL DEFAULT 'basic'
                          CHECK(plan_id = 'basic'),
    status                TEXT NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active', 'suspended', 'cancelled')),
    max_devices           INTEGER NOT NULL DEFAULT 2 CHECK(max_devices >= 0),
    active_devices        INTEGER NOT NULL DEFAULT 0 CHECK(active_devices >= 0),
    max_device_issuances  INTEGER NOT NULL DEFAULT 10 CHECK(max_device_issuances >= 0),
    used_device_issuances INTEGER NOT NULL DEFAULT 0 CHECK(used_device_issuances >= 0),
    max_batch_events      INTEGER NOT NULL DEFAULT 100 CHECK(max_batch_events > 0),
    max_batch_bytes       INTEGER NOT NULL DEFAULT 262144 CHECK(max_batch_bytes > 0),
    max_monthly_events    INTEGER NOT NULL DEFAULT 5000 CHECK(max_monthly_events >= 0),
    max_monthly_bytes     INTEGER NOT NULL DEFAULT 10485760 CHECK(max_monthly_bytes >= 0),
    max_lifetime_events   INTEGER NOT NULL DEFAULT 25000 CHECK(max_lifetime_events >= 0),
    max_lifetime_bytes    INTEGER NOT NULL DEFAULT 67108864 CHECK(max_lifetime_bytes >= 0),
    used_monthly_events   INTEGER NOT NULL DEFAULT 0 CHECK(used_monthly_events >= 0),
    used_monthly_bytes    INTEGER NOT NULL DEFAULT 0 CHECK(used_monthly_bytes >= 0),
    used_lifetime_events  INTEGER NOT NULL DEFAULT 0 CHECK(used_lifetime_events >= 0),
    used_lifetime_bytes   INTEGER NOT NULL DEFAULT 0 CHECK(used_lifetime_bytes >= 0),
    period_start          INTEGER NOT NULL CHECK(period_start >= 0),
    period_end            INTEGER NOT NULL CHECK(period_end > period_start),
    created_at            INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at            INTEGER NOT NULL CHECK(updated_at >= created_at),
    CHECK(active_devices <= max_devices),
    CHECK(used_device_issuances <= max_device_issuances),
    CHECK(used_monthly_events <= max_monthly_events),
    CHECK(used_monthly_bytes <= max_monthly_bytes),
    CHECK(used_lifetime_events <= max_lifetime_events),
    CHECK(used_lifetime_bytes <= max_lifetime_bytes)
);
CREATE INDEX idx_workspace_entitlements_status
    ON workspace_entitlements(status, plan_id);

-- Device rows and their cost counters are one SQLite statement. AFTER INSERT
-- avoids charging ignored/non-inserts; RAISE rolls the device row back when no
-- active slot or lifetime issuance remains. Revocation releases only the
-- active slot and can never refund the lifetime issuance counter.
CREATE TRIGGER devices_charge_entitlement
AFTER INSERT ON devices
BEGIN
    UPDATE workspace_entitlements
    SET active_devices = active_devices + 1,
        used_device_issuances = used_device_issuances + 1,
        updated_at = MAX(updated_at, NEW.created_at)
    WHERE workspace_id = NEW.workspace_id
      AND status = 'active'
      AND active_devices < max_devices
      AND used_device_issuances < max_device_issuances;

    SELECT (CASE WHEN changes() <> 1
      THEN RAISE(ABORT, 'device quota exceeded')
    END);
END;

CREATE TRIGGER devices_release_active_slot
AFTER UPDATE OF revoked_at ON devices
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
    UPDATE workspace_entitlements
    SET active_devices = MAX(active_devices - 1, 0),
        updated_at = MAX(updated_at, NEW.revoked_at)
    WHERE workspace_id = NEW.workspace_id;
END;

-- Event IDs are immutable evidence identities, not merely deduplication keys.
-- An exact replay may no-op under INSERT OR IGNORE, but reusing an event ID
-- for different canonical evidence aborts the surrounding receipt/quota batch.
CREATE TRIGGER events_reject_payload_conflict
BEFORE INSERT ON events
WHEN EXISTS (
  SELECT 1 FROM events AS existing
  WHERE existing.workspace_id = NEW.workspace_id
    AND existing.event_id = NEW.event_id
    AND existing.raw_json <> NEW.raw_json
)
BEGIN
    SELECT RAISE(ABORT, 'event payload conflict');
END;

-- The UPDATE is the serialization point. This is an AFTER trigger so ignored
-- duplicates or other non-inserts cannot consume a slot. If the singleton is
-- absent or full, changes() is zero and RAISE rolls back the new entitlement.
CREATE TRIGGER workspace_entitlements_basic_capacity
AFTER INSERT ON workspace_entitlements
WHEN NEW.plan_id = 'basic'
BEGIN
    UPDATE hosted_beta_capacity
    SET active_accounts = active_accounts + 1
    WHERE id = 'global' AND active_accounts < max_accounts;

    SELECT (CASE WHEN changes() <> 1
      THEN RAISE(ABORT, 'hosted beta capacity exceeded')
    END);
END;

CREATE TABLE quota_reservations (
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
    request_hash    TEXT NOT NULL
                    CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    event_count     INTEGER NOT NULL CHECK(event_count > 0),
    body_bytes      INTEGER NOT NULL CHECK(body_bytes > 0),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'allowed', 'rejected')),
    created_at      INTEGER NOT NULL CHECK(created_at >= 0),
    decided_at      INTEGER,
    PRIMARY KEY (workspace_id, idempotency_key),
    CHECK(decided_at IS NULL OR decided_at >= created_at),
    CHECK(
      (status = 'pending' AND decided_at IS NULL) OR
      (status IN ('allowed', 'rejected') AND decided_at IS NOT NULL)
    )
);
CREATE INDEX idx_quota_reservations_workspace_status
    ON quota_reservations(workspace_id, status, created_at);

-- Reservations must start pending. A rejected row may be written explicitly
-- after a failed request for audit purposes, but callers cannot forge an
-- allowed row and bypass accounting.
CREATE TRIGGER quota_reservations_require_pending
BEFORE INSERT ON quota_reservations
WHEN NEW.status = 'allowed'
BEGIN
    SELECT RAISE(ABORT, 'quota reservation must start pending');
END;

-- D1 serializes this trigger with the counter update below. The composite
-- reservation key prevents concurrent retries from charging twice. Hosted
-- ingestion always submits this statement; a missing/inactive entitlement is
-- a fail-closed configuration or deletion race.
CREATE TRIGGER quota_reservations_check
BEFORE INSERT ON quota_reservations
WHEN NEW.status = 'pending'
 AND NOT EXISTS (
   SELECT 1 FROM quota_reservations
   WHERE workspace_id = NEW.workspace_id
     AND idempotency_key = NEW.idempotency_key
 )
BEGIN
    SELECT (CASE WHEN NOT EXISTS (
      SELECT 1 FROM workspace_entitlements AS entitlement
      WHERE entitlement.workspace_id = NEW.workspace_id
        AND entitlement.status = 'active'
    ) THEN RAISE(ABORT, 'active entitlement required') END);

    -- Advance an expired fixed-duration accounting period before checking the
    -- new reservation. This happens inside the same serialized write as the
    -- limit check and charge, so concurrent requests cannot both reset it.
    UPDATE workspace_entitlements
    SET used_monthly_events = 0,
        used_monthly_bytes = 0,
        period_start = period_start +
          ((NEW.created_at - period_start) / (period_end - period_start)) *
          (period_end - period_start),
        period_end = period_start +
          (((NEW.created_at - period_start) / (period_end - period_start)) + 1) *
          (period_end - period_start),
        updated_at = MAX(updated_at, NEW.created_at)
    WHERE workspace_id = NEW.workspace_id
      AND period_end <= NEW.created_at;

    SELECT (CASE WHEN EXISTS (
      SELECT 1 FROM workspace_entitlements AS entitlement
      WHERE entitlement.workspace_id = NEW.workspace_id
        AND (
          entitlement.status <> 'active' OR
          NEW.event_count > entitlement.max_batch_events OR
          NEW.body_bytes > entitlement.max_batch_bytes OR
          NEW.event_count > entitlement.max_monthly_events - entitlement.used_monthly_events OR
          NEW.body_bytes > entitlement.max_monthly_bytes - entitlement.used_monthly_bytes OR
          NEW.event_count > entitlement.max_lifetime_events - entitlement.used_lifetime_events OR
          NEW.body_bytes > entitlement.max_lifetime_bytes - entitlement.used_lifetime_bytes
        )
    ) THEN RAISE(ABORT, 'quota exceeded') END);
END;

CREATE TRIGGER quota_reservations_allow
AFTER INSERT ON quota_reservations
WHEN NEW.status = 'pending'
BEGIN
    UPDATE workspace_entitlements
    SET used_monthly_events = used_monthly_events + NEW.event_count,
        used_monthly_bytes = used_monthly_bytes + NEW.body_bytes,
        used_lifetime_events = used_lifetime_events + NEW.event_count,
        used_lifetime_bytes = used_lifetime_bytes + NEW.body_bytes,
        updated_at = MAX(updated_at, NEW.created_at)
    WHERE workspace_id = NEW.workspace_id;

    UPDATE quota_reservations
    SET status = 'allowed', decided_at = NEW.created_at
    WHERE workspace_id = NEW.workspace_id
      AND idempotency_key = NEW.idempotency_key;
END;

-- Migrate idempotency from a global key to the correct tenant-scoped key.
-- Existing receipts are preserved and get request_hash=NULL, retaining the
-- legacy replay behavior until a newly written canonical request hash exists.
DROP INDEX idx_idempotency_keys_workspace;
ALTER TABLE idempotency_keys RENAME TO idempotency_keys_legacy_0003;

CREATE TABLE idempotency_keys (
    key          TEXT NOT NULL CHECK(length(key) > 0),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    device_id    TEXT,
    request_hash TEXT
                 CHECK(request_hash IS NULL OR
                       (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*')),
    receipt_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    UNIQUE (workspace_id, key)
);

INSERT INTO idempotency_keys
    (key, workspace_id, device_id, request_hash, receipt_json, created_at)
SELECT key, workspace_id, device_id, NULL, receipt_json, created_at
FROM idempotency_keys_legacy_0003;

DROP TABLE idempotency_keys_legacy_0003;
CREATE INDEX idx_idempotency_keys_workspace ON idempotency_keys(workspace_id);
