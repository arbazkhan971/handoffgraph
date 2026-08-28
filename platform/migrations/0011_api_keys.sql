-- Public API keys (migration 0011, parity row 44).
--
-- Two credential parts, one row:
--   public_key   'pk_' + 12 chars. Identifies the key in listings/logs and is
--                NOT a secret — safe to show back to the caller forever.
--   secret_hash  sha256 hex of the actual bearer credential ('sk_' + 43
--                base64url chars). The raw secret is shown to the caller
--                exactly once at creation (POST /v1/api-keys response) and is
--                never stored or shown again — same discipline as
--                devices.token_hash and webhook_endpoints.secret_hash.
--
-- Verification (src/apikeys.ts authenticateApiKey) hashes the presented
-- `Authorization: Bearer sk_...` header and looks up secret_hash. D1 lookups
-- are fronted by an edge KV cache of the verdict (60s TTL) so a repeated bad
-- key never reaches D1 twice in a row; revocation writes a KV tombstone
-- immediately so a cached "ok" verdict cannot outlive the revocation.
--
-- scopes is a small JSON array drawn from {"read","write"}; v1 keys default
-- to ["read"]. "write" gates mutating hosted MCP tools (record_score,
-- accept_handoff) and any future mutating public REST route — a read-only
-- key can never write. Element-value validity (only read/write) is enforced
-- in application code at creation time, the same division of labor migration
-- 0007 uses for webhook_endpoints.event_kinds (DB checks shape, app checks
-- vocabulary) since a CHECK constraint cannot portably inspect array
-- elements without a subquery.
--
-- Every table carries workspace_id (NOT NULL, indexed) per platform
-- convention.

CREATE TABLE api_keys (
    id           TEXT PRIMARY KEY
                 CHECK(length(id) = 30 AND substr(id, 1, 4) = 'apk_' AND
                       substr(id, 5, 1) GLOB '[0-7]' AND
                       substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id TEXT NOT NULL,
    name         TEXT NOT NULL CHECK(length(name) > 0),
    public_key   TEXT NOT NULL
                 CHECK(length(public_key) = 15 AND substr(public_key, 1, 3) = 'pk_'),
    secret_hash  TEXT NOT NULL
                 CHECK(length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
    scopes       TEXT NOT NULL DEFAULT '["read"]'
                 CHECK(json_valid(scopes) AND json_type(scopes) = 'array' AND
                       json_array_length(scopes) > 0),
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    revoked_at   INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX idx_api_keys_workspace ON api_keys(workspace_id);
CREATE UNIQUE INDEX idx_api_keys_public_key ON api_keys(public_key);
-- Verification is a point lookup by secret_hash; unique because the hash
-- space collision probability is negligible and a duplicate would mean two
-- keys share one secret.
CREATE UNIQUE INDEX idx_api_keys_secret_hash ON api_keys(secret_hash);

-- Revocation is one-way: once set, revoked_at can never be cleared. Mirrors
-- migration 0007's webhook_deliveries_terminal_status trigger.
CREATE TRIGGER api_keys_revocation_is_terminal
BEFORE UPDATE OF revoked_at ON api_keys
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
BEGIN
    SELECT RAISE(ABORT, 'api key revocation cannot be undone');
END;

-- Every other column is immutable once created — a schema-level backstop so
-- a future bug can never rotate a secret or widen scopes on an existing row
-- in place. The only legitimate lifecycle transition is revoke-then-recreate.
CREATE TRIGGER api_keys_identity_is_immutable
BEFORE UPDATE OF workspace_id, name, public_key, secret_hash, scopes, created_at ON api_keys
BEGIN
    SELECT RAISE(ABORT, 'api key identity fields are immutable; revoke and create a new key instead');
END;
