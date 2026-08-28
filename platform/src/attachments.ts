// Multimodal attachments (parity row 53): content-addressed binary uploads
// stored alongside the event spine.
//
//   POST   /v1/attachments             device bearer, capability 'ingest'
//   GET    /v1/attachments             device bearer, capability 'read'
//   GET    /v1/attachments/{sha256}    device bearer, capability 'read'
//
// Substrate note (dated re-scope; see docs/parity-plan.md): row 53 describes
// attachments direct-to-object-store. Our substrate is R2 fronted by this
// Worker — the raw body streams THROUGH the Worker and out to R2; it is not
// a browser-to-R2 presigned upload. True presigned direct-to-R2 needs
// S3-compatible R2 account API keys, which this slice does not have and
// treats as a separate, later re-scope.
//
// Shape, end to end:
//   1. The upload's Content-Type is checked against a fixed allowlist before
//      a single byte of the body is read (415 otherwise).
//   2. The body is read as a raw byte stream (never JSON, never decoded as
//      UTF-8 text — attachments are binary). The reader tracks a running
//      byte total and aborts the stream the instant it would exceed the 8
//      MiB cap (413), so a request can never cause more than the cap to sit
//      in memory at once. SHA-256 is computed over exactly the bytes that
//      were streamed in.
//   3. content_sha256 is the row's identity: (workspace_id, content_sha256)
//      is the PRIMARY KEY (migration 0017). A hash already on file for this
//      workspace short-circuits the R2 write entirely — the bytes are
//      already there — and the call still answers 200, with
//      `deduplicated: true`.
//   4. The D1 row insert and the `attachment.recorded` event append both use
//      INSERT OR IGNORE with an id derived from (workspace_id,
//      content_sha256) alone, so re-uploading identical bytes is idempotent
//      on every write in this module, not just the R2 put.
//
// Every route here is device-plane. No route ever reads target_type/
// target_id back against traces/spans/sessions/workstreams — the pointer is
// soft, validated for shape only (see parseTargetRef), never for existence.

import { authenticate, hasCapability, type DeviceBinding, type DeviceLookup } from "./auth";
import type { D1DatabaseLike } from "./db";
import {
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  scopeDenial,
  type Validation,
} from "./ingest";

// -- Cloudflare bindings (structural; a plain-object fake satisfies these) --
// Deliberately not imported from src/artifacts.ts — this module owns its own
// copy of the shape it needs from the shared BODIES bucket. It differs from
// artifacts.ts's R2BucketLike in one load-bearing way: `put`'s value is raw
// bytes, not a string. Attachment content is arbitrary binary (images, PDFs)
// and round-tripping it through a JS string would corrupt it; artifacts.ts
// only ever writes UTF-8 NDJSON, so a string there is lossless.

export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string; contentDisposition?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectLike {
  readonly key: string;
  readonly size?: number;
}

/**
 * Only the members this module reads. `body` is optional so a fake can
 * return just `arrayBuffer()`; the download handler streams `body` when
 * present and falls back to the buffered bytes otherwise. `arrayBuffer()`,
 * not `text()`: a text() round trip would re-decode binary content as UTF-8
 * and corrupt it.
 */
export interface R2ObjectBodyLike {
  readonly body?: ReadableStream | null;
  readonly size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResultLike {
  objects: R2ObjectLike[];
  truncated?: boolean;
  cursor?: string;
}

export interface R2ListOptionsLike {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface R2BucketLike {
  put(key: string, value: Uint8Array, options?: R2PutOptionsLike): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
  list(options: R2ListOptionsLike): Promise<R2ListResultLike>;
}

/** BODIES is optional so the Worker still type-checks before the binding exists. */
export interface AttachmentsEnv {
  DB: D1DatabaseLike;
  BODIES?: R2BucketLike;
}

// -- tunables -----------------------------------------------------------------

export const MAX_ATTACHMENT_BYTES = 8_388_608; // 8 MiB
export const MAX_FILENAME_BYTES = 255;
export const MAX_TARGET_ID_BYTES = 64;

export const ATTACHMENT_CONTENT_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "application/json",
] as const);
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];
const ATTACHMENT_CONTENT_TYPE_SET: ReadonlySet<string> = new Set(ATTACHMENT_CONTENT_TYPES);

export const ATTACHMENT_TARGET_TYPES = Object.freeze([
  "trace",
  "span",
  "session",
  "workstream",
] as const);
export type AttachmentTargetType = (typeof ATTACHMENT_TARGET_TYPES)[number];

/** Id-shape check per target type: prefix + Crockford ULID body, matching
 * every other prefixed id in this platform (see migrations' CHECK idiom). */
const TARGET_ID_PATTERNS: Readonly<Record<AttachmentTargetType, RegExp>> = Object.freeze({
  trace: /^trc_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  span: /^spn_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  session: /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  workstream: /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
});

const ATTACHMENT_EVENT_KIND = "attachment.recorded";
const ATTACHMENT_EVENT_SCHEMA_VERSION = "hfg.event.v1";

const UTF8 = new TextEncoder();

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function invalid(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

// -- object key -----------------------------------------------------------------

/** attachments/<workspace_id>/<content_sha256> inside the shared BODIES bucket. */
export function attachmentObjectKey(workspaceId: string, contentSha256: string): string {
  return `attachments/${workspaceId}/${contentSha256}`;
}

// -- deterministic ids + hashing ------------------------------------------------
// Byte-compatible with the Go core's internal/ids.Deterministic (and every
// hosted mirror of it: src/otlp.ts, src/alerts.ts): prefix +
// ULID(ms, sha256(prefix + "|" + key)[0..10]) in the canonical Crockford
// layout. Reimplemented here rather than imported so this module owns every
// byte of its own id derivation, matching the rest of the platform.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EVENT_PREFIX = "evt_";

function encodeULIDTime(ms: number): string {
  let remaining = ms;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeULIDEntropy(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 10; i += 5) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const b3 = bytes[i + 3];
    const b4 = bytes[i + 4];
    out +=
      CROCKFORD[b0 >> 3] +
      CROCKFORD[((b0 & 7) << 2) | (b1 >> 6)] +
      CROCKFORD[(b1 & 63) >> 1] +
      CROCKFORD[((b1 & 1) << 4) | (b2 >> 4)] +
      CROCKFORD[((b2 & 15) << 1) | (b3 >> 7)] +
      CROCKFORD[(b3 & 127) >> 2] +
      CROCKFORD[((b3 & 3) << 3) | (b4 >> 5)] +
      CROCKFORD[b4 & 31];
  }
  return out;
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(digest);
}

/** Hex SHA-256 over raw bytes (never a string round trip — see the R2BucketLike note above). */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await sha256Bytes(bytes);
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The id of the attachment.recorded event for (workspace, content hash). A
 * pure function of the content identity ALONE — never of target_type/
 * target_id or of upload time — so re-uploading identical bytes (with or
 * without a different target this time) derives the same id and the second
 * append is an INSERT OR IGNORE no-op, exactly mirroring the D1 row's own
 * (workspace_id, content_sha256) identity. The ULID time component is fixed
 * at 0, the same choice src/otlp.ts makes for session/trace ids: those
 * identities are not chronological, so there is no meaningful timestamp to
 * embed.
 */
export async function attachmentEventID(workspaceId: string, contentSha256: string): Promise<string> {
  const key = `attachment|${workspaceId}|${contentSha256}`;
  const entropy = (await sha256Bytes(UTF8.encode(`${EVENT_PREFIX}|${key}`))).slice(0, 10);
  return EVENT_PREFIX + encodeULIDTime(0) + encodeULIDEntropy(entropy);
}

// -- content-type + query validation --------------------------------------------

function mediaTypeOf(contentType: string | null): string {
  if (contentType === null) return "";
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

export interface TargetRef {
  type: AttachmentTargetType;
  id: string;
}

/**
 * Shared by the POST body's ?target_type=&target_id= and the GET list's
 * ?target_type=&target_id= filter: both travel together or not at all, and
 * target_id must match the id shape target_type implies. Existence against
 * traces/spans/sessions/workstreams is never checked (see the module note).
 */
export function parseTargetRef(params: URLSearchParams): Validation<TargetRef | null> {
  const type = params.get("target_type");
  const id = params.get("target_id");
  if (type === null && id === null) return { ok: true, value: null };
  if (type === null || id === null) {
    return invalid(400, "target_type and target_id must be provided together");
  }
  if (!(ATTACHMENT_TARGET_TYPES as readonly string[]).includes(type)) {
    return invalid(400, `target_type must be one of: ${ATTACHMENT_TARGET_TYPES.join(", ")}`);
  }
  const target = type as AttachmentTargetType;
  if (id.length === 0 || UTF8.encode(id).byteLength > MAX_TARGET_ID_BYTES) {
    return invalid(400, `target_id must be 1-${MAX_TARGET_ID_BYTES} UTF-8 bytes`);
  }
  if (!TARGET_ID_PATTERNS[target].test(id)) {
    return invalid(400, `target_id does not match the id format for target_type ${target}`);
  }
  return { ok: true, value: { type: target, id } };
}

// Control characters, the double quote, and the backslash are rejected
// outright rather than escaped: it keeps the value that reaches
// Content-Disposition provably free of header-injection characters with no
// second escaping step to get right at read time.
const FILENAME_FORBIDDEN = /[\x00-\x1f\x7f"\\]/;

export function parseFilenameParam(params: URLSearchParams): Validation<string | null> {
  const raw = params.get("filename");
  if (raw === null) return { ok: true, value: null };
  if (raw.length === 0) return invalid(400, "filename must not be empty");
  if (UTF8.encode(raw).byteLength > MAX_FILENAME_BYTES) {
    return invalid(400, `filename must be at most ${MAX_FILENAME_BYTES} UTF-8 bytes`);
  }
  if (FILENAME_FORBIDDEN.test(raw)) {
    return invalid(400, "filename must not contain control characters, quotes, or backslashes");
  }
  return { ok: true, value: raw };
}

// -- streaming body read ---------------------------------------------------------

export type AttachmentBodyRead =
  | { ok: true; bytes: Uint8Array; sha256: string }
  | { ok: false; status: 413 | 400; error: string };

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read a raw request body without ever holding more than `maxBytes` (plus,
 * at most, the one chunk that pushed the running total over the line — a
 * stream cannot be truncated mid-chunk) in memory: the running byte total is
 * checked after every chunk, and the instant it would exceed the cap the
 * reader is cancelled and no more of the body is read. content-length is
 * checked first as a free fast path when the client sent one, exactly
 * mirroring ingest.ts's readRequestBody — the difference is this reader
 * never decodes the bytes as UTF-8 text, since attachment content is
 * arbitrary binary.
 */
export async function readAttachmentBody(
  request: Request,
  maxBytes: number,
): Promise<AttachmentBodyRead> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { ok: false, status: 413, error: `request body exceeds ${maxBytes} bytes` };
    }
  }

  if (request.body === null) {
    const bytes = new Uint8Array(0);
    return { ok: true, bytes, sha256: await sha256HexBytes(bytes) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large");
        return { ok: false, status: 413, error: `request body exceeds ${maxBytes} bytes` };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, status: 400, error: "unreadable request body" };
  } finally {
    reader.releaseLock();
  }
  const bytes = concatBytes(chunks, total);
  const sha256 = await sha256HexBytes(bytes);
  return { ok: true, bytes, sha256 };
}

// -- attachment.recorded event ---------------------------------------------------

export interface AttachmentEventInput {
  eventId: string;
  contentSha256: string;
  byteSize: number;
  contentType: string;
  targetType: AttachmentTargetType | null;
  targetId: string | null;
  occurredAtISO: string;
}

/**
 * The canonical hfg.event.v1 record. Deliberately excludes filename: it is
 * cosmetic, user-controlled display metadata, not evidence, and keeping it
 * out of the append-only spine matches the platform's content-free-logging
 * instinct (filenames are not "content" in the payload sense, but they are
 * also not needed to make this evidence useful, so the narrower record
 * wins). target_type/target_id are included only when this upload actually
 * carried one, matching the "?" fields in the parity-row payload shape.
 */
export function buildAttachmentEvent(input: AttachmentEventInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    content_sha256: input.contentSha256,
    byte_size: input.byteSize,
    content_type: input.contentType,
  };
  if (input.targetType !== null) payload.target_type = input.targetType;
  if (input.targetId !== null) payload.target_id = input.targetId;
  return {
    schema_version: ATTACHMENT_EVENT_SCHEMA_VERSION,
    event_id: input.eventId,
    kind: ATTACHMENT_EVENT_KIND,
    occurred_at: input.occurredAtISO,
    provenance: "OBSERVED",
    content_hash: `sha256:${input.contentSha256}`,
    payload,
  };
}

// -- SQL --------------------------------------------------------------------------

const DEVICE_BY_TOKEN_SQL = `
  /* attachments:device-by-token */
  SELECT id, workspace_id, token_hash, capabilities, revoked_at
  FROM devices
  WHERE token_hash = ?1`;

const ATTACHMENT_BY_HASH_SQL = `
  /* attachments:by-hash */
  SELECT workspace_id, content_sha256, byte_size, content_type, filename,
         target_type, target_id, created_at
  FROM attachments
  WHERE workspace_id = ?1 AND content_sha256 = ?2
  LIMIT 1`;

const INSERT_ATTACHMENT_SQL = `
  /* attachments:insert-row */
  INSERT OR IGNORE INTO attachments
    (workspace_id, content_sha256, byte_size, content_type, filename,
     target_type, target_id, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`;

const INSERT_EVENT_SQL = `
  /* attachments:insert-event */
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, NULL, ?3, ?4, ?5, NULL, 'attachments', 'attachment.recorded',
          'OBSERVED', ?6, ?7, ?8)`;

const ATTACHMENTS_PAGE_SQL = `
  /* attachments:page */
  SELECT workspace_id, content_sha256, byte_size, content_type, filename,
         target_type, target_id, created_at
  FROM attachments
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, content_sha256 DESC
  LIMIT ?2`;

const ATTACHMENTS_PAGE_AFTER_SQL = `
  /* attachments:page-after */
  SELECT workspace_id, content_sha256, byte_size, content_type, filename,
         target_type, target_id, created_at
  FROM attachments
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND content_sha256 < ?3))
  ORDER BY created_at DESC, content_sha256 DESC
  LIMIT ?4`;

const ATTACHMENTS_PAGE_TARGET_SQL = `
  /* attachments:page-target */
  SELECT workspace_id, content_sha256, byte_size, content_type, filename,
         target_type, target_id, created_at
  FROM attachments
  WHERE workspace_id = ?1 AND target_type = ?2 AND target_id = ?3
  ORDER BY created_at DESC, content_sha256 DESC
  LIMIT ?4`;

const ATTACHMENTS_PAGE_TARGET_AFTER_SQL = `
  /* attachments:page-target-after */
  SELECT workspace_id, content_sha256, byte_size, content_type, filename,
         target_type, target_id, created_at
  FROM attachments
  WHERE workspace_id = ?1 AND target_type = ?2 AND target_id = ?3
    AND (created_at < ?4 OR (created_at = ?4 AND content_sha256 < ?5))
  ORDER BY created_at DESC, content_sha256 DESC
  LIMIT ?6`;

interface AttachmentRow {
  workspace_id: string;
  content_sha256: string;
  byte_size: number;
  content_type: string;
  filename: string | null;
  target_type: string | null;
  target_id: string | null;
  created_at: number;
}

function attachmentSummary(row: AttachmentRow): Record<string, unknown> {
  return {
    content_sha256: row.content_sha256,
    byte_size: row.byte_size,
    content_type: row.content_type,
    filename: row.filename,
    target_type: row.target_type,
    target_id: row.target_id,
    created_at: row.created_at,
  };
}

function compareAttachmentRows(a: AttachmentRow, b: AttachmentRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.content_sha256 !== b.content_sha256) return a.content_sha256 > b.content_sha256 ? -1 : 1;
  return 0;
}

// -- device auth --------------------------------------------------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

function deviceLookup(db: D1DatabaseLike): DeviceLookup {
  return {
    async byTokenHash(hash) {
      const record = await db.prepare(DEVICE_BY_TOKEN_SQL).bind(hash).first<DeviceRecord>();
      if (record === null) return null;
      return {
        deviceId: record.id,
        workspaceId: record.workspace_id,
        tokenHash: record.token_hash,
        capabilities:
          record.capabilities === null
            ? []
            : record.capabilities
                .split(",")
                .map((capability) => capability.trim())
                .filter((capability) => capability.length > 0),
        revokedAt: record.revoked_at,
      };
    },
  };
}

async function authorizeDevice(
  request: Request,
  env: AttachmentsEnv,
  capability: "ingest" | "read",
): Promise<{ device: DeviceBinding } | { response: Response }> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return { response: json(auth.status, { error: auth.error }) };
  const denial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, capability),
  });
  if (denial !== null) return { response: json(denial.status, { error: denial.error }) };
  return { device: auth.device };
}

// -- POST /v1/attachments ------------------------------------------------------

async function createAttachment(request: Request, env: AttachmentsEnv): Promise<Response> {
  const auth = await authorizeDevice(request, env, "ingest");
  if ("response" in auth) return auth.response;
  const bucket = env.BODIES;
  if (bucket === undefined) return json(503, { error: "object storage is not configured" });

  const mediaType = mediaTypeOf(request.headers.get("content-type"));
  if (!ATTACHMENT_CONTENT_TYPE_SET.has(mediaType)) {
    return json(415, {
      error: `content-type must be one of: ${ATTACHMENT_CONTENT_TYPES.join(", ")}`,
    });
  }

  const url = new URL(request.url);
  const target = parseTargetRef(url.searchParams);
  if (!target.ok) return json(target.status, { error: target.error });
  const filename = parseFilenameParam(url.searchParams);
  if (!filename.ok) return json(filename.status, { error: filename.error });

  // Validate before touching the network/stream: an oversized or
  // unreadable body should never even be charged against the allowlist and
  // target checks above having already passed for nothing.
  const bodyRead = await readAttachmentBody(request, MAX_ATTACHMENT_BYTES);
  if (!bodyRead.ok) return json(bodyRead.status, { error: bodyRead.error });
  const { bytes, sha256 } = bodyRead;

  const workspaceId = auth.device.workspaceId;
  const existing = await env.DB.prepare(ATTACHMENT_BY_HASH_SQL)
    .bind(workspaceId, sha256)
    .first<AttachmentRow>();
  const deduplicated = existing !== null;

  // Content-addressed: identical bytes already sit at this exact key, so a
  // second write would only reproduce them. Skip it, but still run the
  // (idempotent) D1 writes below unconditionally — INSERT OR IGNORE makes
  // that safe and keeps one code path instead of two.
  if (!deduplicated) {
    await bucket.put(attachmentObjectKey(workspaceId, sha256), bytes, {
      httpMetadata: { contentType: mediaType },
    });
  }

  // What the row actually ends up holding: this call's own values on a
  // fresh upload, or — on a dedupe — whatever the FIRST upload recorded.
  // INSERT OR IGNORE below never touches content_type/filename/target on an
  // existing row, so a re-upload that declared a different Content-Type,
  // filename, or target must not claim credit for values it never wrote;
  // the response (and the event below) has to describe the row as it truly
  // is, not as this request imagined it.
  const record: AttachmentRow = existing ?? {
    workspace_id: workspaceId,
    content_sha256: sha256,
    byte_size: bytes.byteLength,
    content_type: mediaType,
    filename: filename.value,
    target_type: target.value?.type ?? null,
    target_id: target.value?.id ?? null,
    created_at: Math.floor(Date.now() / 1_000),
  };
  // Safe: target_type only ever reaches this column through parseTargetRef
  // (this call) or a row that already passed migration 0017's enum CHECK.
  const recordTargetType = record.target_type as AttachmentTargetType | null;

  const occurredAtISO = new Date(record.created_at * 1_000).toISOString();
  const eventId = await attachmentEventID(workspaceId, sha256);
  const event = buildAttachmentEvent({
    eventId,
    contentSha256: sha256,
    byteSize: record.byte_size,
    contentType: record.content_type,
    targetType: recordTargetType,
    targetId: record.target_id,
    occurredAtISO,
  });

  await env.DB.batch([
    env.DB.prepare(INSERT_ATTACHMENT_SQL).bind(
      workspaceId,
      sha256,
      record.byte_size,
      record.content_type,
      record.filename,
      record.target_type,
      record.target_id,
      record.created_at,
    ),
    env.DB.prepare(INSERT_EVENT_SQL).bind(
      workspaceId,
      eventId,
      occurredAtISO,
      recordTargetType === "workstream" ? record.target_id : null,
      recordTargetType === "session" ? record.target_id : null,
      `sha256:${sha256}`,
      record.created_at,
      canonicalJsonStringify(event),
    ),
  ]);

  return json(200, { ...attachmentSummary(record), deduplicated });
}

// -- GET /v1/attachments --------------------------------------------------------

async function listAttachments(request: Request, env: AttachmentsEnv): Promise<Response> {
  const auth = await authorizeDevice(request, env, "read");
  if ("response" in auth) return auth.response;

  const url = new URL(request.url);
  const target = parseTargetRef(url.searchParams);
  if (!target.ok) return json(target.status, { error: target.error });
  const page = parsePagination(url);
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1; // prefetch one row to detect the next page

  const workspaceId = auth.device.workspaceId;
  const result =
    target.value === null
      ? cursor === null
        ? await env.DB.prepare(ATTACHMENTS_PAGE_SQL)
            .bind(workspaceId, fetchLimit)
            .all<AttachmentRow>()
        : await env.DB.prepare(ATTACHMENTS_PAGE_AFTER_SQL)
            .bind(workspaceId, cursor.createdAt, cursor.id, fetchLimit)
            .all<AttachmentRow>()
      : cursor === null
        ? await env.DB.prepare(ATTACHMENTS_PAGE_TARGET_SQL)
            .bind(workspaceId, target.value.type, target.value.id, fetchLimit)
            .all<AttachmentRow>()
        : await env.DB.prepare(ATTACHMENTS_PAGE_TARGET_AFTER_SQL)
            .bind(
              workspaceId,
              target.value.type,
              target.value.id,
              cursor.createdAt,
              cursor.id,
              fetchLimit,
            )
            .all<AttachmentRow>();

  // Re-sort: the response must not depend on storage order.
  const sorted = [...result.results].sort(compareAttachmentRows);
  const items = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(attachmentSummary),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.content_sha256 })
        : null,
  });
}

// -- GET /v1/attachments/{sha256} ------------------------------------------------

function contentDisposition(filename: string | null, fallback: string): string {
  // filename was already checked at write time to exclude control
  // characters, quotes, and backslashes (parseFilenameParam), so it is safe
  // to embed directly here with no further escaping.
  return `attachment; filename="${filename ?? fallback}"`;
}

async function downloadAttachment(
  request: Request,
  env: AttachmentsEnv,
  contentSha256: string,
): Promise<Response> {
  const auth = await authorizeDevice(request, env, "read");
  if ("response" in auth) return auth.response;
  const bucket = env.BODIES;
  if (bucket === undefined) return json(503, { error: "object storage is not configured" });

  const workspaceId = auth.device.workspaceId;
  const row = await env.DB.prepare(ATTACHMENT_BY_HASH_SQL)
    .bind(workspaceId, contentSha256)
    .first<AttachmentRow>();
  if (row === null) return json(404, { error: "not found" });
  // Defence in depth: the query already binds workspace_id, but a foreign
  // row must never be rendered even if a future join loosens the predicate.
  if (scopeDenial({ resourceWorkspaceId: row.workspace_id, tokenWorkspaceId: workspaceId }) !== null) {
    return json(404, { error: "not found" });
  }

  const object = await bucket.get(attachmentObjectKey(workspaceId, contentSha256));
  if (object === null) {
    // The D1 row is present but the R2 object behind it is not — a real gap
    // (a botched migration, a manual bucket edit), not ordinary "not found".
    return json(410, {
      error: "gone",
      note: "the attachment record exists but its stored object is missing",
    });
  }

  const body = object.body ?? (await object.arrayBuffer());
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": contentDisposition(row.filename, row.content_sha256),
      "content-type": row.content_type,
      "x-content-type-options": "nosniff",
    },
  });
}

// -- routing seam -------------------------------------------------------------

const DOWNLOAD_PATH_PATTERN = /^\/v1\/attachments\/([0-9a-f]{64})$/;

/**
 * Route the attachments surface. Returns null when this module does not own
 * the path so index.ts can continue; a wrong method on a path this module
 * owns also returns null, which the router answers with 404 (house rule:
 * known paths never advertise their supported methods).
 */
export async function handleAttachmentsRoute(
  request: Request,
  env: AttachmentsEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/attachments") {
    if (request.method === "POST") return createAttachment(request, env);
    if (request.method === "GET") return listAttachments(request, env);
    return null;
  }
  const match = DOWNLOAD_PATH_PATTERN.exec(pathname);
  if (match !== null) {
    if (request.method !== "GET") return null;
    return downloadAttachment(request, env, match[1]);
  }
  return null;
}
