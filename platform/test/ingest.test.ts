// Unit tests for src/ingest.ts (pure logic) and src/index.ts (handlers with
// a mocked D1 seam — plain objects, no workerd required).

import { beforeAll, describe, expect, it } from "vitest";
import worker, {
  type D1BoundStatement,
  type D1DatabaseLike,
  type D1Statement,
} from "./advanced_worker";
import {
  BATCH_SCHEMA_VERSION,
  DEFAULT_PAGE_LIMIT,
  EVENT_SCHEMA_VERSION,
  MAX_BODY_BYTES,
  MAX_CONTENT_HASH_BYTES,
  MAX_EVENTS_PER_BATCH,
  MAX_KIND_BYTES,
  MAX_NATIVE_SESSION_ID_BYTES,
  MAX_PAGE_LIMIT,
  MAX_PROVIDER_BYTES,
  MAX_PROVENANCE_BYTES,
  MAX_REDACTION_FIELD_BYTES,
  MAX_REDACTION_FIELDS,
  MAX_TIMESTAMP_BYTES,
  MAX_WORKSTREAM_TITLE_BYTES,
  REDACTION_VERSION,
  buildEventRows,
  buildReceipt,
  buildWorkstreamListResponse,
  buildWorkstreamProjectionRows,
  canonicalJsonStringify,
  decodeCursor,
  encodeCursor,
  exceedsMaxBodyBytes,
  parsePagination,
  scopeDenial,
  validateEventBatch,
  type EventBatchEnvelope,
  type WorkstreamRow,
} from "../src/ingest";
import { sha256Hex } from "../src/auth";

// -- fixtures -----------------------------------------------------------------

const WSP_ULID = "01HTSTW0RKSPACE0000000000Z"; // 26 chars, Crockford base32
const TOKEN_WORKSPACE = `wsp_${WSP_ULID}`;
const OTHER_WORKSPACE = `wsp_01HTSTW0RKSPEER0000000000Z`;
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;

/** Real SHA-256 of the test token; the mock registry returns it as token_hash. */
let TOKEN_HASH = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
});

/** Unique, schema-valid evt_<ulid> per index. */
function eventId(i: number): string {
  const head = `01HTEST${String(i).padStart(4, "0")}`; // 11 chars
  const tail = `${"0".repeat(26 - head.length - 1)}Z`;
  return `evt_${head}${tail}`;
}

function workstreamId(i: number): string {
  const head = `01HTESTWS${String(i).padStart(6, "0")}`; // 15 chars
  const tail = `${"0".repeat(26 - head.length - 1)}Z`;
  return `ws_${head}${tail}`;
}

function sessionId(i: number): string {
  return `ses_${workstreamId(i).slice(3)}`;
}

function repositoryId(i: number): string {
  return `repo_${workstreamId(i).slice(3)}`;
}

function event(overrides: Record<string, unknown> = {}, i = 0): Record<string, unknown> {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: eventId(i),
    kind: "command.completed",
    occurred_at: "2026-08-21T10:00:00Z",
    observed_at: "2026-08-21T10:00:01Z",
    workstream_id: workstreamId(0),
    session_id: sessionId(0),
    provider: "codex",
    provenance: "OBSERVED",
    payload: { exit_code: 1 },
    redaction: { version: REDACTION_VERSION, status: "clean" },
    ...overrides,
  };
}

function envelope(
  overrides: Record<string, unknown> = {},
  events: Record<string, unknown>[] = [event()],
): Record<string, unknown> {
  return { schema_version: BATCH_SCHEMA_VERSION, events, ...overrides };
}

function workstreamRow(i: number, overrides: Partial<WorkstreamRow> = {}): WorkstreamRow {
  return {
    id: workstreamId(i),
    workspace_id: TOKEN_WORKSPACE,
    title: `workstream ${i}`,
    status: "active",
    repository_id: null,
    created_at: 1_700_000_000 + i,
    updated_at: 1_700_000_000 + i,
    ...overrides,
  };
}

// -- pure logic: constants and limits ------------------------------------------

describe("limits", () => {
  it("pins the documented limits", () => {
    expect(MAX_EVENTS_PER_BATCH).toBe(500);
    expect(MAX_BODY_BYTES).toBe(1_048_576);
    expect(MAX_KIND_BYTES).toBe(64);
    expect(MAX_PROVIDER_BYTES).toBe(64);
    expect(MAX_NATIVE_SESSION_ID_BYTES).toBe(256);
    expect(MAX_PROVENANCE_BYTES).toBe(8);
    expect(MAX_CONTENT_HASH_BYTES).toBe(71);
    expect(REDACTION_VERSION).toBe(1);
    expect(MAX_REDACTION_FIELDS).toBe(256);
    expect(MAX_REDACTION_FIELD_BYTES).toBe(256);
    expect(MAX_WORKSTREAM_TITLE_BYTES).toBe(200);
    expect(MAX_TIMESTAMP_BYTES).toBe(35);
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(MAX_PAGE_LIMIT).toBe(100);
  });

  it("classifies body sizes at the boundary", () => {
    expect(exceedsMaxBodyBytes(MAX_BODY_BYTES)).toBe(false);
    expect(exceedsMaxBodyBytes(MAX_BODY_BYTES + 1)).toBe(true);
  });
});

// -- pure logic: envelope validation -------------------------------------------

describe("validateEventBatch", () => {
  it("accepts a valid envelope and derives the workspace from the token", () => {
    const result = validateEventBatch(envelope(), TOKEN_WORKSPACE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events).toHaveLength(1);
  });

  it("rejects non-object envelopes", () => {
    for (const bad of [null, 42, "x", [], true]) {
      expect(validateEventBatch(bad, TOKEN_WORKSPACE)).toEqual({
        ok: false,
        status: 400,
        error: "envelope must be a JSON object",
      });
    }
  });

  it("rejects a wrong batch schema_version", () => {
    const result = validateEventBatch(
      envelope({ schema_version: "hfg.event.v2" }),
      TOKEN_WORKSPACE,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "schema_version must be hfg.event-batch.v1",
    });
  });

  it("accepts a body workspace_id that matches the token binding", () => {
    expect(validateEventBatch(envelope({ workspace_id: TOKEN_WORKSPACE }), TOKEN_WORKSPACE).ok).toBe(true);
  });

  it("treats a foreign body workspace_id as a 404, never 403", () => {
    const result = validateEventBatch(envelope({ workspace_id: OTHER_WORKSPACE }), TOKEN_WORKSPACE);
    expect(result).toEqual({ ok: false, status: 404, error: "not found" });
  });

  it("rejects a non-string workspace_id", () => {
    const result = validateEventBatch(envelope({ workspace_id: 17 }), TOKEN_WORKSPACE);
    expect(result).toEqual({ ok: false, status: 400, error: "workspace_id must be a string" });
  });

  it("rejects missing, empty, or non-array events", () => {
    for (const events of [undefined, null, "x", [], {}]) {
      const result = validateEventBatch(envelope({ events }), TOKEN_WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it("accepts exactly 500 events and rejects 501", () => {
    const full = Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, i) => event({}, i));
    expect(validateEventBatch(envelope({}, full), TOKEN_WORKSPACE).ok).toBe(true);
    const over = [...full, event({}, 500)];
    expect(validateEventBatch(envelope({}, over), TOKEN_WORKSPACE)).toEqual({
      ok: false,
      status: 413,
      error: "batch exceeds 500 events",
    });
  });

  it("validates every event and reports the offending index", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...event(), schema_version: "hfg.event.v2" }, "events[1].schema_version must be hfg.event.v1"],
      [{ ...event({}, 1), event_id: "not-an-id" }, "events[1].event_id must match ^evt_[0-9A-HJKMNP-TV-Z]{26}$"],
      [{ ...event({}, 1), event_id: "evt_01HTEST" }, "events[1].event_id must match ^evt_[0-9A-HJKMNP-TV-Z]{26}$"],
      [{ ...event({}, 1), kind: "" }, "events[1].kind must be a non-empty string"],
      [{ ...event({}, 1), occurred_at: "yesterday" }, "events[1].occurred_at must be an RFC 3339 timestamp"],
      [{ ...event({}, 1), occurred_at: "2026-08-21" }, "events[1].occurred_at must be an RFC 3339 timestamp"],
      [{ ...event({}, 1), occurred_at: "2026-08-21T10:00:00" }, "events[1].occurred_at must be an RFC 3339 timestamp"],
      [{ ...event({}, 1), observed_at: "yesterday" }, "events[1].observed_at must be an RFC 3339 timestamp"],
      [{ ...event({}, 1), observed_at: undefined }, "events[1].observed_at must be an RFC 3339 timestamp"],
      [{ ...event({}, 1), sequence: -1 }, "events[1].sequence must be a non-negative safe integer"],
      [{ ...event({}, 1), sequence: 1.5 }, "events[1].sequence must be a non-negative safe integer"],
      [{ ...event({}, 1), redaction: undefined }, "events[1].redaction must be an object attesting successful client redaction"],
      [{ ...event({}, 1), redaction: "failed" }, "events[1].redaction must be an object attesting successful client redaction"],
      [{ ...event({}, 1), redaction: { version: 1, status: "failed" } }, "events[1].redaction status forbids sync"],
      [{ ...event({}, 1), redaction: { version: 1, status: "REDACTION_FAILED" } }, "events[1].redaction status forbids sync"],
      [{ ...event({}, 1), redaction: { version: 1 } }, "events[1].redaction.status must be clean or redacted"],
      [{ ...event({}, 1), redaction: { version: 1, status: "done" } }, "events[1].redaction.status must be clean or redacted"],
      [{ ...event({}, 1), redaction: { version: 2, status: "clean" } }, "events[1].redaction.version must be 1"],
      [{ ...event({}, 1), redaction: { version: 1, status: "clean", fields_removed: "payload" } }, "events[1].redaction.fields_removed must be an array of at most 256 strings"],
      [{ ...event({}, 1), redaction: { version: 1, status: "redacted", fields_removed: [""] } }, "events[1].redaction.fields_removed entries must be non-empty strings of at most 256 UTF-8 bytes"],
    ];
    for (const [badEvent, error] of cases) {
      expect(validateEventBatch(envelope({}, [event(), badEvent]), TOKEN_WORKSPACE)).toEqual({
        ok: false,
        status: 400,
        error,
      });
    }
  });

  it("requires exact prefixed ULIDs for every optional durable id", () => {
    expect(validateEventBatch(envelope({}, [event({
      workstream_id: workstreamId(1),
      session_id: sessionId(1),
      repository_id: repositoryId(1),
    })]), TOKEN_WORKSPACE).ok).toBe(true);

    const malformed: Array<[string, unknown]> = [
      ["workstream_id", sessionId(1)],
      ["workstream_id", `ws_${"A".repeat(26)}`], // ULID timestamp overflow
      ["session_id", `ses_${"0".repeat(25)}i`], // lowercase + forbidden Crockford character
      ["repository_id", "repo_alpha"],
      ["repository_id", null],
    ];
    for (const [field, value] of malformed) {
      const result = validateEventBatch(envelope({}, [event({ [field]: value })]), TOKEN_WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`events[0].${field} must match`);
    }
  });

  it("rejects 250 KiB durable ids before they can reach indexed columns", () => {
    const huge = "0".repeat(250 * 1024);
    for (const field of ["workstream_id", "session_id", "repository_id"] as const) {
      const result = validateEventBatch(envelope({}, [event({ [field]: huge })]), TOKEN_WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`events[0].${field} must match`);
    }
  });

  it("measures indexed string caps in UTF-8 bytes, not JavaScript characters", () => {
    const boundary = event({
      kind: "é".repeat(MAX_KIND_BYTES / 2),
      provider: "é".repeat(MAX_PROVIDER_BYTES / 2),
      native_session_id: "🙂".repeat(MAX_NATIVE_SESSION_ID_BYTES / 4),
    });
    expect(validateEventBatch(envelope({}, [boundary]), TOKEN_WORKSPACE).ok).toBe(true);

    const over: Array<[string, string]> = [
      ["kind", `${"é".repeat(MAX_KIND_BYTES / 2)}a`],
      ["provider", `${"é".repeat(MAX_PROVIDER_BYTES / 2)}a`],
      ["native_session_id", `${"🙂".repeat(MAX_NATIVE_SESSION_ID_BYTES / 4)}a`],
    ];
    for (const [field, value] of over) {
      const result = validateEventBatch(envelope({}, [event({ [field]: value })]), TOKEN_WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`events[0].${field} must be at most`);
    }
  });

  it("accepts only the three honest provenance labels", () => {
    for (const provenance of ["OBSERVED", "DECLARED", "INFERRED"]) {
      expect(validateEventBatch(envelope({}, [event({ provenance })]), TOKEN_WORKSPACE).ok).toBe(true);
    }
    for (const provenance of ["observed", "ESTIMATED", "", null, "X".repeat(250 * 1024)]) {
      const result = validateEventBatch(envelope({}, [event({ provenance })]), TOKEN_WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          "events[0].provenance must be one of OBSERVED, DECLARED, INFERRED",
        );
      }
    }
  });

  it("accepts only canonical lowercase SHA-256 content hashes", () => {
    const valid = `sha256:${"a".repeat(64)}`;
    expect(validateEventBatch(envelope({}, [event({ content_hash: valid })]), TOKEN_WORKSPACE).ok).toBe(true);
    for (const content_hash of [
      `sha256:${"a".repeat(63)}`,
      `sha256:${"A".repeat(64)}`,
      `sha512:${"a".repeat(64)}`,
      "a".repeat(250 * 1024),
      null,
    ]) {
      const result = validateEventBatch(envelope({}, [event({ content_hash })]), TOKEN_WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("events[0].content_hash must match");
    }
  });

  it("caps projected workstream titles at 200 UTF-8 bytes", () => {
    const boundaryTitle = "🙂".repeat(MAX_WORKSTREAM_TITLE_BYTES / 4);
    expect(validateEventBatch(envelope({}, [event({
      kind: "workstream.started",
      payload: { title: boundaryTitle },
    })]), TOKEN_WORKSPACE).ok).toBe(true);

    for (const title of [
      `${boundaryTitle}a`,
      "x".repeat(250 * 1024),
    ]) {
      const result = validateEventBatch(envelope({}, [event({
        kind: "workstream.started",
        payload: { title },
      })]), TOKEN_WORKSPACE);
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: `events[0].payload.title must be at most ${MAX_WORKSTREAM_TITLE_BYTES} UTF-8 bytes`,
      });
    }
    expect(validateEventBatch(envelope({}, [event({
      kind: "workstream.started",
      payload: { title: 17 },
    })]), TOKEN_WORKSPACE)).toEqual({
      ok: false,
      status: 400,
      error: "events[0].payload.title must be a string",
    });
  });

  it("keeps timestamps compatible with Go RFC3339Nano output", () => {
    expect(validateEventBatch(envelope({}, [event({
      occurred_at: "2026-08-21T10:00:00.123456789+05:30",
      observed_at: "2026-08-21T10:00:00.123456789-04:00",
    })]), TOKEN_WORKSPACE).ok).toBe(true);
    const result = validateEventBatch(envelope({}, [event({
      occurred_at: "2026-08-21T10:00:00.1234567890Z",
    })]), TOKEN_WORKSPACE);
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "events[0].occurred_at must be an RFC 3339 timestamp",
    });
  });

  it("rejects non-object events", () => {
    const result = validateEventBatch(envelope({}, ["nope" as unknown as Record<string, unknown>]), TOKEN_WORKSPACE);
    expect(result).toEqual({ ok: false, status: 400, error: "events[0] must be an object" });
  });

  it("rejects duplicate event ids within one batch", () => {
    const result = validateEventBatch(envelope({}, [event({}, 0), event({}, 0)]), TOKEN_WORKSPACE);
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "events[1].event_id duplicates an earlier event",
    });
  });

  it("rejects non-finite and precision-losing numbers before canonical hashing", () => {
    for (const numeric of ["1e400", "-1e400", "9007199254740993"]) {
      const parsed = JSON.parse(
        JSON.stringify(envelope()).replace(
          '"payload":{"exit_code":1}',
          `"payload":{"nested":{"numeric":${numeric}}}`,
        ),
      );
      const result = validateEventBatch(parsed, TOKEN_WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toMatch(/numbers must be finite|safe integer range/);
      }
    }
  });

  it("bounds JSON nesting before recursive canonical encoding", () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 70; depth++) nested = { child: nested };
    const result = validateEventBatch(envelope({ nested }), TOKEN_WORKSPACE);
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "JSON nesting exceeds 64 levels",
    });
  });
});

// -- pure logic: canonical JSON --------------------------------------------------

describe("canonicalJsonStringify", () => {
  it("sorts object keys at every level", () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order (order is data)", () => {
    expect(canonicalJsonStringify({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it("drops undefined values", () => {
    expect(canonicalJsonStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("is stable across key insertion orders", () => {
    const a = canonicalJsonStringify({ x: 1, y: { z: 2, w: 3 } });
    const b = canonicalJsonStringify({ y: { w: 3, z: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  it("round-trips unknown envelope fields", () => {
    const value = envelope({ "x-future-field": { b: 1, a: 2 } });
    expect(JSON.parse(canonicalJsonStringify(value))["x-future-field"]).toEqual({ a: 2, b: 1 });
  });
});

// -- pure logic: receipts ---------------------------------------------------------

describe("buildReceipt", () => {
  it("derives a stable, schema-shaped receipt", async () => {
    const first = await buildReceipt("key-1", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const second = await buildReceipt("key-1", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    expect(first).toEqual(second);
    expect(first.batch_id).toMatch(/^batch_[0-9a-f]{32}$/);
    expect(first).toEqual({
      accepted: 1,
      batch_id: first.batch_id,
      schema_version: "hfg.event-batch.receipt.v1",
      workspace_id: TOKEN_WORKSPACE,
    });
  });

  it("differs when the key, workspace, or event ids differ", async () => {
    const base = await buildReceipt("key-1", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const otherKey = await buildReceipt("key-2", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const otherWorkspace = await buildReceipt("key-1", OTHER_WORKSPACE, envelope() as EventBatchEnvelope);
    const otherEvents = await buildReceipt(
      "key-1",
      TOKEN_WORKSPACE,
      envelope({}, [event({}, 9)]) as EventBatchEnvelope,
    );
    const ids = new Set([base.batch_id, otherKey.batch_id, otherWorkspace.batch_id, otherEvents.batch_id]);
    expect(ids.size).toBe(4);
  });
});

// -- pure logic: event rows ---------------------------------------------------------

describe("buildEventRows", () => {
  it("stamps the token workspace and idempotency key on every row", () => {
    const value = envelope(
      { workspace_id: OTHER_WORKSPACE }, // body value is ignored by the row builder
      [event({}, 0), event({}, 1)],
    ) as EventBatchEnvelope;
    const rows = buildEventRows(value, TOKEN_WORKSPACE, "key-1", 1_700_000_100);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.workspace_id).toBe(TOKEN_WORKSPACE);
      expect(row.idempotency_key).toBe("key-1");
      expect(row.ingested_at).toBe(1_700_000_100);
      expect(row.kind).toBe("command.completed");
      expect(row.provenance).toBe("OBSERVED");
    }
  });

  it("nulls absent optional fields and preserves raw payloads canonically", () => {
    const minimal = envelope({}, [
      {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: eventId(0),
        kind: "log.observed",
        occurred_at: "2026-08-21T11:00:00Z",
        observed_at: "2026-08-21T11:00:01Z",
        "x-extra": true,
      },
    ]) as EventBatchEnvelope;
    const [row] = buildEventRows(minimal, TOKEN_WORKSPACE, "k", 1);
    expect(row.workstream_id).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.native_session_id).toBeNull();
    expect(row.provider).toBeNull();
    expect(row.content_hash).toBeNull();
    expect(row.occurred_at).toBe("2026-08-21T11:00:00Z");
    // raw_json is canonical: sorted keys, unknown fields kept.
    const raw = JSON.parse(row.raw_json);
    expect(raw["x-extra"]).toBe(true);
    expect(row.raw_json.indexOf('"kind"')).toBeLessThan(row.raw_json.indexOf('"occurred_at"'));
  });
});

// -- pure logic: workstream projection ----------------------------------------------

describe("buildWorkstreamProjectionRows", () => {
  it("derives bounded rows only for events carrying a workstream id", () => {
    const value = envelope({}, [
      event({
        kind: "workstream.started",
        occurred_at: "2026-08-21T10:00:00.250Z",
        repository_id: repositoryId(0),
        payload: { title: "Fix checkout race" },
      }, 0),
      event({ workstream_id: undefined }, 1),
    ]) as EventBatchEnvelope;

    expect(buildWorkstreamProjectionRows(value, TOKEN_WORKSPACE)).toEqual([{
      id: workstreamId(0),
      workspace_id: TOKEN_WORKSPACE,
      repository_id: repositoryId(0),
      title: "Fix checkout race",
      status: "active",
      created_at: 1_787_306_400,
      updated_at: 1_787_306_400,
      title_event_at_ms: 1_787_306_400_250,
      title_event_id: eventId(0),
      status_event_at_ms: 1_787_306_400_250,
      status_event_id: eventId(0),
      source_event_id: eventId(0),
    }]);
  });

  it("uses lifecycle coordinates that converge under out-of-order delivery", () => {
    const completed = envelope({}, [event({
      kind: "workstream.completed",
      occurred_at: "2026-08-21T12:00:00Z",
    })]) as EventBatchEnvelope;
    const [row] = buildWorkstreamProjectionRows(completed, TOKEN_WORKSPACE);
    expect(row.title).toBe(workstreamId(0));
    expect(row.title_event_at_ms).toBeNull();
    expect(row.status).toBe("completed");
    expect(row.status_event_at_ms).toBe(Date.parse("2026-08-21T12:00:00Z"));
  });

  it("never emits an oversized fallback title even if called with unvalidated input", () => {
    const huge = "x".repeat(250 * 1024);
    const [row] = buildWorkstreamProjectionRows(
      envelope({}, [event({
        kind: "workstream.started",
        workstream_id: huge,
        payload: { title: huge },
      })]) as EventBatchEnvelope,
      TOKEN_WORKSPACE,
    );
    expect(new TextEncoder().encode(row.title).byteLength).toBeLessThanOrEqual(
      MAX_WORKSTREAM_TITLE_BYTES,
    );
    expect(row.title).toBe("Untitled workstream");
  });
});

// -- pure logic: cursors and pagination ----------------------------------------------

describe("cursors", () => {
  it("round-trips", () => {
    const cursor = { createdAt: 1_700_000_042, id: workstreamId(0) };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    for (const bad of ["", "!!!", "aGVsbG8=", "aGVsbG8=@#"]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("rejects cursors with wrong field types", () => {
    expect(decodeCursor(btoa(JSON.stringify({ created_at: "1", id: workstreamId(0) })))).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ created_at: 1 })))).toBeNull();
  });
});

describe("parsePagination", () => {
  const url = (query: string) => new URL(`https://api.test/v1/workstreams${query}`);

  it("defaults to 50 with no cursor", () => {
    expect(parsePagination(url(""))).toEqual({ ok: true, value: { limit: 50, cursor: null } });
  });

  it("accepts limits from 1 to 100", () => {
    expect(parsePagination(url("?limit=1")).ok).toBe(true);
    const max = parsePagination(url("?limit=100"));
    expect(max.ok && max.value.limit).toBe(100);
  });

  it("rejects out-of-range, fractional, or non-numeric limits", () => {
    for (const bad of ["0", "-1", "101", "1.5", "abc", ""]) {
      expect(parsePagination(url(`?limit=${encodeURIComponent(bad)}`)).ok).toBe(false);
    }
  });

  it("treats an empty cursor as absent", () => {
    expect(parsePagination(url("?cursor="))).toEqual({
      ok: true,
      value: { limit: 50, cursor: null },
    });
  });

  it("accepts a valid cursor and rejects a malformed one", () => {
    const encoded = encodeCursor({ createdAt: 5, id: workstreamId(0) });
    expect(parsePagination(url(`?cursor=${encoded}&limit=10`))).toEqual({
      ok: true,
      value: { limit: 10, cursor: { createdAt: 5, id: workstreamId(0) } },
    });
    expect(parsePagination(url("?cursor=bogus"))).toEqual({
      ok: false,
      status: 400,
      error: "cursor is invalid",
    });
  });
});

// -- pure logic: workstream page shaping ----------------------------------------------

describe("buildWorkstreamListResponse", () => {
  it("sorts rows deterministically (created_at DESC, then id DESC)", () => {
    const rows = [workstreamRow(1), workstreamRow(3), workstreamRow(2)];
    const page = buildWorkstreamListResponse(rows, 50);
    expect(page.workstreams.map((w) => w.id)).toEqual([
      workstreamRow(3).id,
      workstreamRow(2).id,
      workstreamRow(1).id,
    ]);
    expect(page.next_cursor).toBeNull();
  });

  it("breaks ties on id when created_at matches", () => {
    const tie = (id: string): WorkstreamRow => ({
      ...workstreamRow(7),
      id,
      created_at: 1_700_000_999,
    });
    const tieA = `${workstreamId(0).slice(0, -1)}A`;
    const tieZ = `${workstreamId(0).slice(0, -1)}Z`;
    const page = buildWorkstreamListResponse([tieA, tieZ].map((id) => tie(id)), 50);
    expect(page.workstreams.map((w) => w.id)).toEqual([
      `${workstreamId(0).slice(0, -1)}Z`,
      `${workstreamId(0).slice(0, -1)}A`,
    ]);
  });

  it("emits a next_cursor only when the limit+1 prefetch row exists", () => {
    const rows = [workstreamRow(0), workstreamRow(1), workstreamRow(2)];
    const page = buildWorkstreamListResponse(rows, 2);
    expect(page.workstreams.map((w) => w.id)).toEqual([workstreamRow(2).id, workstreamRow(1).id]);
    expect(decodeCursor(page.next_cursor ?? "")).toEqual({
      createdAt: workstreamRow(1).created_at,
      id: workstreamRow(1).id,
    });
  });

  it("returns no next_cursor when the page is exactly full", () => {
    const page = buildWorkstreamListResponse([workstreamRow(0), workstreamRow(1)], 2);
    expect(page.workstreams).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  it("omits internal columns from the summary", () => {
    const [summary] = buildWorkstreamListResponse([workstreamRow(0)], 50).workstreams;
    expect(Object.keys(summary).sort()).toEqual([
      "created_at",
      "id",
      "repository_id",
      "status",
      "title",
      "updated_at",
    ]);
  });
});

// -- pure logic: scope denial rule ------------------------------------------------------

describe("scopeDenial", () => {
  it("answers 404 for foreign resources (never leak existence)", () => {
    expect(
      scopeDenial({ resourceWorkspaceId: OTHER_WORKSPACE, tokenWorkspaceId: TOKEN_WORKSPACE }),
    ).toEqual({ status: 404, error: "not found" });
  });

  it("answers 403 for own-but-forbidden resources", () => {
    expect(
      scopeDenial({
        resourceWorkspaceId: TOKEN_WORKSPACE,
        tokenWorkspaceId: TOKEN_WORKSPACE,
        allowed: false,
      }),
    ).toEqual({ status: 403, error: "forbidden" });
  });

  it("allows own resources and absent resource ids", () => {
    expect(
      scopeDenial({ resourceWorkspaceId: TOKEN_WORKSPACE, tokenWorkspaceId: TOKEN_WORKSPACE, allowed: true }),
    ).toBeNull();
    expect(scopeDenial({ tokenWorkspaceId: TOKEN_WORKSPACE, allowed: true })).toBeNull();
    expect(scopeDenial({ tokenWorkspaceId: TOKEN_WORKSPACE })).toBeNull();
  });
});

// -- handler tests (mocked D1) -----------------------------------------------------------

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (sql: string, binds: unknown[]) => unknown;
  all?: (sql: string, binds: unknown[]) => unknown[] | Promise<unknown[]>;
  batch?: (statements: RecordedStatement[]) => void;
} = {}) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const db: D1DatabaseLike = {
    prepare(sql: string): D1Statement & D1BoundStatement & RecordedStatement {
      const record: D1Statement & D1BoundStatement & RecordedStatement = {
        sql,
        binds: [],
        bind(...values: unknown[]) {
          record.binds = values;
          return record;
        },
        async first<T = unknown>() {
          const result = await handlers.first?.(sql, record.binds);
          return (result ?? null) as T | null;
        },
        async all<T = unknown>() {
          const results = await handlers.all?.(sql, record.binds);
          return { results: (results ?? []) as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      statements.push(record);
      return record;
    },
    async batch(batchStatements: D1BoundStatement[]) {
      const recorded = batchStatements.map((statement) => statement as unknown as RecordedStatement);
      batches.push(recorded);
      handlers.batch?.(recorded);
      return [];
    },
  };
  return { db, statements, batches };
}

const CTX = {} as never; // ExecutionContext stub (unused by handlers)
const TEST_PERIOD_START = Math.floor(Date.now() / 1_000) - 60;
const TEST_PERIOD_END = TEST_PERIOD_START + 30 * 24 * 60 * 60;

function makeEnv(db: D1DatabaseLike): { DB: D1DatabaseLike } {
  return { DB: db };
}

function deviceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEVICE_ID,
    workspace_id: TOKEN_WORKSPACE,
    token_hash: TOKEN_HASH,
    capabilities: "ingest,read",
    revoked_at: null,
    ...overrides,
  };
}

function entitlementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_id: TOKEN_WORKSPACE,
    plan_id: "basic",
    status: "active",
    max_batch_events: 100,
    max_batch_bytes: 262_144,
    max_monthly_events: 5_000,
    max_monthly_bytes: 10_485_760,
    max_lifetime_events: 25_000,
    max_lifetime_bytes: 67_108_864,
    used_monthly_events: 0,
    used_monthly_bytes: 0,
    used_lifetime_events: 0,
    used_lifetime_bytes: 0,
    period_start: TEST_PERIOD_START,
    period_end: TEST_PERIOD_END,
    ...overrides,
  };
}

/** Registry mock: devices resolve for the test token; everything else misses. */
function deviceRegistry(
  overrides: Record<string, unknown> = {},
  entitlementOverrides: Record<string, unknown> = {},
) {
  return async (sql: string): Promise<unknown> => {
    if (sql.includes("FROM devices")) return deviceRow(overrides);
    if (sql.includes("quota:read-policy")) return entitlementRow(entitlementOverrides);
    return null;
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

describe("worker: routing", () => {
  it("answers /healthz without auth", async () => {
    const { db } = mockDb();
    const response = await worker.fetch(request("/healthz"), makeEnv(db), CTX);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-handoffgraph-worker-version")).toBeNull();
    expect(response.headers.get("x-handoffgraph-worker-tag")).toBeNull();
  });

  it("exposes validated Worker version metadata without changing /healthz JSON", async () => {
    const { db } = mockDb();
    const response = await worker.fetch(
      request("/healthz"),
      {
        ...makeEnv(db),
        CF_VERSION_METADATA: {
          id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
          tag: "git-5e5b2009e4de",
          timestamp: "2026-08-31T12:00:00.000Z",
        },
      },
      CTX,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-handoffgraph-worker-version"))
      .toBe("095f00a7-23a7-43b7-a227-e4c97cab5f22");
    expect(response.headers.get("x-handoffgraph-worker-tag")).toBe("git-5e5b2009e4de");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("fails closed on malformed Worker version metadata headers", async () => {
    const { db } = mockDb();
    const invalidIdResponse = await worker.fetch(
      request("/healthz"),
      {
        ...makeEnv(db),
        CF_VERSION_METADATA: {
          id: "not-a-cloudflare-version-id",
          tag: "git-main",
          timestamp: "2026-08-31T12:00:00.000Z",
        },
      },
      CTX,
    );

    expect(invalidIdResponse.status).toBe(200);
    expect(invalidIdResponse.headers.get("x-handoffgraph-worker-version")).toBeNull();
    expect(invalidIdResponse.headers.get("x-handoffgraph-worker-tag")).toBeNull();
    expect(await invalidIdResponse.json()).toEqual({ status: "ok" });

    const invalidTagResponse = await worker.fetch(
      request("/healthz"),
      {
        ...makeEnv(db),
        CF_VERSION_METADATA: {
          id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
          tag: "git-main\r\nx-forged: true",
          timestamp: "2026-08-31T12:00:00.000Z",
        },
      },
      CTX,
    );

    expect(invalidTagResponse.status).toBe(200);
    expect(invalidTagResponse.headers.get("x-handoffgraph-worker-version"))
      .toBe("095f00a7-23a7-43b7-a227-e4c97cab5f22");
    expect(invalidTagResponse.headers.get("x-handoffgraph-worker-tag")).toBeNull();
    expect(invalidTagResponse.headers.get("x-forged")).toBeNull();
    expect(await invalidTagResponse.json()).toEqual({ status: "ok" });
  });

  it("answers 404 for unknown paths and methods", async () => {
    const { db } = mockDb();
    expect((await worker.fetch(request("/nope"), makeEnv(db), CTX)).status).toBe(404);
    // GET on the POST-only ingest route
    expect((await worker.fetch(request("/v1/event-batches"), makeEnv(db), CTX)).status).toBe(404);
    // POST on the GET-only listing route
    expect(
      (await worker.fetch(request("/v1/workstreams", { method: "POST" }), makeEnv(db), CTX)).status,
    ).toBe(404);
  });

  it("serves a no-store signed-out account page and fails closed when auth is unconfigured", async () => {
    const { db } = mockDb();
    const page = await worker.fetch(request("/account"), makeEnv(db), CTX);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Hosted identity unavailable");
    expect(pageHtml).not.toContain("intent=signup");
    expect(pageHtml).not.toContain("intent=signin");

    const auth = await worker.fetch(request("/v1/auth/start?intent=signup"), makeEnv(db), CTX);
    expect(auth.status).toBe(503);
    expect(await auth.json()).toMatchObject({ error: "hosted_auth_unavailable" });
  });

  it("does not render auth links when the callback configuration is malformed", async () => {
    const { db } = mockDb();
    const page = await worker.fetch(
      request("/account"),
      {
        ...makeEnv(db),
        WORKOS_CLIENT_ID: "client_test",
        WORKOS_API_KEY: "key_test",
        APP_ORIGIN: "https://api.handoffgraph.dev",
        WORKOS_REDIRECT_URI: "https://api.handoffgraph.dev/v1/auth/callback?drift=1",
      } as never,
      CTX,
    );
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Hosted identity unavailable");
    expect(pageHtml).not.toContain("intent=signup");
    expect(pageHtml).not.toContain("intent=signin");
  });

  it("publishes an honest plan catalog without enabling preview tiers", async () => {
    const { db } = mockDb();
    const response = await worker.fetch(request("/v1/plans"), makeEnv(db), CTX);
    expect(response.status).toBe(200);
    const body = await response.json() as { plans: Array<Record<string, unknown>> };
    const basic = body.plans.find((plan) => plan.id === "basic");
    const pro = body.plans.find((plan) => plan.id === "pro");
    expect(basic).toMatchObject({
      available: true,
      hostedEntitlement: true,
      limits: { maxDevices: 2, maxMonthlyEvents: 5_000, maxLifetimeBytes: 67_108_864 },
    });
    expect(pro).toMatchObject({
      available: false,
      hostedEntitlement: false,
      limits: null,
    });
  });
});

describe("worker: POST /v1/event-batches", () => {
  it("stores the batch and returns a deterministic receipt", async () => {
    const { db, batches } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: 1,
      batch_id: expect.stringMatching(/^batch_[0-9a-f]{32}$/),
      schema_version: "hfg.event-batch.receipt.v1",
      workspace_id: TOKEN_WORKSPACE,
    });

    // One atomic batch: quota, idempotency, raw event, and read model.
    expect(batches).toHaveLength(1);
    const [reservation, idempotencyInsert, eventInsert, workstreamUpsert] = batches[0];
    expect(reservation.sql).toContain("INSERT OR IGNORE INTO quota_reservations");
    expect(idempotencyInsert.sql).toContain("INSERT INTO idempotency_keys");
    expect(idempotencyInsert.binds[0]).toBe("key-1");
    expect(idempotencyInsert.binds[1]).toBe(TOKEN_WORKSPACE);
    expect(idempotencyInsert.binds[2]).toBe(DEVICE_ID);
    expect(idempotencyInsert.binds[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(eventInsert.sql).toContain("INSERT OR IGNORE INTO events");
    expect(eventInsert.binds[0]).toBe(TOKEN_WORKSPACE); // workspace from the token, never the body
    expect(eventInsert.binds[1]).toBe("key-1");
    const storedEvents = JSON.parse(String(eventInsert.binds[3])) as Record<string, unknown>[];
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0].event_id).toBe(eventId(0));
    expect(storedEvents[0].schema_version).toBe("hfg.event.v1");
    expect(workstreamUpsert.sql).toContain("INSERT INTO workstreams");
    expect(workstreamUpsert.sql).toContain("ON CONFLICT(workspace_id, id)");
    expect(workstreamUpsert.sql).toContain("WHERE workstreams.workspace_id = excluded.workspace_id");
    expect(workstreamUpsert.sql).toContain("events.raw_json = source.value");
    expect(workstreamUpsert.sql).toContain("WHEN workstreams.status = 'completed' THEN workstreams.status");
    expect(workstreamUpsert.sql).toContain("WHEN excluded.status = 'completed' THEN excluded.status");
    const projections = JSON.parse(String(workstreamUpsert.binds[0])) as Record<string, unknown>[];
    expect(projections).toHaveLength(1);
    expect(projections[0].id).toBe(workstreamId(0));
    expect(projections[0].workspace_id).toBe(TOKEN_WORKSPACE);
    expect(projections[0].source_event_id).toBe(eventId(0));
    expect(workstreamUpsert.binds[1]).toBe(eventInsert.binds[3]);
  });

  it("keeps a 500-event request to three D1 batch statements", async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, i) => event({}, i));
    const { db, batches } = mockDb({
      first: deviceRegistry({}, {
        max_batch_events: MAX_EVENTS_PER_BATCH,
        max_batch_bytes: MAX_BODY_BYTES,
      }),
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "full-batch" }),
        body: JSON.stringify(envelope({}, events)),
      }),
      makeEnv(db),
      CTX,
    );

    expect(response.status).toBe(200);
    // Constant statement count at the event ceiling: quota, idempotency, raw
    // events, workstream projection, and the three observation projections.
    expect(batches[0]).toHaveLength(7);
    expect(JSON.parse(String(batches[0][2].binds[3]))).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(JSON.parse(String(batches[0][3].binds[0]))).toHaveLength(MAX_EVENTS_PER_BATCH);
  });

  it("puts a Basic quota reservation in the same transaction as every hosted write", async () => {
    const { db, batches } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM workspace_entitlements")) return entitlementRow();
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "metered-1" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(7);
    const [reservation, idempotency, events, projection, spans, prints, sessions] = batches[0];
    expect(spans.sql).toContain("observations:upsert-spans");
    expect(prints.sql).toContain("observations:upsert-fingerprints");
    expect(sessions.sql).toContain("observations:upsert-sessions");
    for (const statement of [spans, prints, sessions]) {
      expect(statement.binds[0]).toBe(TOKEN_WORKSPACE);
    }
    expect(reservation.sql).toContain("INSERT OR IGNORE INTO quota_reservations");
    expect(reservation.binds[0]).toBe(TOKEN_WORKSPACE);
    expect(reservation.binds[1]).toBe("metered-1");
    expect(reservation.binds[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(reservation.binds[3]).toBe(1);
    expect(reservation.binds[4]).toBeGreaterThan(0);
    expect(idempotency.sql).toContain("INSERT INTO idempotency_keys");
    expect(events.sql).toContain("INSERT OR IGNORE INTO events");
    expect(projection.sql).toContain("INSERT INTO workstreams");
  });

  it("rejects Basic one event over its per-batch limit before any write", async () => {
    const events = Array.from({ length: 101 }, (_, i) => event({}, i));
    const { db, batches } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM workspace_entitlements")) return entitlementRow();
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "metered-over" }),
        body: JSON.stringify(envelope({}, events)),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toMatchObject({
      error: "hosted quota exceeded",
      code: "batch_events_exceeded",
      local_capture_unaffected: true,
      detail: {
        scope: "batch",
        resource: "events",
        limit: 100,
        requested: 101,
        retryable: false,
      },
    });
    expect(batches).toHaveLength(0);
  });

  it("marks monthly quota denials retryable and emits the exact reset as Retry-After", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const periodEnd = nowSeconds + 600;
    const { db, batches } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM workspace_entitlements")) {
          return entitlementRow({
            max_monthly_events: 1,
            used_monthly_events: 1,
            period_start: nowSeconds - 600,
            period_end: periodEnd,
          });
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "metered-monthly-over" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );

    expect(response.status).toBe(429);
    const retryAfter = response.headers.get("retry-after");
    expect(retryAfter).toBe(new Date(periodEnd * 1000).toUTCString());
    expect(Date.parse(retryAfter as string) / 1000).toBe(periodEnd);
    expect(await response.json()).toMatchObject({
      error: "hosted quota exceeded",
      code: "monthly_events_exceeded",
      local_capture_unaffected: true,
      detail: {
        scope: "month",
        resource: "events",
        limit: 1,
        used: 1,
        requested: 1,
        resets_at: periodEnd,
        retryable: true,
      },
    });
    expect(batches).toHaveLength(0);
  });

  it("fails closed instead of emitting Retry-After beyond the fixed horizon", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { db, batches } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM workspace_entitlements")) {
          return entitlementRow({
            max_monthly_events: 1,
            used_monthly_events: 1,
            period_start: nowSeconds,
            period_end: nowSeconds + 30 * 24 * 60 * 60 + 1,
          });
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "metered-monthly-invalid-reset" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toMatchObject({
      code: "quota_configuration_error",
      local_capture_unaffected: true,
    });
    expect(batches).toHaveLength(0);
  });

  it("fails closed when the hosted entitlement is inactive", async () => {
    const { db, batches } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM workspace_entitlements")) {
          return entitlementRow({ status: "suspended" });
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "inactive" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "entitlement_inactive",
      local_capture_unaffected: true,
    });
    expect(batches).toHaveLength(0);
  });

  it("fails closed when a device workspace has no hosted entitlement", async () => {
    const { db, batches } = mockDb({
      first: async (sql) => sql.includes("FROM devices") ? deviceRow() : null,
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "missing-entitlement" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "quota_configuration_error",
      local_capture_unaffected: true,
    });
    expect(batches).toHaveLength(0);
  });

  it("returns the original receipt bytes for a duplicate key without re-storing", async () => {
    const receipt = await buildReceipt("key-1", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const receiptJson = canonicalJsonStringify(receipt);
    const requestHash = await sha256Hex(canonicalJsonStringify(envelope()));
    const { db, batches } = mockDb({
      first: async (sql, binds) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("quota:read-policy")) return entitlementRow();
        if (sql.includes("FROM idempotency_keys")) {
          expect(binds).toEqual([TOKEN_WORKSPACE, "key-1"]);
          return { workspace_id: TOKEN_WORKSPACE, request_hash: requestHash, receipt_json: receiptJson };
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(receiptJson);
    expect(batches).toHaveLength(0);
  });

  it("rejects a migrated receipt whose original request hash is unverifiable", async () => {
    const { db, batches } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM idempotency_keys")) {
          return {
            workspace_id: TOKEN_WORKSPACE,
            request_hash: null,
            receipt_json: '{"accepted":1}',
          };
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "legacy-key" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "legacy Idempotency-Key cannot be verified; use a new key",
    });
    expect(batches).toHaveLength(0);
  });

  it("re-reads the receipt when an identical quota reservation wins after the first lookup", async () => {
    const receipt = await buildReceipt("quota-race", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const receiptJson = canonicalJsonStringify(receipt);
    const requestHash = await sha256Hex(canonicalJsonStringify(envelope()));
    let receiptReads = 0;
    const { db, batches } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("quota:read-policy")) return entitlementRow();
        if (sql.includes("FROM idempotency_keys")) {
          receiptReads += 1;
          return receiptReads === 1
            ? null
            : { workspace_id: TOKEN_WORKSPACE, request_hash: requestHash, receipt_json: receiptJson };
        }
        if (sql.includes("FROM quota_reservations")) {
          return {
            request_hash: requestHash,
            event_count: 1,
            body_bytes: new TextEncoder().encode(JSON.stringify(envelope())).byteLength,
            status: "allowed",
          };
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "quota-race" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(receiptJson);
    expect(receiptReads).toBe(2);
    expect(batches).toHaveLength(0);
  });

  it("rejects reuse of a tenant idempotency key for a different canonical request", async () => {
    const firstHash = await sha256Hex(canonicalJsonStringify(envelope()));
    const { db, batches } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM idempotency_keys")) {
          return {
            workspace_id: TOKEN_WORKSPACE,
            request_hash: firstHash,
            receipt_json: "{}",
          };
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope({}, [event({}, 1)])),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Idempotency-Key was already used for a different request",
    });
    expect(batches).toHaveLength(0);
  });

  it("answers 404 for a duplicate key owned by a foreign workspace", async () => {
    const { db } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM idempotency_keys")) {
          return { workspace_id: OTHER_WORKSPACE, receipt_json: "{}" };
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "collided-key" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("requires the Idempotency-Key header", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    for (const extra of [undefined, { "idempotency-key": "   " }]) {
      const response = await worker.fetch(
        request("/v1/event-batches", {
          method: "POST",
          headers: authed(extra),
          body: JSON.stringify(envelope()),
        }),
        makeEnv(db),
        CTX,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Idempotency-Key header is required" });
    }
  });

  it("rejects requests without a valid device token", async () => {
    const { db } = mockDb({ first: async () => null });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: { "idempotency-key": "key-1" },
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a revoked device", async () => {
    const { db } = mockDb({
      first: deviceRegistry({ revoked_at: 1_700_000_000 }),
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(401);
  });

  it("answers 403 for a device without the ingest capability", async () => {
    const { db, batches } = mockDb({
      first: deviceRegistry({ capabilities: "read" }),
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(batches).toHaveLength(0);
  });

  it("rejects a body over 1 MiB with 413", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: "x".repeat(MAX_BODY_BYTES + 16),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body exceeds 1 MiB" });
  });

  it("rejects invalid JSON with 400", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: "{not json",
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body is not valid JSON" });
  });

  it("rejects invalid UTF-8 without buffering or replacement", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-invalid-utf8" }),
        body: new Uint8Array([0xff]),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body is not readable UTF-8" });
  });

  it("rejects an invalid envelope (fail-closed) without storing anything", async () => {
    const { db, batches } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope({ schema_version: "wrong" })),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it("answers 404 when the body claims a foreign workspace", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope({ workspace_id: OTHER_WORKSPACE })),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("maps contradictory reuse of an event ID to a fail-closed 409", async () => {
    const { db, batches } = mockDb({
      first: deviceRegistry(),
      batch: () => {
        throw new Error("D1_ERROR: event payload conflict: SQLITE_CONSTRAINT");
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "different-batch" }),
        body: JSON.stringify(envelope({}, [event({ payload: { exit_code: 2 } })])),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "event_id was already used for different evidence",
    });
    expect(batches).toHaveLength(1);
  });

  it("maps a commit-time device-revocation loss to the ordinary 401", async () => {
    const { db, batches } = mockDb({
      first: deviceRegistry(),
      batch: () => {
        throw new Error("D1_ERROR: active device required: SQLITE_CONSTRAINT");
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "revocation-race" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(batches).toHaveLength(1);
  });

  it("recovers the winner's receipt when a concurrent duplicate loses the insert race", async () => {
    const receipt = await buildReceipt("race-key", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const receiptJson = canonicalJsonStringify(receipt);
    const requestHash = await sha256Hex(canonicalJsonStringify(envelope()));
    let firstRead = true;
    const { db } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("quota:read-policy")) return entitlementRow();
        if (sql.includes("FROM idempotency_keys")) {
          if (firstRead) {
            firstRead = false;
            return null;
          }
          return { workspace_id: TOKEN_WORKSPACE, request_hash: requestHash, receipt_json: receiptJson };
        }
        return null;
      },
      batch: () => {
        throw new Error("UNIQUE constraint failed: idempotency_keys.key");
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "race-key" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(receiptJson);
  });
});

describe("worker: GET /v1/workstreams", () => {
  /** Registry answers for the test token; workstreams queries page `rows`. */
  function listDb(rows: WorkstreamRow[]) {
    // Emulate the SQL contract: ORDER BY created_at DESC, id DESC.
    const ordered = [...rows].sort(
      (a, b) => b.created_at - a.created_at || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0),
    );
    return mockDb({
      first: deviceRegistry(),
      all: async (sql, binds) => {
        expect(sql).toContain("FROM workstreams");
        const fetchLimit = binds[binds.length - 1] as number;
        let page = ordered;
        if (binds.length === 4) {
          const createdAt = binds[1] as number;
          const id = binds[2] as string;
          page = ordered.filter(
            (row) => row.created_at < createdAt || (row.created_at === createdAt && row.id < id),
          );
        }
        return page.slice(0, fetchLimit);
      },
    });
  }

  it("pages newest-first with a next_cursor when more rows exist", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => workstreamRow(i));
    const { db } = listDb(rows);
    const response = await worker.fetch(
      request("/v1/workstreams", { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workstreams: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.workstreams).toHaveLength(50);
    expect(body.workstreams[0].id).toBe(workstreamRow(54).id);
    expect(body.workstreams[49].id).toBe(workstreamRow(5).id);
    expect(decodeCursor(body.next_cursor ?? "")).toEqual({
      createdAt: workstreamRow(5).created_at,
      id: workstreamRow(5).id,
    });
  });

  it("follows the cursor to the final page (next_cursor null)", async () => {
    const rows = [workstreamRow(4), workstreamRow(3), workstreamRow(2), workstreamRow(1), workstreamRow(0)];
    const { db } = listDb(rows);
    const first = (await (
      await worker.fetch(request("/v1/workstreams?limit=3", { headers: authed() }), makeEnv(db), CTX)
    ).json()) as { workstreams: unknown[]; next_cursor: string | null };
    expect(first.workstreams).toHaveLength(3);
    expect(first.next_cursor).not.toBeNull();
    const second = await worker.fetch(
      request(`/v1/workstreams?limit=3&cursor=${first.next_cursor}`, { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as { workstreams: unknown[]; next_cursor: string | null };
    expect(body.workstreams).toHaveLength(2);
    expect(body.next_cursor).toBeNull();
  });

  it("scopes the SQL query to the token workspace", async () => {
    const seenBinds: unknown[][] = [];
    const { db } = mockDb({
      first: deviceRegistry(),
      all: async (_sql, binds) => {
        seenBinds.push(binds);
        return [];
      },
    });
    await worker.fetch(request("/v1/workstreams", { headers: authed() }), makeEnv(db), CTX);
    expect(seenBinds[0][0]).toBe(TOKEN_WORKSPACE);
  });

  it("rejects invalid pagination parameters with 400", async () => {
    const { db } = listDb([]);
    for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?cursor=bogus"]) {
      const response = await worker.fetch(
        request(`/v1/workstreams${query}`, { headers: authed() }),
        makeEnv(db),
        CTX,
      );
      expect(response.status).toBe(400);
    }
  });

  it("requires authentication", async () => {
    const { db } = listDb([]);
    const response = await worker.fetch(request("/v1/workstreams"), makeEnv(db), CTX);
    expect(response.status).toBe(401);
  });

  it("answers 403 for a device without the read capability", async () => {
    const { db } = mockDb({
      first: deviceRegistry({ capabilities: "ingest" }),
      all: async () => [],
    });
    const response = await worker.fetch(
      request("/v1/workstreams", { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });
});
