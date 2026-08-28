-- Teams, org-level RBAC, and the tamper-evident audit spine (parity rows 45, 49).
--
-- 0003 already created workspace_members with the four-role CHECK. This
-- migration makes that column *enforceable* rather than advisory:
--
--   * a workspace can never lose its last active owner (role change, removal,
--     or deletion) — enforced by triggers, not only by route code;
--   * invites are hash-only bearer credentials with an in-schema capacity
--     bound, a single terminal state, and immutable identity fields;
--   * every membership mutation is appended to a per-workspace hash chain over
--     the append-only events spine, and neither the chain nor the events it
--     links to can be updated or deleted afterwards.
--
-- House style follows 0003: invariants live in CHECK constraints and triggers
-- so a future route, migration, or console session cannot bypass them.

-- --------------------------------------------------------------------------
-- Role backfill
-- --------------------------------------------------------------------------

-- Memberships created before role enforcement default to 'member'. Any
-- workspace left without an active owner promotes its earliest active member;
-- creator-first ordering (created_at, then user_id as a deterministic
-- tie-break) makes that the account creator. Workspaces that already have an
-- owner are untouched.
UPDATE workspace_members
SET role = 'owner'
WHERE status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_members AS existing_owner
    WHERE existing_owner.workspace_id = workspace_members.workspace_id
      AND existing_owner.role = 'owner'
      AND existing_owner.status = 'active'
  )
  AND user_id = (
    SELECT candidate.user_id FROM workspace_members AS candidate
    WHERE candidate.workspace_id = workspace_members.workspace_id
      AND candidate.status = 'active'
    ORDER BY candidate.created_at, candidate.user_id
    LIMIT 1
  );

CREATE INDEX idx_workspace_members_active_role
    ON workspace_members(workspace_id, role) WHERE status = 'active';

-- --------------------------------------------------------------------------
-- Seats
-- --------------------------------------------------------------------------

-- Team capacity is a separate bounded resource from the hosted_beta_capacity
-- account ceiling in 0003: that one bounds how many accounts may exist, this
-- one bounds how large a single workspace may grow during the beta. Seats are
-- counted, never accumulated, so a removal genuinely frees the seat and no
-- counter can drift away from the membership rows it describes.
CREATE TABLE workspace_seats (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    max_seats    INTEGER NOT NULL DEFAULT 5 CHECK(max_seats >= 1),
    created_at   INTEGER NOT NULL CHECK(created_at >= 0)
);

INSERT OR IGNORE INTO workspace_seats (workspace_id, created_at)
SELECT id, created_at FROM workspaces;

-- Every workspace carries a seat allowance from the moment it exists, so the
-- capacity triggers below can fail closed on a missing row without breaking
-- account provisioning for a workspace created after this migration.
CREATE TRIGGER workspaces_provision_seats
AFTER INSERT ON workspaces
BEGIN
    INSERT OR IGNORE INTO workspace_seats (workspace_id, created_at)
    VALUES (NEW.id, NEW.created_at);
END;

CREATE TRIGGER workspace_members_seat_capacity_insert
BEFORE INSERT ON workspace_members
WHEN NEW.status = 'active'
BEGIN
    SELECT CASE WHEN (
      SELECT COUNT(*) FROM workspace_members
      WHERE workspace_id = NEW.workspace_id AND status = 'active'
    ) >= (
      SELECT COALESCE(MAX(max_seats), 0) FROM workspace_seats
      WHERE workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'workspace seat capacity exceeded') END;
END;

CREATE TRIGGER workspace_members_seat_capacity_reactivate
BEFORE UPDATE OF status ON workspace_members
WHEN OLD.status <> 'active' AND NEW.status = 'active'
BEGIN
    SELECT CASE WHEN (
      SELECT COUNT(*) FROM workspace_members
      WHERE workspace_id = NEW.workspace_id AND status = 'active'
    ) >= (
      SELECT COALESCE(MAX(max_seats), 0) FROM workspace_seats
      WHERE workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'workspace seat capacity exceeded') END;
END;

-- --------------------------------------------------------------------------
-- Last-owner protection
-- --------------------------------------------------------------------------

-- Ownership is the only role that can restore every other permission, so a
-- workspace without one is unrecoverable. All three removal paths are closed.
CREATE TRIGGER workspace_members_last_owner_role
BEFORE UPDATE OF role ON workspace_members
WHEN OLD.role = 'owner' AND OLD.status = 'active' AND NEW.role <> 'owner'
 AND NOT EXISTS (
   SELECT 1 FROM workspace_members
   WHERE workspace_id = OLD.workspace_id
     AND user_id <> OLD.user_id
     AND role = 'owner'
     AND status = 'active'
 )
BEGIN
    SELECT RAISE(ABORT, 'workspace must retain an owner');
END;

CREATE TRIGGER workspace_members_last_owner_status
BEFORE UPDATE OF status ON workspace_members
WHEN OLD.role = 'owner' AND OLD.status = 'active' AND NEW.status <> 'active'
 AND NOT EXISTS (
   SELECT 1 FROM workspace_members
   WHERE workspace_id = OLD.workspace_id
     AND user_id <> OLD.user_id
     AND role = 'owner'
     AND status = 'active'
 )
BEGIN
    SELECT RAISE(ABORT, 'workspace must retain an owner');
END;

-- The workspaces guard keeps ON DELETE CASCADE working: deleting the whole
-- workspace is allowed, deleting only its last owner is not.
CREATE TRIGGER workspace_members_last_owner_delete
BEFORE DELETE ON workspace_members
WHEN OLD.role = 'owner' AND OLD.status = 'active'
 AND EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
 AND NOT EXISTS (
   SELECT 1 FROM workspace_members
   WHERE workspace_id = OLD.workspace_id
     AND user_id <> OLD.user_id
     AND role = 'owner'
     AND status = 'active'
 )
BEGIN
    SELECT RAISE(ABORT, 'workspace must retain an owner');
END;

-- --------------------------------------------------------------------------
-- Invites
-- --------------------------------------------------------------------------

-- Only the SHA-256 of the invite token is durable, exactly like device tokens
-- and browser sessions: the raw token is returned to the inviting admin once
-- and is never stored, logged, or recoverable from this table.
CREATE TABLE workspace_invites (
    id           TEXT PRIMARY KEY
                 CHECK(length(id) = 30 AND substr(id, 1, 4) = 'inv_' AND
                       substr(id, 5, 1) GLOB '[0-7]' AND
                       substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email        TEXT NOT NULL COLLATE NOCASE
                 CHECK(length(email) BETWEEN 5 AND 254 AND
                       email NOT GLOB '* *' AND email NOT GLOB '*@*@*' AND
                       email GLOB '?*@?*.?*'),
    role         TEXT NOT NULL CHECK(role IN ('admin', 'member', 'viewer')),
    token_hash   TEXT NOT NULL UNIQUE
                 CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    created_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    expires_at   INTEGER NOT NULL CHECK(expires_at > created_at),
    accepted_at  INTEGER,
    accepted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_at   INTEGER,
    CHECK(accepted_at IS NULL OR accepted_at >= created_at),
    CHECK(revoked_at IS NULL OR revoked_at >= created_at),
    CHECK((accepted_at IS NULL) = (accepted_by IS NULL)),
    CHECK(accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX idx_workspace_invites_workspace
    ON workspace_invites(workspace_id, created_at);
CREATE INDEX idx_workspace_invites_created_by ON workspace_invites(created_by);

-- One live invite per address per workspace. Expired-but-unresolved rows are
-- swept (revoked) by the re-invite path inside the same transaction, so this
-- index bounds outstanding bearer tokens without stranding an address.
CREATE UNIQUE INDEX idx_workspace_invites_live
    ON workspace_invites(workspace_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Ownership is never conferred by a bearer link. role='owner' is already
-- rejected by the column CHECK; this trigger states the rule where an operator
-- reading the schema will look for it.
CREATE TRIGGER workspace_invites_forbid_owner_role
BEFORE INSERT ON workspace_invites
WHEN NEW.role = 'owner'
BEGIN
    SELECT RAISE(ABORT, 'invites cannot grant ownership');
END;

-- Pending invites hold a seat. Without this an admin could issue unlimited
-- links whose holders would all be rejected at accept time.
CREATE TRIGGER workspace_invites_seat_capacity
BEFORE INSERT ON workspace_invites
BEGIN
    SELECT CASE WHEN (
      (SELECT COUNT(*) FROM workspace_members
       WHERE workspace_id = NEW.workspace_id AND status = 'active') +
      (SELECT COUNT(*) FROM workspace_invites
       WHERE workspace_id = NEW.workspace_id
         AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > NEW.created_at)
    ) >= (
      SELECT COALESCE(MAX(max_seats), 0) FROM workspace_seats
      WHERE workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'workspace seat capacity exceeded') END;
END;

-- An invite's identity (who, where, which role, which token) is fixed at
-- creation; only the terminal accepted/revoked transition may be written.
CREATE TRIGGER workspace_invites_immutable_identity
BEFORE UPDATE ON workspace_invites
WHEN OLD.id <> NEW.id
  OR OLD.workspace_id <> NEW.workspace_id
  OR OLD.email <> NEW.email
  OR OLD.role <> NEW.role
  OR OLD.token_hash <> NEW.token_hash
  OR OLD.created_by <> NEW.created_by
  OR OLD.created_at <> NEW.created_at
  OR OLD.expires_at <> NEW.expires_at
BEGIN
    SELECT RAISE(ABORT, 'invite identity is immutable');
END;

CREATE TRIGGER workspace_invites_single_terminal_state
BEFORE UPDATE ON workspace_invites
WHEN OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'invite already resolved');
END;

-- An expired link cannot be redeemed even if a route forgets to check.
CREATE TRIGGER workspace_invites_accept_window
BEFORE UPDATE OF accepted_at ON workspace_invites
WHEN NEW.accepted_at IS NOT NULL AND NEW.accepted_at >= OLD.expires_at
BEGIN
    SELECT RAISE(ABORT, 'invite expired');
END;

-- --------------------------------------------------------------------------
-- Tamper-evident audit chain
-- --------------------------------------------------------------------------

-- Row 49's spine. Each membership mutation appends an OBSERVED event to the
-- append-only events table, and one link here binds that event into a
-- per-workspace hash chain: seq is dense from 0, prev_hash must equal the
-- predecessor's content_hash, and the unique prev_hash index makes a fork
-- unrepresentable. A concurrent writer therefore aborts its whole transaction
-- (mutation included) instead of silently branching the trail.
CREATE TABLE audit_chain (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL CHECK(seq >= 0),
    event_id     TEXT NOT NULL
                 CHECK(length(event_id) = 30 AND substr(event_id, 1, 4) = 'evt_' AND
                       substr(event_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    content_hash TEXT NOT NULL
                 CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    prev_hash    TEXT
                 CHECK(prev_hash IS NULL OR
                       (length(prev_hash) = 64 AND prev_hash NOT GLOB '*[^0-9a-f]*')),
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (workspace_id, seq)
);
CREATE UNIQUE INDEX idx_audit_chain_event ON audit_chain(workspace_id, event_id);
CREATE UNIQUE INDEX idx_audit_chain_link ON audit_chain(workspace_id, prev_hash);

CREATE TRIGGER audit_chain_require_link
BEFORE INSERT ON audit_chain
BEGIN
    SELECT CASE WHEN NEW.prev_hash IS NOT (
      SELECT content_hash FROM audit_chain
      WHERE workspace_id = NEW.workspace_id AND seq = NEW.seq - 1
    ) THEN RAISE(ABORT, 'audit chain link mismatch') END;

    -- The link is only meaningful if it names evidence that exists with the
    -- hash being chained, so the event insert must precede it in the batch.
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM events
      WHERE workspace_id = NEW.workspace_id
        AND event_id = NEW.event_id
        AND content_hash = 'sha256:' || NEW.content_hash
    ) THEN RAISE(ABORT, 'audit chain event missing') END;
END;

CREATE TRIGGER audit_chain_forbid_update
BEFORE UPDATE ON audit_chain
BEGIN
    SELECT RAISE(ABORT, 'audit chain is append-only');
END;

CREATE TRIGGER audit_chain_forbid_delete
BEFORE DELETE ON audit_chain
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
BEGIN
    SELECT RAISE(ABORT, 'audit chain is append-only');
END;

-- The platform-wide append-only invariant, enforced in the schema instead of
-- being merely documented. Evidence rewriting is what the chain above is meant
-- to detect; these triggers make it fail outright.
CREATE TRIGGER events_forbid_update
BEFORE UPDATE ON events
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_forbid_delete
BEFORE DELETE ON events
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;
