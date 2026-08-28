// Unit tests for src/mcp.ts: the hosted JSON-RPC 2.0 MCP endpoint —
// initialize/tools-list/tools-call happy paths, tool input validation,
// unknown-tool -32601, the record_score append shape (INSERT-only,
// deterministic id), accept_handoff's optional handoff-status read, scope
// enforcement (sk_ read-only cannot write), transport-level error shapes,
// and foreign-workspace scoping.

import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { handleMcpRoute } from "../src/mcp";

// -- fake D1 (mockDb pattern; see test/webhooks.test.ts, test/apikeys.test.ts) --

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (statement: RecordedStatement) => unknown | Promise<unknown>;
  all?: (statement: RecordedStatement) => unknown[] | Promise<unknown[]>;
  run?: (statement: RecordedStatement) => void | Promise<void>;
} = {}) {
  const statements: RecordedStatement[] = [];
  const db: D1DatabaseLike = {
    prepare(sql: string): D1Statement & D1BoundStatement & RecordedStatement {
      const statement: D1Statement & D1BoundStatement & RecordedStatement = {
        sql,
        binds: [],
        bind(...values: unknown[]) {
          statement.binds = values;
          return statement;
        },
        async first<T = unknown>() {
          return (await handlers.first?.(statement) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: (await handlers.all?.(statement) ?? []) as T[] };
        },
        async run() {
          await handlers.run?.(statement);
          return { success: true };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(bound: D1BoundStatement[]) {
      return bound.map(() => ({ success: true }));
    },
  };
  return { db, statements };
}

/** Dispatch by the first matching marker comment in the SQL text. */
function byMarker(map: Record<string, unknown>): (s: RecordedStatement) => unknown {
  return (s) => {
    for (const [marker, value] of Object.entries(map)) {
      if (s.sql.includes(marker)) return value;
    }
    return null;
  };
}

// -- fixtures -----------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const SK_READ_TOKEN = "sk_read-only-AAAAAAAAAAAAAAAAAAAAAAA";
const SK_WRITE_TOKEN = "sk_read-write-AAAAAAAAAAAAAAAAAAAAAA";
const WS = "ws_01HTESTWS0000000000000000Z";
const OTHER_WS = "ws_01HTESTWS0000000000000099Z";

let DEVICE_TOKEN_HASH = "";
let SK_READ_HASH = "";
let SK_WRITE_HASH = "";
beforeAll(async () => {
  DEVICE_TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
  SK_READ_HASH = await sha256Hex(SK_READ_TOKEN);
  SK_WRITE_HASH = await sha256Hex(SK_WRITE_TOKEN);
});

function deviceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEVICE_ID,
    workspace_id: TOKEN_WORKSPACE,
    token_hash: DEVICE_TOKEN_HASH,
    capabilities: "ingest,read",
    revoked_at: null,
    ...overrides,
  };
}

function apiKeyRowFor(hash: string, scopes: string[]): Record<string, unknown> {
  return { id: "apk_01JAAAAAAAAAAAAAAAAAAAAAAA", workspace_id: TOKEN_WORKSPACE, secret_hash: hash, scopes: JSON.stringify(scopes), revoked_at: null };
}

function workstreamRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: WS, title: "handoff title", status: "active", created_at: 1_700_000_000, updated_at: 1_700_000_100, ...overrides };
}

function spanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    span_id: "spn_1",
    trace_id: "trc_1",
    parent_span_id: null,
    session_id: "ses_1",
    native_session_id: null,
    workstream_id: WS,
    provider: "claude",
    agent: null,
    model: "claude-sonnet",
    kind: "MODEL",
    name: "call",
    status: "ok",
    started_at_ns: "1000000000",
    ended_at_ns: "2000000000",
    duration_ms: 1000,
    ts_bucket: 0,
    tool_name: null,
    exit_code: null,
    token_in: 10,
    token_out: 20,
    cost_amount: null,
    cost_provenance: null,
    fingerprint: "abc123abc123abc123abc123",
    ...overrides,
  };
}

/** Auth by device token, everything else via `extra`. */
function withDeviceAuth(extra: (s: RecordedStatement) => unknown = () => null, deviceOverrides: Record<string, unknown> = {}) {
  return (s: RecordedStatement) => (s.sql.includes("FROM devices") ? deviceRow(deviceOverrides) : extra(s));
}

/** Auth by sk_ key, everything else via `extra`. */
function withApiKeyAuth(hash: string, scopes: string[], extra: (s: RecordedStatement) => unknown = () => null) {
  return (s: RecordedStatement) => (s.sql.includes("lookup-by-secret-hash") ? apiKeyRowFor(hash, scopes) : extra(s));
}

function mcpRequest(body: unknown, authorization: string): Request {
  return new Request("https://api.handoffgraph.dev/v1/mcp", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const DEVICE_AUTH = `Bearer ${DEVICE_TOKEN}`;
const SK_READ_AUTH = `Bearer ${SK_READ_TOKEN}`;
const SK_WRITE_AUTH = `Bearer ${SK_WRITE_TOKEN}`;

interface RpcOk<T = unknown> {
  jsonrpc: "2.0";
  id: unknown;
  result: T;
}
interface RpcErr {
  jsonrpc: "2.0";
  id: unknown;
  error: { code: number; message: string };
}

async function rpc(res: Response | null): Promise<RpcOk | RpcErr> {
  expect(res).not.toBeNull();
  return (await res!.json()) as RpcOk | RpcErr;
}

// -- transport-level errors -------------------------------------------------------

describe("transport", () => {
  it("is not owned on GET (wrong method on a known path -> platform 404 house rule)", async () => {
    const { db } = mockDb();
    const res = await handleMcpRoute(new Request("https://api.handoffgraph.dev/v1/mcp"), { DB: db });
    expect(res).toBeNull();
  });

  it("401s without a credential", async () => {
    const { db } = mockDb();
    const res = await handleMcpRoute(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, ""), { DB: db });
    expect(res?.status).toBe(401);
  });

  it("rejects a batch (array) request with 400, not silently processing the first message", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest([{ jsonrpc: "2.0", id: 1, method: "initialize" }], DEVICE_AUTH), { DB: db });
    expect(res?.status).toBe(400);
  });

  it("returns a JSON-RPC parse error for invalid JSON", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest("{not json", DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect(res?.status).toBe(200); // JSON-RPC errors travel as 200 + an error envelope
    expect("error" in body && body.error.code).toBe(-32700);
  });

  it("returns invalid-request for a non-2.0 jsonrpc version", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest({ jsonrpc: "1.0", id: 1, method: "initialize" }, DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32600);
  });

  it("returns invalid-request when method is missing", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest({ jsonrpc: "2.0", id: 1 }, DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32600);
  });

  it("returns method-not-found for an unrecognized top-level method", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest({ jsonrpc: "2.0", id: 1, method: "bogus/method" }, DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32601);
  });
});

// -- initialize ---------------------------------------------------------------

describe("initialize", () => {
  it("returns protocolVersion, capabilities.tools, and serverInfo", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest({ jsonrpc: "2.0", id: "a", method: "initialize", params: {} }, DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("result" in body).toBe(true);
    if ("result" in body) {
      const result = body.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
      expect(result.protocolVersion).toBe("2025-06-18");
      expect(result.capabilities.tools).toBeDefined();
      expect(result.serverInfo.name).toBe("handoffgraph-hosted");
    }
  });

  it("echoes back a requested protocolVersion", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-01-01" } }, DEVICE_AUTH),
      { DB: db },
    );
    const body = await rpc(res);
    if ("result" in body) expect((body.result as { protocolVersion: string }).protocolVersion).toBe("2024-01-01");
  });
});

// -- tools/list -----------------------------------------------------------------

describe("tools/list", () => {
  it("lists exactly the six hosted tools", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("result" in body).toBe(true);
    if ("result" in body) {
      const tools = (body.result as { tools: { name: string }[] }).tools;
      expect(tools.map((t) => t.name)).toEqual([
        "get_workstream_context",
        "get_trace_context",
        "list_scores",
        "get_prompt",
        "record_score",
        "accept_handoff",
      ]);
      for (const tool of tools) {
        expect((tool as unknown as { inputSchema: { type: string } }).inputSchema.type).toBe("object");
      }
    }
  });
});

// -- tools/call: routing + unknown tool -------------------------------------------

describe("tools/call routing", () => {
  it("returns -32601 for an unknown tool name (not a tool-result isError)", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_everything", arguments: {} } }, DEVICE_AUTH),
      { DB: db },
    );
    const body = await rpc(res);
    expect("error" in body).toBe(true);
    if ("error" in body) expect(body.error.code).toBe(-32601);
  });

  it("returns -32602 when params is missing", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" }, DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });

  it("returns -32602 when arguments is not an object", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_workstream_context", arguments: "nope" } }, DEVICE_AUTH),
      { DB: db },
    );
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });
});

// -- get_workstream_context ------------------------------------------------------

function callTool(name: string, args: Record<string, unknown>, id: unknown = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("get_workstream_context", () => {
  it("returns title/status/counts/sessions for a known workstream", async () => {
    const { db } = mockDb({
      first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": workstreamRow() })),
      all: byMarker({
        "mcp:workstream-kind-counts": [
          { kind: "decision.recorded", count: 2 },
          { kind: "verification.recorded", count: 1 },
          { kind: "span.started", count: 5 },
        ],
        "mcp:workstream-sessions": [{ id: "ses_1", provider: "claude", native_session_id: null, event_count: 5, span_count: 3, failed_span_count: 0, last_event_at_ms: 100 }],
      }) as (s: RecordedStatement) => unknown[],
    });
    const res = await handleMcpRoute(mcpRequest(callTool("get_workstream_context", { workstream_id: WS }), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("result" in body).toBe(true);
    if ("result" in body) {
      const structured = (body.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(structured.workstream_id).toBe(WS);
      expect(structured.title).toBe("handoff title");
      expect(structured.status).toEqual({ value: "active", provenance: "INFERRED" });
      expect(structured.event_count).toBe(8);
      expect(structured.decisions).toBe(2);
      expect(structured.verifications).toBe(1);
      expect(structured.isValidTool).toBe(true);
      expect((structured.sessions as unknown[])[0]).toMatchObject({ session_id: "ses_1", provider: "claude" });
    }
  });

  it("rejects a missing workstream_id as -32602", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest(callTool("get_workstream_context", {}), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });

  it("rejects a workstream not found in this workspace as -32602 (foreign-workspace-safe: same error either way)", async () => {
    const { db } = mockDb({ first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": null })) });
    const res = await handleMcpRoute(mcpRequest(callTool("get_workstream_context", { workstream_id: OTHER_WS }), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body).toBe(true);
    if ("error" in body) {
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain("not found");
    }
  });
});

// -- get_trace_context ------------------------------------------------------------

describe("get_trace_context", () => {
  it("summarizes spans for a known trace", async () => {
    const { db } = mockDb({
      first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": workstreamRow() })),
      all: byMarker({
        "observations:query-spans": [spanRow(), spanRow({ span_id: "spn_2", status: "error", started_at_ns: "1500000000", ended_at_ns: "2500000000" })],
      }) as (s: RecordedStatement) => unknown[],
    });
    const res = await handleMcpRoute(mcpRequest(callTool("get_trace_context", { workstream_id: WS, trace_id: "trc_1" }), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    if ("result" in body) {
      const structured = (body.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(structured.trace_id).toBe("trc_1");
      expect(structured.span_count).toBe(2);
      expect(structured.failed_span_count).toBe(1);
      expect(structured.status).toBe("ERROR");
      expect(structured.started_at_ns).toBe("1000000000");
      expect(structured.ended_at_ns).toBe("2500000000");
    }
  });

  it("errors cleanly (-32602) when the trace has no spans, instead of crashing", async () => {
    const { db } = mockDb({
      first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": workstreamRow() })),
      all: async () => [],
    });
    const res = await handleMcpRoute(mcpRequest(callTool("get_trace_context", { workstream_id: WS, trace_id: "trc_missing" }), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });
});

// -- list_scores --------------------------------------------------------------

describe("list_scores", () => {
  it("lists scores recorded for a workstream", async () => {
    const rawEvent = {
      schema_version: "hfg.event.v1",
      event_id: "evt_score1",
      kind: "score.recorded",
      occurred_at: "2026-08-21T10:00:00.000Z",
      workstream_id: WS,
      provenance: "OBSERVED",
      payload: { name: "quality", data_type: "NUMERIC", value: "0.5", target_type: "workstream", target_id: WS, source: "api" },
    };
    const { db } = mockDb({
      first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": workstreamRow() })),
      all: async () => [{ seq: 1, event_id: "evt_score1", workstream_id: WS, occurred_at: rawEvent.occurred_at, provenance: "OBSERVED", raw_json: JSON.stringify(rawEvent) }],
    });
    const res = await handleMcpRoute(mcpRequest(callTool("list_scores", { workstream_id: WS }), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    if ("result" in body) {
      const structured = (body.result as { structuredContent: { scores: unknown[]; count: number } }).structuredContent;
      expect(structured.count).toBe(1);
      expect(structured.scores[0]).toMatchObject({ score_id: "evt_score1", name: "quality", value: "0.5" });
    }
  });

  it("rejects an invalid target_type as -32602", async () => {
    const { db } = mockDb({ first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": workstreamRow() })) });
    const res = await handleMcpRoute(mcpRequest(callTool("list_scores", { workstream_id: WS, target_type: "planet" }), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });
});

// -- get_prompt (stub) ----------------------------------------------------------

describe("get_prompt", () => {
  it("returns a clean MCP error rather than crashing (hosted prompt store not available)", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest(callTool("get_prompt", { name: "system.instructions" }), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body).toBe(true);
    if ("error" in body) {
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toMatch(/not available/);
    }
  });

  it("still validates its required argument before the not-available error", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(mcpRequest(callTool("get_prompt", {}), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });
});

// -- record_score ---------------------------------------------------------------

describe("record_score", () => {
  it("appends a score.recorded event (INSERT OR IGNORE) with a deterministic evt_ id, via a device 'ingest' token", async () => {
    const { db, statements } = mockDb({
      first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": workstreamRow() })),
    });
    const res = await handleMcpRoute(
      mcpRequest(
        callTool("record_score", { workstream_id: WS, name: "quality", target_type: "workstream", target_id: WS, value: 0.75 }),
        DEVICE_AUTH,
      ),
      { DB: db },
    );
    const body = await rpc(res);
    expect("result" in body).toBe(true);

    const insertStatement = statements.find((s) => s.sql.includes("mcp:insert-event"));
    expect(insertStatement).toBeDefined();
    expect(insertStatement!.sql).toMatch(/INSERT OR IGNORE/);
    const [workspaceId, eventId, , workstreamId, kind, provenance, ingestedAt, rawJson] = insertStatement!.binds;
    expect(workspaceId).toBe(TOKEN_WORKSPACE);
    expect(eventId).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(workstreamId).toBe(WS);
    expect(kind).toBe("score.recorded");
    expect(provenance).toBe("OBSERVED");
    expect(typeof ingestedAt).toBe("number");
    const parsed = JSON.parse(rawJson as string) as { payload: Record<string, unknown>; kind: string };
    expect(parsed.kind).toBe("score.recorded");
    expect(parsed.payload).toMatchObject({
      name: "quality",
      data_type: "NUMERIC",
      value: "0.75",
      target_type: "workstream",
      target_id: WS,
      source: "api",
    });

    if ("result" in body) {
      const structured = (body.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(structured.event_id).toBe(eventId);
      expect(structured.data_type).toBe("NUMERIC");
    }
  });

  it("succeeds with an sk_ key that has the 'write' scope", async () => {
    const { db } = mockDb({
      first: withApiKeyAuth(SK_WRITE_HASH, ["read", "write"], byMarker({ "mcp:workstream-lookup": workstreamRow() })),
    });
    const res = await handleMcpRoute(
      mcpRequest(callTool("record_score", { workstream_id: WS, name: "q", target_type: "workstream", target_id: WS, bool_value: true }), SK_WRITE_AUTH),
      { DB: db },
    );
    const body = await rpc(res);
    expect("result" in body).toBe(true);
  });

  it("rejects a read-only sk_ key with -32602 (scope enforcement)", async () => {
    const { db, statements } = mockDb({
      first: withApiKeyAuth(SK_READ_HASH, ["read"], byMarker({ "mcp:workstream-lookup": workstreamRow() })),
    });
    const res = await handleMcpRoute(
      mcpRequest(callTool("record_score", { workstream_id: WS, name: "q", target_type: "workstream", target_id: WS, category: "good" }), SK_READ_AUTH),
      { DB: db },
    );
    const body = await rpc(res);
    expect("error" in body).toBe(true);
    if ("error" in body) {
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toMatch(/write/);
    }
    expect(statements.some((s) => s.sql.includes("mcp:insert-event"))).toBe(false); // no write happened
  });

  it("rejects a device token without 'ingest' (read-only device)", async () => {
    const { db } = mockDb({ first: withDeviceAuth(() => null, { capabilities: "read" }) });
    const res = await handleMcpRoute(
      mcpRequest(callTool("record_score", { workstream_id: WS, name: "q", target_type: "workstream", target_id: WS, value: 1 }), DEVICE_AUTH),
      { DB: db },
    );
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });

  it("rejects supplying zero or more than one of value/category/bool_value", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const none = await handleMcpRoute(mcpRequest(callTool("record_score", { workstream_id: WS, name: "q", target_type: "workstream", target_id: WS }), DEVICE_AUTH), { DB: db });
    expect("error" in (await rpc(none)) && true).toBe(true);

    const both = await handleMcpRoute(
      mcpRequest(callTool("record_score", { workstream_id: WS, name: "q", target_type: "workstream", target_id: WS, value: 1, category: "x" }), DEVICE_AUTH),
      { DB: db },
    );
    const bothBody = await rpc(both);
    expect("error" in bothBody && bothBody.error.code).toBe(-32602);
  });

  it("rejects a target_id that does not match its target_type's id prefix", async () => {
    const { db } = mockDb({ first: withDeviceAuth() });
    const res = await handleMcpRoute(
      mcpRequest(callTool("record_score", { workstream_id: WS, name: "q", target_type: "trace", target_id: WS, value: 1 }), DEVICE_AUTH),
      { DB: db },
    );
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });

  it("rejects an out-of-vocabulary source (hosted narrows to human|api|evaluation)", async () => {
    const { db } = mockDb({ first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": workstreamRow() })) });
    const res = await handleMcpRoute(
      mcpRequest(
        callTool("record_score", { workstream_id: WS, name: "q", target_type: "workstream", target_id: WS, value: 1, source: "detection" }),
        DEVICE_AUTH,
      ),
      { DB: db },
    );
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });
});

// -- accept_handoff ---------------------------------------------------------------

describe("accept_handoff", () => {
  it("records acceptance and reports handoff_status 'none' when no handoff.created event exists", async () => {
    const { db, statements } = mockDb({
      first: withDeviceAuth(byMarker({ "mcp:workstream-lookup": workstreamRow(), "mcp:latest-handoff-created": null })),
    });
    const res = await handleMcpRoute(
      mcpRequest(callTool("accept_handoff", { workstream_id: WS, accepted: ["decisions"], agent: "claude" }), DEVICE_AUTH),
      { DB: db },
    );
    const body = await rpc(res);
    expect("result" in body).toBe(true);
    if ("result" in body) {
      const structured = (body.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(structured.handoff_status).toBe("none");
      expect(structured.kind).toBe("handoff.accepted");
      expect(structured.provenance).toBe("DECLARED");
      expect(structured.accepted).toEqual(["decisions"]);
    }
    const insertStatement = statements.find((s) => s.sql.includes("mcp:insert-event"));
    expect(insertStatement).toBeDefined();
    const rawJson = JSON.parse(insertStatement!.binds[7] as string) as { kind: string };
    expect(rawJson.kind).toBe("handoff.accepted");
  });

  it("reports handoff_status 'pending' when a handoff.created event already exists (reads status without requiring it)", async () => {
    const { db } = mockDb({
      first: withDeviceAuth(
        byMarker({ "mcp:workstream-lookup": workstreamRow(), "mcp:latest-handoff-created": { event_id: "evt_handoff1" } }),
      ),
    });
    const res = await handleMcpRoute(mcpRequest(callTool("accept_handoff", { workstream_id: WS }), DEVICE_AUTH), { DB: db });
    const body = await rpc(res);
    if ("result" in body) {
      expect((body.result as { structuredContent: { handoff_status: string } }).structuredContent.handoff_status).toBe("pending");
    }
  });

  it("rejects a read-only sk_ key (scope enforcement applies here too)", async () => {
    const { db } = mockDb({ first: withApiKeyAuth(SK_READ_HASH, ["read"]) });
    const res = await handleMcpRoute(mcpRequest(callTool("accept_handoff", { workstream_id: WS }), SK_READ_AUTH), { DB: db });
    const body = await rpc(res);
    expect("error" in body && body.error.code).toBe(-32602);
  });
});
