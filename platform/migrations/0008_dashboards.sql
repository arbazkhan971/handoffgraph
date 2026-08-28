-- Dashboards-as-config (migration 0008, parity rows 39 and 40).
--
-- A dashboard is a versioned JSON document, not a pile of mutable widget
-- rows. That single decision is what makes rows 39 and 40 the same feature:
--
--   * row 39 (custom dashboards) needs widgets, variables, import/export and
--     share links;
--   * row 40 (dashboards-as-config) needs those same documents to be
--     versioned, diffable in a pull request, and dry-runnable in CI.
--
-- Storing the canonical JSON verbatim and never rewriting it satisfies both:
-- `GET /v1/dashboards/{id}/versions/{n}` returns the exact bytes that were
-- validated and hashed, so a config committed to `deploy/dashboards/*.json`
-- and a config read back from the API are byte-identical artifacts.
--
-- Three tables:
--
--   1. dashboards         — the resource identity (id, workspace, name).
--   2. dashboard_versions — the append-only version chain. Immutable by
--      trigger; the version sequence is dense from 1 by trigger.
--   3. dashboard_shares   — read-only share links. Only a sha256 of the
--      token is stored; revocation is one-way.
--
-- Platform conventions honored here: every table carries workspace_id NOT
-- NULL with an index, ids are prefixed ULIDs checked in-schema, and the
-- immutability rules are enforced by triggers rather than only by
-- application code.

-- ---------------------------------------------------------------------------
-- 1. Dashboards
-- ---------------------------------------------------------------------------

-- `name` is the resource's stable human label. It is fixed at creation and
-- every later version's `config.name` must agree with it (enforced by the
-- dashboard_versions trigger below), so the row label and the exported
-- document can never disagree. Renaming is deliberately not a route in this
-- version: it would either fork history or rewrite an immutable version.
CREATE TABLE dashboards (
    id           TEXT NOT NULL PRIMARY KEY
                 CHECK(length(id) = 30 AND substr(id, 1, 4) = 'dsh_' AND
                       substr(id, 5, 1) GLOB '[0-7]' AND
                       substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id TEXT NOT NULL
                 CHECK(length(workspace_id) = 30 AND
                       substr(workspace_id, 1, 4) = 'wsp_' AND
                       substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                       substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    name         TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
    created_at   INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE INDEX idx_dashboards_workspace ON dashboards(workspace_id);
-- Serves the keyset list page (ORDER BY created_at DESC, id DESC).
CREATE INDEX idx_dashboards_workspace_created ON dashboards(workspace_id, created_at, id);

-- Identity never changes. A dashboard is created once and then only gains
-- versions; nothing in the API mutates this row.
CREATE TRIGGER dashboards_immutable
BEFORE UPDATE ON dashboards
BEGIN
    SELECT RAISE(ABORT, 'dashboards are immutable; append a version instead');
END;

-- ---------------------------------------------------------------------------
-- 2. Dashboard versions (append-only)
-- ---------------------------------------------------------------------------

-- `config` holds the CANONICAL JSON encoding (sorted keys, no insignificant
-- whitespace) produced by canonicalJsonStringify in src/ingest.ts, and
-- `content_sha256` is the sha256 of exactly those bytes. Reading a version
-- back returns the stored string verbatim rather than a re-serialization, so
-- the digest a reviewer sees in a pull request is the digest the API serves.
--
-- workspace_id is denormalized onto this table (rather than joined through
-- dashboards) because every read path is workspace-scoped and the platform
-- convention is that a workspace-scoped table carries and indexes its own
-- workspace_id. The trigger below keeps it consistent with the parent.
CREATE TABLE dashboard_versions (
    dashboard_id      TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    workspace_id      TEXT NOT NULL
                      CHECK(length(workspace_id) = 30 AND
                            substr(workspace_id, 1, 4) = 'wsp_' AND
                            substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                            substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    version           INTEGER NOT NULL CHECK(version >= 1),
    -- CAST(... AS BLOB) makes length() count BYTES, matching the validator's
    -- 32 KiB UTF-8 ceiling exactly rather than counting characters.
    config            TEXT NOT NULL
                      CHECK(json_valid(config) AND json_type(config) = 'object' AND
                            json_extract(config, '$.schema') = 'hfg.dashboard.v1' AND
                            length(CAST(config AS BLOB)) <= 32768),
    content_sha256    TEXT NOT NULL
                      CHECK(length(content_sha256) = 64 AND
                            content_sha256 NOT GLOB '*[^0-9a-f]*'),
    -- Shape-checked, not ULID-checked: migration 0001 put no CHECK on
    -- devices.id, so a workspace provisioned before the prefixed-ULID
    -- convention must still be able to publish a dashboard.
    created_by_device TEXT NOT NULL
                      CHECK(length(created_by_device) BETWEEN 5 AND 64 AND
                            substr(created_by_device, 1, 4) = 'dev_'),
    created_at        INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (dashboard_id, version)
);
CREATE INDEX idx_dashboard_versions_workspace ON dashboard_versions(workspace_id);
-- Latest-version lookup and the per-dashboard version listing.
CREATE INDEX idx_dashboard_versions_workspace_dashboard
    ON dashboard_versions(workspace_id, dashboard_id, version);

-- The version sequence is dense from 1 and each row must belong to the same
-- workspace as its dashboard AND carry that dashboard's name. Two concurrent
-- writers both computing "next = N+1" cannot both land: the primary key
-- rejects the loser outright, and this trigger rejects any write that tries
-- to skip ahead of the chain instead of extending it.
CREATE TRIGGER dashboard_versions_dense_sequence
BEFORE INSERT ON dashboard_versions
BEGIN
    SELECT CASE WHEN NEW.version <> 1 + COALESCE(
      (SELECT MAX(version) FROM dashboard_versions WHERE dashboard_id = NEW.dashboard_id), 0
    ) THEN RAISE(ABORT, 'dashboard version sequence must be dense') END;

    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM dashboards
      WHERE id = NEW.dashboard_id
        AND workspace_id = NEW.workspace_id
        AND name = json_extract(NEW.config, '$.name')
    ) THEN RAISE(ABORT, 'dashboard version must match its dashboard workspace and name') END;
END;

-- A published version is evidence: it is what a reviewer approved and what a
-- share link serves. Rewriting one would silently change the meaning of a
-- digest already quoted in a pull request, so it aborts.
CREATE TRIGGER dashboard_versions_forbid_update
BEFORE UPDATE ON dashboard_versions
BEGIN
    SELECT RAISE(ABORT, 'dashboard versions are append-only');
END;

-- Deleting the parent dashboard still cascades (the guard only fires while
-- the parent row is still present) — same shape as audit_chain_forbid_delete
-- in migration 0004.
CREATE TRIGGER dashboard_versions_forbid_delete
BEFORE DELETE ON dashboard_versions
WHEN EXISTS (SELECT 1 FROM dashboards WHERE id = OLD.dashboard_id)
BEGIN
    SELECT RAISE(ABORT, 'dashboard versions are append-only');
END;

-- ---------------------------------------------------------------------------
-- 3. Share links (read-only, hash-only, revocable)
-- ---------------------------------------------------------------------------

-- The raw `dshtok_<random>` token is returned exactly once at creation and
-- never stored: only its sha256 lands here, so a database read cannot mint a
-- working link. token_hash is the PRIMARY KEY, which is the required UNIQUE
-- constraint — a second unique index would only duplicate SQLite's implicit
-- one.
--
-- Trust boundary (see docs/dashboards.md): resolving a share token returns
-- the dashboard's latest CONFIG DOCUMENT and nothing else. No observations,
-- events, costs or workspace metadata are served on this path; widget queries
-- run client-side against the authenticated APIs.
CREATE TABLE dashboard_shares (
    token_hash   TEXT NOT NULL PRIMARY KEY
                 CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL
                 CHECK(length(workspace_id) = 30 AND
                       substr(workspace_id, 1, 4) = 'wsp_' AND
                       substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                       substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    revoked_at   INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX idx_dashboard_shares_workspace ON dashboard_shares(workspace_id);
CREATE INDEX idx_dashboard_shares_dashboard ON dashboard_shares(dashboard_id, created_at);

-- Revocation is one-way and is the only permitted mutation. Un-revoking a
-- leaked link, or re-pointing a live token at a different dashboard, would
-- both be silent privilege changes for whoever already holds the URL.
CREATE TRIGGER dashboard_shares_revoke_only
BEFORE UPDATE ON dashboard_shares
WHEN NEW.token_hash <> OLD.token_hash
  OR NEW.dashboard_id <> OLD.dashboard_id
  OR NEW.workspace_id <> OLD.workspace_id
  OR NEW.created_at <> OLD.created_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
    SELECT RAISE(ABORT, 'dashboard shares are revoke-only');
END;

-- A share must belong to the same workspace as the dashboard it points at,
-- or an unauthenticated read would cross a tenant boundary.
CREATE TRIGGER dashboard_shares_workspace_match
BEFORE INSERT ON dashboard_shares
BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM dashboards
      WHERE id = NEW.dashboard_id AND workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'dashboard share workspace mismatch') END;
END;
