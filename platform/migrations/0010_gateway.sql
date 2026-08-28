-- Gateway capture mode (migration 0010, parity rows 6 and 7).
--
-- An OpenAI-compatible proxy that a customer reaches by swapping baseURL and
-- API key. The differentiator is not routing: it is that every proxied call
-- lands as a provenance-labelled hfg.event.v1 row in the SAME append-only
-- `events` spine as the coding-agent evidence, so LLM traffic and agent work
-- are queryable and verifiable together.
--
-- Three tables, each carrying workspace_id NOT NULL + index per platform
-- convention:
--
--   gateway_keys            authoritative virtual-key registry. KV
--                           (GATEWAY_KV, `vk:<sha256(token)>`) is only an
--                           edge CACHE of these rows — every mutation is a
--                           D1 write-through followed by a KV put, and a KV
--                           miss falls back to D1 and backfills KV. D1 wins
--                           on any disagreement.
--   gateway_requests        append-only spend ledger, one row per proxied
--                           call. CONTENT-FREE BY CONSTRUCTION: there is no
--                           column here that could hold a prompt or a
--                           completion, so no future code path can leak one
--                           into it by accident.
--   gateway_capture_bodies  content-addressed prompt/completion bodies,
--                           written ONLY for keys whose capture_tier is
--                           'full'. Rows are immutable (trigger) but
--                           deletable, so downstream redaction can purge
--                           content without rewriting evidence.
--
-- Money discipline. Every amount is a NON-NEGATIVE DECIMAL STRING, never a
-- float and never cents-as-integer: floats cannot represent per-token prices
-- exactly and a silently rounded ledger is worse than no ledger. The CHECKs
-- below pin the canonical form (digits, at most one '.', no leading or
-- trailing '.'); src/gateway.ts adds the stricter "no leading zeros" rule.
--
-- cost_amount is NULLABLE and stays NULL unless the upstream itself reported
-- a cost. An amount we computed from a price table would be INFERRED, and
-- INFERRED money is never written as fact — see docs/gateway.md.
--
-- gateway_keys.budget_spent is a fast cached counter for pre-flight budget
-- enforcement; gateway_requests is the ledger of record. The counter is
-- always reconstructible as
--   SELECT SUM(cost_amount) FROM gateway_requests WHERE key_id = ?
-- (decimal-summed in application code), which is what makes a lost
-- compare-and-set on the counter a recoverable accounting drift rather than
-- lost evidence.

CREATE TABLE gateway_keys (
    id                      TEXT PRIMARY KEY
                            CHECK(length(id) = 30 AND substr(id, 1, 4) = 'gwk_' AND
                                  substr(id, 5, 1) GLOB '[0-7]' AND
                                  substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id            TEXT NOT NULL,
    name                    TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),

    -- Only the hash of the `vk_<random>` token is ever persisted; the raw
    -- virtual key is shown exactly once, at creation.
    token_hash              TEXT NOT NULL
                            CHECK(length(token_hash) = 64 AND
                                  token_hash NOT GLOB '*[^0-9a-f]*'),

    -- NULL budget_amount = uncapped. Enforcement compares budget_spent
    -- against budget_amount BEFORE the upstream call is made.
    budget_amount           TEXT
                            CHECK(budget_amount IS NULL OR (
                                  length(budget_amount) BETWEEN 1 AND 32 AND
                                  budget_amount NOT GLOB '*[^0-9.]*' AND
                                  budget_amount NOT GLOB '*.*.*' AND
                                  budget_amount NOT GLOB '.*' AND
                                  budget_amount NOT GLOB '*.')),
    budget_spent            TEXT NOT NULL DEFAULT '0'
                            CHECK(length(budget_spent) BETWEEN 1 AND 32 AND
                                  budget_spent NOT GLOB '*[^0-9.]*' AND
                                  budget_spent NOT GLOB '*.*.*' AND
                                  budget_spent NOT GLOB '.*' AND
                                  budget_spent NOT GLOB '*.'),

    rate_limit_per_min      INTEGER NOT NULL DEFAULT 60
                            CHECK(rate_limit_per_min > 0),

    -- Upstream provider credentials are AES-GCM sealed under the worker
    -- secret GATEWAY_SEALING_KEY, exactly like webhook_endpoints
    -- .secret_ciphertext (migration 0007). Nullable because key creation
    -- fails closed (503) while the sealing key is unset, and a future
    -- rotation pass may clear a stale ciphertext without dropping the row's
    -- audit history.
    upstream_base_url       TEXT NOT NULL CHECK(upstream_base_url LIKE 'https://%'),
    upstream_provider       TEXT NOT NULL
                            CHECK(upstream_provider IN ('openai', 'anthropic', 'custom')),
    upstream_key_ciphertext TEXT,

    -- [{"base_url": "https://...", "api_key_ciphertext": "..."}, ...], tried
    -- in array order, at most once each, after the primary returns 5xx or
    -- throws.
    fallbacks               TEXT NOT NULL DEFAULT '[]'
                            CHECK(json_valid(fallbacks) AND json_type(fallbacks) = 'array'),

    -- 'metadata' (default) captures counts/status/latency only. 'full' is a
    -- deliberate per-key opt-in that additionally stores prompt/completion
    -- bodies in gateway_capture_bodies.
    capture_tier            TEXT NOT NULL DEFAULT 'metadata'
                            CHECK(capture_tier IN ('metadata', 'full')),

    disabled                INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),
    created_at              INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE INDEX idx_gateway_keys_workspace ON gateway_keys(workspace_id);
CREATE INDEX idx_gateway_keys_workspace_created ON gateway_keys(workspace_id, created_at);
-- Proxy auth resolves a bearer token to exactly one key by hash; uniqueness
-- makes that lookup total and makes token reuse impossible.
CREATE UNIQUE INDEX idx_gateway_keys_token_hash ON gateway_keys(token_hash);

CREATE TABLE gateway_requests (
    id              TEXT PRIMARY KEY
                    CHECK(length(id) = 30 AND substr(id, 1, 4) = 'gwr_' AND
                          substr(id, 5, 1) GLOB '[0-7]' AND
                          substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id    TEXT NOT NULL,
    -- No ON DELETE CASCADE: combined with the append-only trigger below, a
    -- key that has billed traffic simply cannot be deleted. Keys are
    -- disabled, never deleted, so this only ever fires as a guard rail.
    key_id          TEXT NOT NULL REFERENCES gateway_keys(id),
    model           TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 200),
    upstream_status INTEGER
                    CHECK(upstream_status IS NULL OR upstream_status BETWEEN 100 AND 599),
    latency_ms      INTEGER NOT NULL CHECK(latency_ms >= 0),
    tokens_in       INTEGER CHECK(tokens_in IS NULL OR tokens_in >= 0),
    tokens_out      INTEGER CHECK(tokens_out IS NULL OR tokens_out >= 0),
    cost_amount     TEXT
                    CHECK(cost_amount IS NULL OR (
                          length(cost_amount) BETWEEN 1 AND 32 AND
                          cost_amount NOT GLOB '*[^0-9.]*' AND
                          cost_amount NOT GLOB '*.*.*' AND
                          cost_amount NOT GLOB '.*' AND
                          cost_amount NOT GLOB '*.')),
    cached          INTEGER NOT NULL DEFAULT 0 CHECK(cached IN (0, 1)),
    created_at      INTEGER NOT NULL CHECK(created_at >= 0),
    -- A cache hit makes no upstream call, so it can never carry a
    -- provider-reported cost. Enforcing it here means the "cached calls are
    -- free" promise cannot be broken by a later code change.
    CHECK(cached = 0 OR cost_amount IS NULL)
);
CREATE INDEX idx_gateway_requests_workspace ON gateway_requests(workspace_id);
CREATE INDEX idx_gateway_requests_workspace_created ON gateway_requests(workspace_id, created_at);
CREATE INDEX idx_gateway_requests_key_created ON gateway_requests(key_id, created_at);

CREATE TABLE gateway_capture_bodies (
    workspace_id TEXT NOT NULL,
    content_hash TEXT NOT NULL
                 CHECK(length(content_hash) = 71 AND
                       substr(content_hash, 1, 7) = 'sha256:' AND
                       substr(content_hash, 8) NOT GLOB '*[^0-9a-f]*'),
    key_id       TEXT NOT NULL REFERENCES gateway_keys(id) ON DELETE CASCADE,
    request_id   TEXT NOT NULL,
    role         TEXT NOT NULL CHECK(role IN ('request', 'response')),
    body         TEXT NOT NULL,
    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    -- Content-addressed: the same body captured twice is one row, and the
    -- primary key is what makes the INSERT OR IGNORE write idempotent.
    PRIMARY KEY (workspace_id, content_hash)
);
CREATE INDEX idx_gateway_capture_bodies_workspace ON gateway_capture_bodies(workspace_id);
CREATE INDEX idx_gateway_capture_bodies_request ON gateway_capture_bodies(request_id);

-- A virtual key's identity (which token opens it, which workspace owns it)
-- is immutable. Rotation means minting a new key and disabling the old one,
-- never repointing an existing row — otherwise the spend ledger's key_id
-- would silently change meaning underneath historical rows.
CREATE TRIGGER gateway_keys_token_hash_immutable
BEFORE UPDATE OF token_hash ON gateway_keys
WHEN NEW.token_hash <> OLD.token_hash
BEGIN
    SELECT RAISE(ABORT, 'gateway key token hash is immutable');
END;

CREATE TRIGGER gateway_keys_workspace_immutable
BEFORE UPDATE OF workspace_id ON gateway_keys
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
    SELECT RAISE(ABORT, 'gateway key workspace is immutable');
END;

-- The spend ledger is append-only for the same reason the event spine is:
-- a ledger you can rewrite is not evidence. Corrections are new rows.
CREATE TRIGGER gateway_requests_reject_update
BEFORE UPDATE ON gateway_requests
BEGIN
    SELECT RAISE(ABORT, 'gateway_requests is append-only');
END;

CREATE TRIGGER gateway_requests_reject_delete
BEFORE DELETE ON gateway_requests
BEGIN
    SELECT RAISE(ABORT, 'gateway_requests is append-only');
END;

-- Captured bodies are content-addressed, so mutating one would break the
-- hash that names it. DELETE stays permitted: redaction must be able to
-- purge content, and dropping the row leaves the referencing event's
-- content_hash dangling-but-honest rather than quietly falsified.
CREATE TRIGGER gateway_capture_bodies_immutable
BEFORE UPDATE ON gateway_capture_bodies
BEGIN
    SELECT RAISE(ABORT, 'captured gateway bodies are immutable');
END;
