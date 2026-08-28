// Unit tests for src/attachments.ts — multimodal attachments (parity row 53).
//
// No miniflare: D1 is the structural seam from src/db.ts, wrapped around REAL
// node:sqlite for the HTTP-level tests (SqliteD1, mirroring test/quality.ts's
// adapter) so INSERT OR IGNORE dedup, the (workspace_id, content_sha256)
// PRIMARY KEY, and every CHECK/trigger in migration 0017 are exercised for
// real rather than reimplemented as a hand-rolled JS mock. R2 is the
// structural R2BucketLike this module defines itself (put's value is raw
// bytes, not a string — see the comment in src/attachments.ts).

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1RunResultLike, D1Statement } from "../src/db";
import { canonicalJsonStringify } from "../src/ingest";
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_TARGET_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_FILENAME_BYTES,
  MAX_TARGET_ID_BYTES,
  attachmentEventID,
  attachmentObjectKey,
  buildAttachmentEvent,
  handleAttachmentsRoute,
  parseFilenameParam,
  parseTargetRef,
  readAttachmentBody,
  sha256HexBytes,
  type AttachmentsEnv,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2PutOptionsLike,
} from "../src/attachments";

// -- SQLite-backed D1DatabaseLike adapter (mirrors test/quality.test.ts) -------

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(sql: string): D1Statement {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]): D1BoundStatement {
        const params = values as (null | number | bigint | string | Uint8Array)[];
        return {
          async first<T>(): Promise<T | null> {
            const row = sqlite.prepare(sql).get(...params);
            return row === undefined ? null : (row as T);
          },
          async all<T>(): Promise<{ results: T[] }> {
            const rows = sqlite.prepare(sql).all(...params);
            return { results: rows as T[] };
          },
          async run<T>(): Promise<D1RunResultLike<T>> {
            const info = sqlite.prepare(sql).run(...params);
            return { success: true, meta: { changes: Number(info.changes) } };
          },
        };
      },
    };
  }

  async batch(statements: D1BoundStatement[]): Promise<D1RunResultLike[]> {
    const out: D1RunResultLike[] = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

// -- migration truth ------------------------------------------------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0017_attachments.sql";
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql") && name <= THIS_MIGRATION)
  .sort();

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) {
    db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
  }
  return db;
}

// -- fixtures -------------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const OTHER_WORKSPACE = "wsp_01HTSTW0RKSPEER0000000000Z";

const DEVICE_TOKEN = "dev_attachments-full-0001";
const DEVICE_ID = "dev_01HTSTDEVFULL00000000000Z";
const READ_ONLY_TOKEN = "dev_attachments-read-0001";
const READ_ONLY_DEVICE_ID = "dev_01HTSTDEVREADONLY0000Z";
const INGEST_ONLY_TOKEN = "dev_attachments-ingest-0001";
const INGEST_ONLY_DEVICE_ID = "dev_01HTSTDEVINGESTONLYZ";

let TOKEN_HASH = "";
let READ_ONLY_HASH = "";
let INGEST_ONLY_HASH = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
  READ_ONLY_HASH = await sha256Hex(READ_ONLY_TOKEN);
  INGEST_ONLY_HASH = await sha256Hex(INGEST_ONLY_TOKEN);
});

// Well-formed target ids: prefix + 26-char Crockford ULID body, first char
// in [0-7] — the exact grammar migration 0017's GLOB checks and
// src/attachments.ts's TARGET_ID_PATTERNS both require.
const TRACE_ID = `trc_${"0".repeat(26)}`;
const SPAN_ID = `spn_${"0".repeat(26)}`;
const SESSION_ID = `ses_${"0".repeat(26)}`;
const WORKSTREAM_ID = `ws_${"0".repeat(26)}`;

const UTF8 = new TextEncoder();

function sha256Node(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// -- db fixtures ------------------------------------------------------------------

/**
 * Migration 0003 gates every device insert on an active workspace_entitlements
 * row (devices_charge_entitlement: AFTER INSERT ON devices, RAISE(ABORT,
 * 'device quota exceeded') when none matches). attachments.ts itself never
 * touches workspaces/workspace_entitlements — this is purely fixture
 * plumbing so authenticate() has a real device row to find, generously
 * provisioned so it never becomes the thing under test.
 */
function insertWorkspace(db: DatabaseSync, workspaceId: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, workspace_id, name, created_at)
    VALUES (?, ?, 'Test workspace', 100)
  `).run(workspaceId, workspaceId);
  db.prepare(`
    INSERT INTO workspace_entitlements
      (workspace_id, max_devices, max_device_issuances, period_start, period_end, created_at, updated_at)
    VALUES (?, 20, 20, 0, 999999999999, 100, 100)
  `).run(workspaceId);
}

function insertDevice(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    workspace_id: string;
    token_hash: string;
    capabilities: string;
    created_at: number;
    revoked_at: number | null;
  }> = {},
): void {
  const row = {
    id: DEVICE_ID,
    workspace_id: TOKEN_WORKSPACE,
    token_hash: TOKEN_HASH,
    capabilities: "ingest,read",
    created_at: 1_700_000_000,
    revoked_at: null,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO devices (id, workspace_id, token_hash, capabilities, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.workspace_id, row.token_hash, row.capabilities, row.created_at, row.revoked_at);
}

interface AttachmentFixtureRow {
  workspace_id: string;
  content_sha256: string;
  byte_size: number;
  content_type: string;
  filename: string | null;
  target_type: string | null;
  target_id: string | null;
  created_at: number;
}

function insertAttachment(db: DatabaseSync, overrides: Partial<AttachmentFixtureRow> = {}): void {
  const row: AttachmentFixtureRow = {
    workspace_id: TOKEN_WORKSPACE,
    content_sha256: "a".repeat(64),
    byte_size: 10,
    content_type: "text/plain",
    filename: null,
    target_type: null,
    target_id: null,
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO attachments
      (workspace_id, content_sha256, byte_size, content_type, filename, target_type, target_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.workspace_id,
    row.content_sha256,
    row.byte_size,
    row.content_type,
    row.filename,
    row.target_type,
    row.target_id,
    row.created_at,
  );
}

// -- R2 fake ------------------------------------------------------------------

function fakeBucket(options: { stream?: boolean } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; options?: R2PutOptionsLike }>();
  const puts: string[] = [];
  const bucket: R2BucketLike = {
    async put(key, value, putOptions) {
      objects.set(key, { bytes: value, options: putOptions });
      puts.push(key);
      return {};
    },
    async get(key): Promise<R2ObjectBodyLike | null> {
      const stored = objects.get(key);
      if (stored === undefined) return null;
      return {
        body: options.stream === true ? new Response(stored.bytes).body : undefined,
        size: stored.bytes.byteLength,
        async arrayBuffer() {
          return stored.bytes.slice().buffer;
        },
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(listOptions) {
      const prefix = listOptions.prefix ?? "";
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
  };
  return { bucket, objects, puts };
}

// -- HTTP helpers -----------------------------------------------------------------

// RequestInit ambiently typed from worker-configuration.d.ts has no `duplex`
// member (Workers itself needs no such opt-in), but Node's real Request
// constructor — what actually runs under vitest — requires it whenever the
// body is a ReadableStream. Widening the accepted init type keeps the cast
// contained to this one helper instead of sprinkled through every test.
type StreamingInit = RequestInit & { duplex?: "half" };

function request(path: string, init: StreamingInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init as RequestInit);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

function routeEnv(options: { noBucket?: boolean; stream?: boolean } = {}) {
  const db = migratedDatabase();
  insertWorkspace(db, TOKEN_WORKSPACE);
  insertDevice(db);
  insertDevice(db, { id: READ_ONLY_DEVICE_ID, token_hash: READ_ONLY_HASH, capabilities: "read" });
  insertDevice(db, {
    id: INGEST_ONLY_DEVICE_ID,
    token_hash: INGEST_ONLY_HASH,
    capabilities: "ingest",
  });
  const { bucket, objects, puts } = fakeBucket({ stream: options.stream });
  const env: AttachmentsEnv = {
    DB: new SqliteD1(db),
    BODIES: options.noBucket === true ? undefined : bucket,
  };
  return { env, db, bucket, objects, puts };
}

function eventRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM events WHERE kind = 'attachment.recorded' ORDER BY seq")
    .all() as Array<Record<string, unknown>>;
}

function attachmentRows(db: DatabaseSync): AttachmentFixtureRow[] {
  return db.prepare("SELECT * FROM attachments ORDER BY content_sha256").all() as unknown as AttachmentFixtureRow[];
}

// ================================================================================
// pure functions
// ================================================================================

describe("attachmentObjectKey", () => {
  it("is content-addressed under the workspace prefix", () => {
    expect(attachmentObjectKey(TOKEN_WORKSPACE, "a".repeat(64))).toBe(
      `attachments/${TOKEN_WORKSPACE}/${"a".repeat(64)}`,
    );
  });
});

describe("sha256HexBytes", () => {
  it("matches the well-known NIST test vectors", async () => {
    expect(await sha256HexBytes(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256HexBytes(UTF8.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("agrees with node:crypto over arbitrary bytes", async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
    expect(await sha256HexBytes(bytes)).toBe(sha256Node(bytes));
  });

  it("is sensitive to every byte, not just length", async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(await sha256HexBytes(a)).not.toBe(await sha256HexBytes(b));
  });
});

describe("attachmentEventID", () => {
  it("is a pure function of (workspace, content hash) alone", async () => {
    const first = await attachmentEventID(TOKEN_WORKSPACE, "a".repeat(64));
    const again = await attachmentEventID(TOKEN_WORKSPACE, "a".repeat(64));
    expect(first).toBe(again);
    expect(first).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("differs across workspace or content hash", async () => {
    const base = await attachmentEventID(TOKEN_WORKSPACE, "a".repeat(64));
    const otherWorkspace = await attachmentEventID(OTHER_WORKSPACE, "a".repeat(64));
    const otherHash = await attachmentEventID(TOKEN_WORKSPACE, "b".repeat(64));
    expect(otherWorkspace).not.toBe(base);
    expect(otherHash).not.toBe(base);
  });

  it("always encodes ULID time zero — the id has no chronological meaning", async () => {
    const id = await attachmentEventID(TOKEN_WORKSPACE, "c".repeat(64));
    expect(id.slice(4, 14)).toBe("0000000000");
  });
});

describe("parseTargetRef", () => {
  it("accepts every target type paired with a well-formed id", () => {
    const cases: Array<[string, string]> = [
      ["trace", TRACE_ID],
      ["span", SPAN_ID],
      ["session", SESSION_ID],
      ["workstream", WORKSTREAM_ID],
    ];
    for (const [type, id] of cases) {
      const parsed = parseTargetRef(new URLSearchParams({ target_type: type, target_id: id }));
      expect(parsed).toEqual({ ok: true, value: { type, id } });
    }
    expect(ATTACHMENT_TARGET_TYPES).toEqual(["trace", "span", "session", "workstream"]);
  });

  it("accepts neither param as 'no target'", () => {
    expect(parseTargetRef(new URLSearchParams())).toEqual({ ok: true, value: null });
  });

  it("rejects one of the pair without the other", () => {
    expect(parseTargetRef(new URLSearchParams({ target_type: "trace" })).ok).toBe(false);
    expect(parseTargetRef(new URLSearchParams({ target_id: TRACE_ID })).ok).toBe(false);
  });

  it("rejects an unknown target_type", () => {
    const parsed = parseTargetRef(new URLSearchParams({ target_type: "commit", target_id: "x" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.status).toBe(400);
  });

  it("rejects a target_id whose shape does not match target_type", () => {
    // A well-formed id, but for the wrong entity.
    const parsed = parseTargetRef(
      new URLSearchParams({ target_type: "trace", target_id: WORKSTREAM_ID }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects an empty or oversized target_id", () => {
    expect(
      parseTargetRef(new URLSearchParams({ target_type: "trace", target_id: "" })).ok,
    ).toBe(false);
    expect(
      parseTargetRef(
        new URLSearchParams({ target_type: "trace", target_id: "trc_" + "0".repeat(MAX_TARGET_ID_BYTES) }),
      ).ok,
    ).toBe(false);
  });
});

describe("parseFilenameParam", () => {
  it("accepts absence as null and a plain name as itself", () => {
    expect(parseFilenameParam(new URLSearchParams())).toEqual({ ok: true, value: null });
    expect(parseFilenameParam(new URLSearchParams({ filename: "report.pdf" }))).toEqual({
      ok: true,
      value: "report.pdf",
    });
  });

  it("rejects empty, oversized, and header-unsafe filenames", () => {
    expect(parseFilenameParam(new URLSearchParams({ filename: "" })).ok).toBe(false);
    // Every character is 3 UTF-8 bytes (e.g. U+2603 SNOWMAN), so a string well
    // under MAX_FILENAME_BYTES in *character* count still overflows in bytes.
    const overBudget = "☃".repeat(Math.ceil(MAX_FILENAME_BYTES / 3) + 1);
    expect(parseFilenameParam(new URLSearchParams({ filename: overBudget })).ok).toBe(false);
    for (const bad of ['bad"name.png', "bad\\name.png", "bad\nname.png", "bad\x00name.png"]) {
      const parsed = parseFilenameParam(new URLSearchParams({ filename: bad }));
      expect(parsed.ok, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });

  it("accepts a filename at exactly the byte budget", () => {
    const atBudget = "a".repeat(MAX_FILENAME_BYTES);
    expect(parseFilenameParam(new URLSearchParams({ filename: atBudget })).ok).toBe(true);
  });
});

describe("readAttachmentBody", () => {
  function streamingRequest(chunks: Uint8Array[]): { req: Request; pulls: () => number } {
    let pulls = 0;
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        pulls++;
        controller.enqueue(chunks[index]);
        index++;
      },
    });
    return {
      req: request("/v1/attachments", { method: "POST", body: stream, duplex: "half" }),
      pulls: () => pulls,
    };
  }

  it("reads a small body and derives its sha256", async () => {
    const bytes = UTF8.encode("hello attachment");
    const result = await readAttachmentBody(
      request("/v1/attachments", { method: "POST", body: bytes }),
      MAX_ATTACHMENT_BYTES,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.bytes)).toBe("hello attachment");
      expect(result.sha256).toBe(sha256Node(bytes));
    }
  });

  it("treats a bodyless request as zero bytes", async () => {
    const result = await readAttachmentBody(request("/v1/attachments"), MAX_ATTACHMENT_BYTES);
    expect(result).toEqual({ ok: true, bytes: new Uint8Array(0), sha256: await sha256HexBytes(new Uint8Array(0)) });
  });

  it("accepts exactly the cap and rejects a single byte over it", async () => {
    const atCap = new Uint8Array(MAX_ATTACHMENT_BYTES);
    const overCap = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    const ok = await readAttachmentBody(
      request("/v1/attachments", { method: "POST", body: atCap }),
      MAX_ATTACHMENT_BYTES,
    );
    expect(ok.ok).toBe(true);
    const over = await readAttachmentBody(
      request("/v1/attachments", { method: "POST", body: overCap }),
      MAX_ATTACHMENT_BYTES,
    );
    expect(over).toEqual({ ok: false, status: 413, error: expect.stringContaining("exceeds") });
  });

  it("enforces a small cap across chunk boundaries without buffering past it", async () => {
    const { req, pulls } = streamingRequest([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
    const result = await readAttachmentBody(req, 10);
    expect(result).toEqual({ ok: false, status: 413, error: expect.stringContaining("10 bytes") });
    // The cap (10) is crossed by the second 6-byte chunk (total 12); the third
    // chunk must never be pulled.
    expect(pulls()).toBe(2);
  });

  it("rejects immediately on an oversized content-length header, before reading the body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("must not be read");
      },
    });
    const result = await readAttachmentBody(
      request("/v1/attachments", {
        method: "POST",
        headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) },
        body: stream,
        duplex: "half",
      }),
      MAX_ATTACHMENT_BYTES,
    );
    expect(result).toEqual({ ok: false, status: 413, error: expect.any(String) });
  });
});

describe("buildAttachmentEvent", () => {
  it("shapes the payload with the required fields and the optional target only when present", () => {
    const withoutTarget = buildAttachmentEvent({
      eventId: "evt_test",
      contentSha256: "a".repeat(64),
      byteSize: 42,
      contentType: "image/png",
      targetType: null,
      targetId: null,
      occurredAtISO: "2026-08-28T00:00:00.000Z",
    });
    expect(withoutTarget).toMatchObject({
      schema_version: "hfg.event.v1",
      event_id: "evt_test",
      kind: "attachment.recorded",
      provenance: "OBSERVED",
      content_hash: `sha256:${"a".repeat(64)}`,
      payload: { content_sha256: "a".repeat(64), byte_size: 42, content_type: "image/png" },
    });
    expect((withoutTarget.payload as Record<string, unknown>)).not.toHaveProperty("target_type");
    expect((withoutTarget.payload as Record<string, unknown>)).not.toHaveProperty("target_id");

    const withTarget = buildAttachmentEvent({
      eventId: "evt_test2",
      contentSha256: "b".repeat(64),
      byteSize: 7,
      contentType: "application/pdf",
      targetType: "trace",
      targetId: TRACE_ID,
      occurredAtISO: "2026-08-28T00:00:00.000Z",
    });
    expect(withTarget.payload).toMatchObject({ target_type: "trace", target_id: TRACE_ID });
  });
});

// ================================================================================
// POST /v1/attachments
// ================================================================================

describe("POST /v1/attachments", () => {
  it("stores an allowlisted upload, writes one R2 object, and appends the event", async () => {
    const { env, db, puts, objects } = routeEnv();
    const bytes = UTF8.encode("first upload");
    const response = await worker.fetch(
      request("/v1/attachments", {
        method: "POST",
        headers: authed({ "content-type": "text/plain" }),
        body: bytes,
      }),
      env,
      {} as never,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const expectedHash = sha256Node(bytes);
    expect(body).toMatchObject({
      content_sha256: expectedHash,
      byte_size: bytes.byteLength,
      content_type: "text/plain",
      filename: null,
      target_type: null,
      target_id: null,
      deduplicated: false,
    });
    expect(typeof body.created_at).toBe("number");

    expect(puts).toEqual([attachmentObjectKey(TOKEN_WORKSPACE, expectedHash)]);
    expect(objects.get(attachmentObjectKey(TOKEN_WORKSPACE, expectedHash))?.bytes).toEqual(bytes);

    const rows = attachmentRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: TOKEN_WORKSPACE,
      content_sha256: expectedHash,
      byte_size: bytes.byteLength,
      content_type: "text/plain",
    });

    const events = eventRows(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspace_id: TOKEN_WORKSPACE,
      provider: "attachments",
      kind: "attachment.recorded",
      provenance: "OBSERVED",
      content_hash: `sha256:${expectedHash}`,
    });
    const raw = JSON.parse(events[0].raw_json as string) as Record<string, unknown>;
    expect(raw.payload).toEqual({
      content_sha256: expectedHash,
      byte_size: bytes.byteLength,
      content_type: "text/plain",
    });
  });

  it("computes content_sha256 correctly for binary-looking content", async () => {
    const bytes = new Uint8Array(2048);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 91 + 3) % 256;
    const { env } = routeEnv();
    const response = await worker.fetch(
      request("/v1/attachments", {
        method: "POST",
        headers: authed({ "content-type": "application/pdf" }),
        body: bytes,
      }),
      env,
      {} as never,
    );
    const body = (await response.json()) as { content_sha256: string };
    expect(body.content_sha256).toBe(sha256Node(bytes));
  });

  it("rejects a content-type outside the allowlist with 415 before writing anything", async () => {
    const { env, puts, db } = routeEnv();
    const response = await worker.fetch(
      request("/v1/attachments", {
        method: "POST",
        headers: authed({ "content-type": "application/octet-stream" }),
        body: UTF8.encode("nope"),
      }),
      env,
      {} as never,
    );
    expect(response.status).toBe(415);
    expect(puts).toEqual([]);
    expect(attachmentRows(db)).toEqual([]);
    expect(eventRows(db)).toEqual([]);
  });

  it("accepts every allowlisted media type", async () => {
    for (const contentType of ATTACHMENT_CONTENT_TYPES) {
      const { env } = routeEnv();
      const response = await worker.fetch(
        request("/v1/attachments", {
          method: "POST",
          headers: authed({ "content-type": `${contentType}; charset=utf-8` }),
          body: UTF8.encode(`payload for ${contentType}`),
        }),
        env,
        {} as never,
      );
      expect(response.status, contentType).toBe(200);
      const body = (await response.json()) as { content_type: string };
      // The charset parameter is stripped; only the media type is stored.
      expect(body.content_type).toBe(contentType);
    }
  });

  it("rejects a body over the 8 MiB cap mid-stream, with no R2 put", async () => {
    let pulls = 0;
    const chunkBytes = 1_048_576; // 1 MiB
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= 20) {
          controller.close();
          return;
        }
        pulls++;
        controller.enqueue(new Uint8Array(chunkBytes).fill(9));
      },
    });
    const { env, puts, db } = routeEnv();
    const response = await worker.fetch(
      request("/v1/attachments", {
        method: "POST",
        headers: authed({ "content-type": "image/png" }),
        body: stream,
        duplex: "half",
      }),
      env,
      {} as never,
    );
    expect(response.status).toBe(413);
    expect(puts).toEqual([]);
    expect(attachmentRows(db)).toEqual([]);
    expect(eventRows(db)).toEqual([]);
    // The stream offered up to 20 MiB; proving the reader stopped well short
    // of that is what shows the abort was genuinely early rather than a full
    // drain followed by a size check. (The exact pull count past the 8-chunk
    // boundary is one implementation-internal readahead chunk once the
    // stream has passed through Request's own body plumbing — see the
    // unit-level "enforces a small cap across chunk boundaries" test above
    // for an exact boundary count against readAttachmentBody directly.)
    expect(pulls).toBeLessThan(20);
    expect(pulls).toBeLessThanOrEqual(11);
  }, 20_000);

  it("dedupes an identical re-upload: exactly one R2 put, second call flagged", async () => {
    const { env, puts, db } = routeEnv();
    const bytes = UTF8.encode("same bytes twice");
    const headers = authed({ "content-type": "text/plain" });

    const first = await worker.fetch(
      request("/v1/attachments?filename=first.txt", { method: "POST", headers, body: bytes }),
      env,
      {} as never,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.deduplicated).toBe(false);

    const second = await worker.fetch(
      // Different filename AND a different (but validly-shaped) target this
      // time: neither must leak into the response, because neither was
      // actually written — the row's identity already existed.
      request(
        `/v1/attachments?filename=second.txt&target_type=trace&target_id=${TRACE_ID}`,
        { method: "POST", headers, body: bytes },
      ),
      env,
      {} as never,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.content_sha256).toBe(firstBody.content_sha256);
    expect(secondBody.created_at).toBe(firstBody.created_at);
    // The FIRST upload's associations win, not the second call's.
    expect(secondBody.filename).toBe("first.txt");
    expect(secondBody.target_type).toBeNull();
    expect(secondBody.target_id).toBeNull();

    expect(puts).toHaveLength(1);
    expect(attachmentRows(db)).toHaveLength(1);
    // The event append is idempotent too: still exactly one row.
    expect(eventRows(db)).toHaveLength(1);
  });

  it("stores and returns a validated target_type/target_id association", async () => {
    const { env, db } = routeEnv();
    const bytes = UTF8.encode("targeted upload");
    const response = await worker.fetch(
      request(`/v1/attachments?target_type=workstream&target_id=${WORKSTREAM_ID}`, {
        method: "POST",
        headers: authed({ "content-type": "text/plain" }),
        body: bytes,
      }),
      env,
      {} as never,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.target_type).toBe("workstream");
    expect(body.target_id).toBe(WORKSTREAM_ID);

    // A workstream target is threaded onto the spine row's own workstream_id
    // column too, so ordinary workstream-scoped event reads see it.
    const events = eventRows(db);
    expect(events[0].workstream_id).toBe(WORKSTREAM_ID);
  });

  it("rejects target_type/target_id that are not a valid pair, without writing anything", async () => {
    const { env, puts } = routeEnv();
    const response = await worker.fetch(
      request(`/v1/attachments?target_type=trace&target_id=${WORKSTREAM_ID}`, {
        method: "POST",
        headers: authed({ "content-type": "text/plain" }),
        body: UTF8.encode("x"),
      }),
      env,
      {} as never,
    );
    expect(response.status).toBe(400);
    expect(puts).toEqual([]);
  });

  it("rejects a filename that is empty or carries header-injection characters", async () => {
    const { env } = routeEnv();
    for (const filename of ["", 'bad"name']) {
      const response = await worker.fetch(
        request(`/v1/attachments?filename=${encodeURIComponent(filename)}`, {
          method: "POST",
          headers: authed({ "content-type": "text/plain" }),
          body: UTF8.encode("x"),
        }),
        env,
        {} as never,
      );
      expect(response.status, JSON.stringify(filename)).toBe(400);
    }
  });

  it("rejects an unauthenticated caller and a caller without the ingest capability", async () => {
    const { env: anon } = routeEnv();
    const unauthenticated = await worker.fetch(
      request("/v1/attachments", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: UTF8.encode("x"),
      }),
      anon,
      {} as never,
    );
    expect(unauthenticated.status).toBe(401);

    const { env: readOnlyEnv } = routeEnv();
    const forbidden = await worker.fetch(
      request("/v1/attachments", {
        method: "POST",
        headers: {
          authorization: `Bearer ${READ_ONLY_TOKEN}`,
          "content-type": "text/plain",
        },
        body: UTF8.encode("x"),
      }),
      readOnlyEnv,
      {} as never,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });

  it("answers 503 when object storage is not configured", async () => {
    const { env } = routeEnv({ noBucket: true });
    const response = await worker.fetch(
      request("/v1/attachments", {
        method: "POST",
        headers: authed({ "content-type": "text/plain" }),
        body: UTF8.encode("x"),
      }),
      env,
      {} as never,
    );
    expect(response.status).toBe(503);
  });
});

// ================================================================================
// GET /v1/attachments
// ================================================================================

describe("GET /v1/attachments", () => {
  it("returns the envelope with a cursor when another page exists, and none on the last page", async () => {
    const { env, db } = routeEnv();
    for (let i = 0; i < 3; i++) {
      insertAttachment(db, { content_sha256: String(i).repeat(64).slice(0, 64), created_at: 1_000 + i });
    }
    const firstPage = await worker.fetch(
      request("/v1/attachments?limit=2", { headers: authed() }),
      env,
      {} as never,
    );
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as { items: unknown[]; next_cursor: string | null };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();

    const secondPage = await worker.fetch(
      request(`/v1/attachments?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`, {
        headers: authed(),
      }),
      env,
      {} as never,
    );
    const secondBody = (await secondPage.json()) as { items: unknown[]; next_cursor: string | null };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.next_cursor).toBeNull();
  });

  it("filters by target_type and target_id together", async () => {
    const { env, db } = routeEnv();
    insertAttachment(db, {
      content_sha256: "1".repeat(64),
      target_type: "trace",
      target_id: TRACE_ID,
    });
    insertAttachment(db, {
      content_sha256: "2".repeat(64),
      target_type: "span",
      target_id: SPAN_ID,
    });
    insertAttachment(db, { content_sha256: "3".repeat(64) });

    const response = await worker.fetch(
      request(`/v1/attachments?target_type=trace&target_id=${TRACE_ID}`, { headers: authed() }),
      env,
      {} as never,
    );
    const body = (await response.json()) as { items: Array<{ content_sha256: string }> };
    expect(body.items.map((item) => item.content_sha256)).toEqual(["1".repeat(64)]);
  });

  it("never returns another workspace's attachments", async () => {
    const { env, db } = routeEnv();
    insertAttachment(db, { workspace_id: OTHER_WORKSPACE, content_sha256: "f".repeat(64) });
    insertAttachment(db, { workspace_id: TOKEN_WORKSPACE, content_sha256: "e".repeat(64) });

    const response = await worker.fetch(request("/v1/attachments", { headers: authed() }), env, {} as never);
    const body = (await response.json()) as { items: Array<{ content_sha256: string }> };
    expect(body.items.map((item) => item.content_sha256)).toEqual(["e".repeat(64)]);
  });

  it("rejects an unauthenticated caller and a caller without the read capability", async () => {
    const { env } = routeEnv();
    const unauthenticated = await worker.fetch(request("/v1/attachments"), env, {} as never);
    expect(unauthenticated.status).toBe(401);

    const forbidden = await worker.fetch(
      request("/v1/attachments", { headers: { authorization: `Bearer ${INGEST_ONLY_TOKEN}` } }),
      env,
      {} as never,
    );
    expect(forbidden.status).toBe(403);
  });
});

// ================================================================================
// GET /v1/attachments/{sha256}
// ================================================================================

describe("GET /v1/attachments/{sha256}", () => {
  it("streams the stored bytes with the stored content-type and a filename-derived disposition", async () => {
    const { env, db, objects } = routeEnv({ stream: true });
    const hash = "1".repeat(64);
    const bytes = UTF8.encode("download me");
    objects.set(attachmentObjectKey(TOKEN_WORKSPACE, hash), { bytes });
    insertAttachment(db, {
      content_sha256: hash,
      byte_size: bytes.byteLength,
      content_type: "text/plain",
      filename: "notes.txt",
    });

    const response = await worker.fetch(
      request(`/v1/attachments/${hash}`, { headers: authed() }),
      env,
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="notes.txt"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("falls back to the sha256 as the filename, and to arrayBuffer() when the object has no stream", async () => {
    const { env, db, objects } = routeEnv({ stream: false });
    const hash = "2".repeat(64);
    const bytes = UTF8.encode("no filename here");
    objects.set(attachmentObjectKey(TOKEN_WORKSPACE, hash), { bytes });
    insertAttachment(db, { content_sha256: hash, byte_size: bytes.byteLength });

    const response = await worker.fetch(
      request(`/v1/attachments/${hash}`, { headers: authed() }),
      env,
      {} as never,
    );
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${hash}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("answers 410 when the D1 row exists but the R2 object is missing", async () => {
    const { env, db } = routeEnv();
    const hash = "3".repeat(64);
    insertAttachment(db, { content_sha256: hash });
    // Deliberately never put anything into the bucket for this key.

    const response = await worker.fetch(
      request(`/v1/attachments/${hash}`, { headers: authed() }),
      env,
      {} as never,
    );
    expect(response.status).toBe(410);
    const body = (await response.json()) as { note: string };
    expect(body.note).toMatch(/missing/);
  });

  it("answers 404 for a hash that was never recorded", async () => {
    const { env } = routeEnv();
    const response = await worker.fetch(
      request(`/v1/attachments/${"4".repeat(64)}`, { headers: authed() }),
      env,
      {} as never,
    );
    expect(response.status).toBe(404);
  });

  it("answers 404 for a foreign-workspace attachment before reading any object", async () => {
    const { env, db, objects } = routeEnv();
    const hash = "5".repeat(64);
    const secret = UTF8.encode("belongs to the other workspace");
    objects.set(attachmentObjectKey(OTHER_WORKSPACE, hash), { bytes: secret });
    insertAttachment(db, { workspace_id: OTHER_WORKSPACE, content_sha256: hash });

    const response = await worker.fetch(
      request(`/v1/attachments/${hash}`, { headers: authed() }),
      env,
      {} as never,
    );
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain("belongs to");
  });

  it("falls through to the router's generic 404 for a malformed hash", async () => {
    const { env } = routeEnv();
    const response = await worker.fetch(
      request("/v1/attachments/not-a-valid-hash", { headers: authed() }),
      env,
      {} as never,
    );
    expect(response.status).toBe(404);
  });

  it("requires the read capability", async () => {
    const { env, db } = routeEnv();
    const hash = "6".repeat(64);
    insertAttachment(db, { content_sha256: hash });
    const response = await worker.fetch(
      request(`/v1/attachments/${hash}`, {
        headers: { authorization: `Bearer ${INGEST_ONLY_TOKEN}` },
      }),
      env,
      {} as never,
    );
    expect(response.status).toBe(403);
  });
});

// ================================================================================
// routing
// ================================================================================

describe("attachments routing", () => {
  it("answers 404 for a wrong method on a known path", async () => {
    const { env } = routeEnv();
    const onCollection = await worker.fetch(
      request("/v1/attachments", { method: "PUT" }),
      env,
      {} as never,
    );
    expect(onCollection.status).toBe(404);

    const onItem = await worker.fetch(
      request(`/v1/attachments/${"7".repeat(64)}`, { method: "DELETE" }),
      env,
      {} as never,
    );
    expect(onItem.status).toBe(404);
  });

  it("leaves unrelated paths to the rest of the router", async () => {
    const { env } = routeEnv();
    const response = await handleAttachmentsRoute(request("/v1/workstreams"), env);
    expect(response).toBeNull();
  });
});

// ================================================================================
// migration 0017: CHECK constraints + triggers (node:sqlite)
// ================================================================================

describe("0017 attachments migration (node:sqlite)", () => {
  it("creates the attachments table with its indexes and guards", () => {
    const db = migratedDatabase();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toContain("attachments");

    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(triggers).toContain("attachments_reject_update");
    expect(triggers).toContain("attachments_reject_delete");
    db.close();
  });

  it("rejects a malformed workspace_id, content_sha256, or content_type", () => {
    const db = migratedDatabase();
    const insert = db.prepare(`
      INSERT INTO attachments (workspace_id, content_sha256, byte_size, content_type, created_at)
      VALUES (?, ?, 1, 'text/plain', 100)
    `);
    expect(() => insert.run("not-a-workspace-id", "a".repeat(64))).toThrow(/CHECK/i);
    expect(() => insert.run(TOKEN_WORKSPACE, "not-hex")).toThrow(/CHECK/i);
    expect(() => insert.run(TOKEN_WORKSPACE, "A".repeat(64))).toThrow(/CHECK/i); // uppercase hex rejected
    expect(() =>
      db
        .prepare(`
          INSERT INTO attachments (workspace_id, content_sha256, byte_size, content_type, created_at)
          VALUES (?, ?, 1, 'application/octet-stream', 100)
        `)
        .run(TOKEN_WORKSPACE, "b".repeat(64)),
    ).toThrow(/CHECK/i);
    insert.run(TOKEN_WORKSPACE, "c".repeat(64));
    db.close();
  });

  it("requires target_type and target_id together, and pins target_id's shape to target_type", () => {
    const db = migratedDatabase();
    const insertWithTarget = db.prepare(`
      INSERT INTO attachments
        (workspace_id, content_sha256, byte_size, content_type, target_type, target_id, created_at)
      VALUES (?, ?, 1, 'text/plain', ?, ?, 100)
    `);
    // target_type without target_id, and vice versa.
    expect(() => insertWithTarget.run(TOKEN_WORKSPACE, "1".repeat(64), "trace", null)).toThrow(/CHECK/i);
    expect(() => insertWithTarget.run(TOKEN_WORKSPACE, "2".repeat(64), null, TRACE_ID)).toThrow(/CHECK/i);
    // Wrong prefix for the declared type.
    expect(() =>
      insertWithTarget.run(TOKEN_WORKSPACE, "3".repeat(64), "trace", WORKSTREAM_ID),
    ).toThrow(/CHECK/i);
    // Unknown target_type.
    expect(() =>
      insertWithTarget.run(TOKEN_WORKSPACE, "4".repeat(64), "commit", "commit_x"),
    ).toThrow(/CHECK/i);
    // Every valid pairing succeeds.
    insertWithTarget.run(TOKEN_WORKSPACE, "5".repeat(64), "trace", TRACE_ID);
    insertWithTarget.run(TOKEN_WORKSPACE, "6".repeat(64), "span", SPAN_ID);
    insertWithTarget.run(TOKEN_WORKSPACE, "7".repeat(64), "session", SESSION_ID);
    insertWithTarget.run(TOKEN_WORKSPACE, "8".repeat(64), "workstream", WORKSTREAM_ID);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n,
    ).toBe(4);
    db.close();
  });

  it("keeps rows immutable and undeletable", () => {
    const db = migratedDatabase();
    insertAttachment(db, { content_sha256: "9".repeat(64) });
    expect(() =>
      db.prepare("UPDATE attachments SET byte_size = 999").run(),
    ).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM attachments").run()).toThrow(/never deleted/);
    db.close();
  });

  it("dedupes (workspace_id, content_sha256) as a hard PRIMARY KEY", () => {
    const db = migratedDatabase();
    insertAttachment(db, { content_sha256: "a".repeat(64), byte_size: 1 });
    // Same workspace + hash again: the PK rejects a genuine duplicate INSERT
    // outright — the application layer is what turns this into a graceful
    // "deduplicated: true" response via INSERT OR IGNORE.
    expect(() => insertAttachment(db, { content_sha256: "a".repeat(64), byte_size: 2 })).toThrow(
      /UNIQUE|PRIMARY KEY/i,
    );
    // The same hash under a DIFFERENT workspace is a distinct row.
    insertAttachment(db, { workspace_id: OTHER_WORKSPACE, content_sha256: "a".repeat(64) });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n,
    ).toBe(2);
    db.close();
  });

  it("allows filename to be absent but rejects an empty or oversized one", () => {
    const db = migratedDatabase();
    const insert = db.prepare(`
      INSERT INTO attachments (workspace_id, content_sha256, byte_size, content_type, filename, created_at)
      VALUES (?, ?, 1, 'text/plain', ?, 100)
    `);
    insert.run(TOKEN_WORKSPACE, "b".repeat(64), null);
    insert.run(TOKEN_WORKSPACE, "c".repeat(64), "a".repeat(255));
    expect(() => insert.run(TOKEN_WORKSPACE, "d".repeat(64), "")).toThrow(/CHECK/i);
    expect(() => insert.run(TOKEN_WORKSPACE, "e".repeat(64), "a".repeat(256))).toThrow(/CHECK/i);
    db.close();
  });

  it("makes the event spine append-only in the presence of this migration too", () => {
    const db = migratedDatabase();
    db.prepare(`
      INSERT INTO events
        (workspace_id, event_id, occurred_at, kind, ingested_at, raw_json)
      VALUES (?, 'evt_test', '2026-08-28T00:00:00Z', 'attachment.recorded', 100, '{}')
    `).run(TOKEN_WORKSPACE);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE events SET kind = 'x'").run()).toThrow(/append-only/);
    db.close();
  });
});

// -- canonical encoding sanity check ---------------------------------------------

describe("attachment.recorded raw_json", () => {
  it("is exactly canonicalJsonStringify of the built event", async () => {
    const event = buildAttachmentEvent({
      eventId: "evt_canon",
      contentSha256: "d".repeat(64),
      byteSize: 5,
      contentType: "image/gif",
      targetType: "session",
      targetId: SESSION_ID,
      occurredAtISO: "2026-08-28T00:00:00.000Z",
    });
    const encoded = canonicalJsonStringify(event);
    expect(JSON.parse(encoded)).toEqual(event);
    // Canonical: keys sorted, no whitespace.
    expect(encoded.startsWith('{"content_hash"')).toBe(true);
  });
});
