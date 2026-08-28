-- Enterprise-tier data structures (migration 0016, parity row 48).
--
-- LICENSE NOTE — read this before moving anything.
--
-- This file is part of the OSS repository and carries the repository's OSS
-- license, exactly like every other migration. That is deliberate and it is
-- not an oversight:
--
--   * A migration is a data structure, not a feature. It declares three tables
--     and their integrity constraints. It contains no product logic, no
--     policy, and nothing that only an Enterprise customer may run.
--   * The one-way door we care about is the reverse: OSS code must never
--     depend on EE code. Keeping the schema OSS means an OSS operator can
--     apply 0001..NNNN unconditionally, `wrangler d1 migrations apply` stays a
--     single ordered list, and the D1 schema is identical on every deployment
--     whether or not EE is licensed. Three empty tables cost nothing.
--   * The Enterprise product lives in platform/ee/ under its own license
--     (platform/ee/LICENSE) and is reachable only when EE_ENABLED === "true".
--     That directory + flag is the fence. The schema is not the fence, and
--     making it one would buy nothing while breaking migration ordering for
--     everyone.
--
-- So: schema here (OSS), behavior in platform/ee/ (Enterprise). Never license
-- soup — no per-table license headers, no conditional migrations, no split
-- migrations_dir.
--
-- Platform conventions honored below: every table carries workspace_id NOT
-- NULL and is indexed on it; secrets are stored only as SHA-256; revocation is
-- one-way and enforced by a trigger; identity columns are immutable.

-- -- SSO ---------------------------------------------------------------------
--
-- WorkOS AuthKit already performs the actual SSO dance (src/account.ts): a
-- SAML/OIDC login lands on the same /v1/auth/callback as a password login and
-- yields the same verified immutable subject. What the platform has no record
-- of is which WorkOS *Organization* a workspace is bound to, which is what an
-- admin needs in order to point their IdP at the right place and what the
-- SCIM directory below scopes to.
--
-- One row per workspace, so workspace_id is the primary key: a workspace has
-- at most one org binding. connection_state is a coarse setup indicator that
-- the admin surface reflects back; the authoritative connection status lives
-- in WorkOS and is never mirrored here.
CREATE TABLE ee_sso_connections (
    -- NOT NULL is spelled out even though this is the primary key: SQLite
    -- keeps a long-standing quirk in which an INTEGER-rowid table's TEXT
    -- PRIMARY KEY still accepts NULL. Every platform table carries
    -- workspace_id NOT NULL, and that has to be true here in fact, not just
    -- by convention.
    workspace_id     TEXT NOT NULL PRIMARY KEY,
    workos_org_id    TEXT NOT NULL
                     CHECK(length(workos_org_id) BETWEEN 1 AND 200 AND
                           workos_org_id NOT GLOB '* *'),
    connection_state TEXT NOT NULL
                     CHECK(connection_state IN ('pending', 'active')),
    updated_at       INTEGER NOT NULL CHECK(updated_at >= 0)
);
-- Redundant with the primary key on this table, but every platform table is
-- indexed on workspace_id and a future migration that widens the key must not
-- silently lose the index.
CREATE INDEX idx_ee_sso_connections_workspace ON ee_sso_connections(workspace_id);

-- -- SCIM --------------------------------------------------------------------
--
-- A SCIM 2.0 client (Okta, Entra, WorkOS Directory Sync) authenticates with a
-- long-lived bearer token. Same discipline as devices.token_hash,
-- api_keys.secret_hash, and workspace_invites.token_hash: the raw
-- `scim_<43 base64url chars>` credential is returned exactly once at creation
-- and only its SHA-256 is ever persisted.
--
-- The application keeps ONE live token per workspace: POST /v1/ee/scim/token
-- revokes the previous ones in the same D1 batch as the insert, so there is
-- never a window with two working credentials. The schema still permits
-- several rows per workspace, for two reasons: revoked rows stay as history,
-- and an overlapping rotation (issue, migrate the IdP, then revoke) becomes a
-- code change rather than a migration if it is ever wanted.
--
-- There is no id column: the hash IS the identity, and it is globally unique
-- because a collision would mean two directories share one secret.
CREATE TABLE ee_scim_tokens (
    workspace_id TEXT NOT NULL,
    token_hash   TEXT NOT NULL
                 CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    revoked_at   INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX idx_ee_scim_tokens_workspace ON ee_scim_tokens(workspace_id);
-- Verification is a point lookup by token_hash.
CREATE UNIQUE INDEX idx_ee_scim_tokens_hash ON ee_scim_tokens(token_hash);

-- Revocation is one-way, mirroring api_keys_revocation_is_terminal (0011) and
-- webhook_deliveries_terminal_status (0007).
CREATE TRIGGER ee_scim_tokens_revocation_is_terminal
BEFORE UPDATE OF revoked_at ON ee_scim_tokens
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
BEGIN
    SELECT RAISE(ABORT, 'scim token revocation cannot be undone');
END;

-- The credential itself is immutable: rotation is issue-then-revoke, never an
-- in-place update of the hash or its owning workspace.
CREATE TRIGGER ee_scim_tokens_identity_is_immutable
BEFORE UPDATE OF workspace_id, token_hash, created_at ON ee_scim_tokens
BEGIN
    SELECT RAISE(ABORT, 'scim token identity fields are immutable; revoke and issue a new token instead');
END;

-- -- Data masking ------------------------------------------------------------
--
-- A masking rule names a field path pattern and what to do with a value that
-- matches it: 'hash' replaces the value with sha256:<hex> (the field's
-- presence and equality-joinability survive, the content does not), 'drop'
-- removes the field entirely.
--
-- The pattern language (dotted path segments, `*` within a segment, `**`
-- across segments) is validated in application code, in ee/src/ee.ts's
-- compileMaskingRule, because SQLite cannot express it portably in a CHECK —
-- the same division of labor migration 0011 uses for api_keys.scopes (DB
-- checks shape, app checks vocabulary). The DB still enforces the closed
-- action vocabulary, because that one IS expressible.
--
-- Rules are per-workspace and unique on (workspace_id, field_pattern): two
-- rules for one pattern would make the applied action depend on row order.
CREATE TABLE ee_masking_rules (
    id            TEXT PRIMARY KEY
                  CHECK(length(id) = 30 AND substr(id, 1, 4) = 'msk_' AND
                        substr(id, 5, 1) GLOB '[0-7]' AND
                        substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id  TEXT NOT NULL,
    field_pattern TEXT NOT NULL
                  CHECK(length(field_pattern) BETWEEN 1 AND 200),
    action        TEXT NOT NULL CHECK(action IN ('hash', 'drop')),
    created_at    INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE INDEX idx_ee_masking_rules_workspace ON ee_masking_rules(workspace_id);
CREATE UNIQUE INDEX idx_ee_masking_rules_pattern
    ON ee_masking_rules(workspace_id, field_pattern);

-- A rule is created or deleted, never edited: silently rewriting what a rule
-- masks would change the meaning of already-masked data without a trace.
CREATE TRIGGER ee_masking_rules_are_immutable
BEFORE UPDATE ON ee_masking_rules
BEGIN
    SELECT RAISE(ABORT, 'masking rules are immutable; delete and create a new rule instead');
END;
