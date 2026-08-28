-- Multimodal attachments (migration 0017, parity row 53).
--
-- Content-addressed and deduplicated at the D1 row level: the PRIMARY KEY is
-- (workspace_id, content_sha256), so uploading the same bytes twice inside a
-- workspace is a structural no-op (INSERT OR IGNORE) rather than a second row
-- — and src/attachments.ts uses that same identity to skip a second R2 write.
-- Bytes themselves live in the shared BODIES bucket (wrangler.toml) under
-- attachments/<workspace_id>/<content_sha256>; this table is the D1 index
-- over that object-store prefix, the same "index row over an R2 object"
-- shape migration 0006 established for artifact_file_list.
--
-- Substrate note (dated re-scope; see docs/parity-plan.md): row 53 describes
-- multimodal attachments direct-to-object-store. Our substrate is R2 fronted
-- by this Worker — POST /v1/attachments streams through the Worker and out
-- to R2, not a browser-to-R2 presigned upload. True presigned direct-to-R2
-- needs S3-compatible R2 account API keys, which is a separate, later slice.
--
-- target_type/target_id are an OPTIONAL pointer into the evidence graph (a
-- trace, span, session, or workstream) — soft, not a foreign key. This
-- module never reads traces/spans/sessions/workstreams to check the pointer
-- resolves to a real row, so an attachment may be uploaded before, or
-- without ever being linked to, the evidence it documents. The GLOB checks
-- below only pin target_id to the id *shape* that target_type implies.
--
-- Every table carries workspace_id (NOT NULL, indexed) per platform
-- convention.

CREATE TABLE attachments (
    workspace_id   TEXT NOT NULL
                   CHECK(length(workspace_id) = 30 AND
                         substr(workspace_id, 1, 4) = 'wsp_' AND
                         substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                         substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),

    -- Lowercase hex SHA-256 of the raw bytes (no "sha256:" wire prefix in
    -- this column — that prefix is a hfg.event.v1 body convention, applied
    -- only when this value is echoed into the attachment.recorded event).
    content_sha256 TEXT NOT NULL
                   CHECK(length(content_sha256) = 64 AND
                         content_sha256 NOT GLOB '*[^0-9a-f]*'),

    byte_size      INTEGER NOT NULL CHECK(byte_size >= 0),

    -- The upload allowlist, enforced here too (defense in depth alongside
    -- the API-edge check in src/attachments.ts's ATTACHMENT_CONTENT_TYPES).
    content_type   TEXT NOT NULL
                   CHECK(content_type IN ('image/png', 'image/jpeg', 'image/webp',
                                           'image/gif', 'application/pdf',
                                           'text/plain', 'application/json')),

    -- Client-supplied display name; never used to derive the R2 key or any
    -- path, only echoed back into Content-Disposition on download.
    filename       TEXT CHECK(filename IS NULL OR length(filename) BETWEEN 1 AND 255),

    target_type    TEXT CHECK(target_type IS NULL OR
                              target_type IN ('trace', 'span', 'session', 'workstream')),
    target_id      TEXT CHECK(target_id IS NULL OR length(target_id) BETWEEN 1 AND 64),

    created_at     INTEGER NOT NULL CHECK(created_at >= 0),

    PRIMARY KEY (workspace_id, content_sha256),

    -- target_type and target_id travel together or not at all.
    CHECK((target_type IS NULL) = (target_id IS NULL)),
    -- target_id's prefix must match the id grammar the rest of the platform
    -- already uses for that entity (trc_/spn_/ses_/ws_ + Crockford ULID).
    CHECK(target_type IS NULL OR
          (target_type = 'trace'      AND target_id GLOB 'trc_*') OR
          (target_type = 'span'       AND target_id GLOB 'spn_*') OR
          (target_type = 'session'    AND target_id GLOB 'ses_*') OR
          (target_type = 'workstream' AND target_id GLOB 'ws_*'))
);

CREATE INDEX idx_attachments_workspace ON attachments(workspace_id);
-- GET /v1/attachments listing order (newest first) and its cursor predicate.
CREATE INDEX idx_attachments_workspace_created
    ON attachments(workspace_id, created_at, content_sha256);
-- GET /v1/attachments?target_type=&target_id= filter.
CREATE INDEX idx_attachments_target
    ON attachments(workspace_id, target_type, target_id, created_at, content_sha256);

-- Attachments are immutable: the object at
-- attachments/<workspace_id>/<content_sha256> is content-addressed, so
-- nothing about the row that indexes it ever needs to change.
CREATE TRIGGER attachments_reject_update
BEFORE UPDATE ON attachments
BEGIN
    SELECT RAISE(ABORT, 'attachments are immutable');
END;

-- Matches the artifact_file_list precedent (migration 0006): purging a
-- workspace's attachments is an explicit operator action that must drop this
-- guard first, not a side effect of any sweep this platform runs today.
CREATE TRIGGER attachments_reject_delete
BEFORE DELETE ON attachments
BEGIN
    SELECT RAISE(ABORT, 'attachments are never deleted by a sweep');
END;
