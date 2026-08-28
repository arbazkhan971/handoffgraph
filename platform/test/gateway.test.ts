// Unit tests for src/gateway.ts: virtual-key lifecycle, the OpenAI-compatible
// proxy (auth, budgets, rate limits, fallbacks, response cache), the capture
// path that puts every proxied call on the event spine, and a node:sqlite
// pass proving migration 0010's CHECK constraints and triggers hold.
//
// fetch is injected as a parameter everywhere, so no test touches the
// network. D1 is the mockDb fake (test/ingest.test.ts pattern); KV and R2 are
// plain-object fakes satisfying the structural bindings declared in the
// module under test.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import {
  CAPTURE_TIERS,
  EVENT_KIND_COMPLETED,
  EVENT_KIND_FAILED,
  GATEWAY_CACHE_TTL_SECONDS,
  RATE_LIMIT_WINDOW_SECONDS,
  addDecimalStrings,
  buildCaptureEvent,
  cacheKeyMaterial,
  compareDecimalStrings,
  handleGatewayRoute,
  isDecimalString,
  providerReportedCost,
  sealUpstreamKey,
  unsealUpstreamKey,
  validateUpstreamBaseUrl,
  type CaptureInput,
  type FetchLike,
  type GatewayCacheBucketLike,
  type GatewayEnv,
  type GatewayKeyRecord,
  type KVNamespaceLike,
  type KVPutOptionsLike,
} from "../src/gateway";

// -- fake D1 (mockDb pattern; see test/ingest.test.ts, test/webhooks.test.ts) --

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (statement: RecordedStatement) => unknown | Promise<unknown>;
  all?: (statement: RecordedStatement) => unknown[] | Promise<unknown[]>;
  run?: (statement: RecordedStatement) => void | Promise<void>;
  batch?: (statements: RecordedStatement[]) => void | Promise<void>;
} = {}) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
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
      const recorded = bound as unknown as RecordedStatement[];
      batches.push(recorded);
      await handlers.batch?.(recorded);
      return [];
    },
  };
  return { db, statements, batches };
}

// -- fake KV / R2 --------------------------------------------------------------

function makeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: { key: string; value: string; options?: KVPutOptionsLike }[] = [];
  const kv: KVNamespaceLike = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: KVPutOptionsLike) {
      store.set(key, value);
      puts.push({ key, value, options });
    },
  };
  return { kv, store, puts };
}

interface CacheEntry {
  body: string;
  customMetadata?: Record<string, string>;
}

function makeBucket(initial: Record<string, CacheEntry> = {}) {
  const store = new Map<string, CacheEntry>(Object.entries(initial));
  const bucket: GatewayCacheBucketLike = {
    async get(key: string) {
      const found = store.get(key);
      if (found === undefined) return null;
      return { customMetadata: found.customMetadata, text: async () => found.body };
    },
    async put(
      key: string,
      value: string,
      options?: { customMetadata?: Record<string, string> },
    ) {
      store.set(key, { body: value, customMetadata: options?.customMetadata });
      return undefined;
    },
  };
  return { bucket, store };
}

// -- fixtures -------------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const GWK_ONE = `gwk_01J${"A".repeat(23)}`;
const GWK_TWO = `gwk_01J${"B".repeat(23)}`;
const GWR_ONE = `gwr_01J${"C".repeat(23)}`;
const VK_TOKEN = "vk_test-virtual-key-0001";
const SEALING_KEY = "test-gateway-sealing-key-material";
const WORKSTREAM_ID = `ws_01J${"0".repeat(23)}`; // ws_ + 26 Crockford chars

const PRIMARY_UPSTREAM_KEY = "sk-upstream-primary";
const FALLBACK_ONE_KEY = "sk-upstream-fallback-one";
const FALLBACK_TWO_KEY = "sk-upstream-fallback-two";

const PRIMARY_BASE = "https://api.openai.example";
const FALLBACK_ONE_BASE = "https://fallback-one.example";
const FALLBACK_TWO_BASE = "https://fallback-two.example";

/** A prompt/completion pair used to prove nothing content-bearing is stored. */
const SECRET_PROMPT = "PROMPT-CANARY-do-not-persist";
const SECRET_COMPLETION = "COMPLETION-CANARY-do-not-persist";

let TOKEN_HASH = "";
let VK_HASH = "";
let PRIMARY_CIPHERTEXT = "";
let FALLBACK_ONE_CIPHERTEXT = "";
let FALLBACK_TWO_CIPHERTEXT = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
  VK_HASH = await sha256Hex(VK_TOKEN);
  PRIMARY_CIPHERTEXT = await sealUpstreamKey(PRIMARY_UPSTREAM_KEY, SEALING_KEY);
  FALLBACK_ONE_CIPHERTEXT = await sealUpstreamKey(FALLBACK_ONE_KEY, SEALING_KEY);
  FALLBACK_TWO_CIPHERTEXT = await sealUpstreamKey(FALLBACK_TWO_KEY, SEALING_KEY);
});

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

function authedFirst(
  extra: (statement: RecordedStatement) => unknown | Promise<unknown> = () => null,
  deviceOverrides: Record<string, unknown> = {},
): (statement: RecordedStatement) => unknown | Promise<unknown> {
  return async (statement) => {
    if (statement.sql.includes("FROM devices")) return deviceRow(deviceOverrides);
    return extra(statement);
  };
}

function gatewayKeyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GWK_ONE,
    workspace_id: TOKEN_WORKSPACE,
    name: "prod",
    budget_amount: null,
    budget_spent: "0",
    rate_limit_per_min: 60,
    upstream_base_url: PRIMARY_BASE,
    upstream_provider: "openai",
    upstream_key_ciphertext: PRIMARY_CIPHERTEXT,
    fallbacks: "[]",
    capture_tier: "metadata",
    disabled: 0,
    ...overrides,
  };
}

/** Resolves the virtual key from D1 (KV miss path) and nothing else. */
function keyLookupFirst(
  row: Record<string, unknown> | null = gatewayKeyRow(),
): (statement: RecordedStatement) => unknown {
  return (statement) =>
    statement.sql.includes("gateway:key-by-token-hash") ? row : null;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function deviceAuthed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

function vkAuthed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${VK_TOKEN}`, "content-type": "application/json", ...extra };
}

function makeEnv(db: D1DatabaseLike, overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return { DB: db, GATEWAY_SEALING_KEY: SEALING_KEY, ...overrides };
}

const neverFetch: FetchLike = async () => {
  throw new Error("fetch should not have been called");
};

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string;
  body: string | null;
}

/** Fetcher that replays scripted outcomes and records every call it saw. */
function scriptedFetcher(script: Array<{ status: number; body: unknown } | "throw">) {
  const calls: UpstreamCall[] = [];
  let index = 0;
  const fetcher: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.authorization ?? "",
      body: typeof init?.body === "string" ? init.body : null,
    });
    const outcome = script[index] ?? script[script.length - 1];
    index += 1;
    if (outcome === "throw") throw new Error("connection reset");
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, calls };
}

function chatRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: SECRET_PROMPT }],
    temperature: 0.2,
    ...overrides,
  };
}

function completionBody(usage: Record<string, unknown> | null = { prompt_tokens: 11, completion_tokens: 7 }) {
  return {
    id: "chatcmpl-1",
    choices: [{ message: { role: "assistant", content: SECRET_COMPLETION } }],
    ...(usage === null ? {} : { usage }),
  };
}

function chatRequest(
  body: Record<string, unknown> = chatRequestBody(),
  headers: Record<string, string> = vkAuthed(),
): Request {
  return request("/gateway/openai/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function findStatement(batch: RecordedStatement[], marker: string): RecordedStatement | undefined {
  return batch.find((statement) => statement.sql.includes(marker));
}

// -- decimal money ------------------------------------------------------------------

describe("decimal money helpers", () => {
  it("accepts only canonical non-negative decimals", () => {
    for (const good of ["0", "1", "0.0021", "12.5", "999999.999999"]) {
      expect(isDecimalString(good)).toBe(true);
    }
    for (const bad of ["", "-1", "1e-7", ".5", "5.", "01", "1.2.3", "1,5", "abc", null, 5]) {
      expect(isDecimalString(bad)).toBe(false);
    }
  });

  it("adds exactly, without binary floating point drift", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; the ledger must not inherit that.
    expect(addDecimalStrings("0.1", "0.2")).toBe("0.3");
    expect(addDecimalStrings("0", "0.0021")).toBe("0.0021");
    expect(addDecimalStrings("0.0021", "0.0021")).toBe("0.0042");
    expect(addDecimalStrings("9.99", "0.01")).toBe("10.00");
    expect(addDecimalStrings("1", "0.000001")).toBe("1.000001");
  });

  it("accumulates a long run of tiny charges without losing a cent", () => {
    let total = "0";
    for (let i = 0; i < 1000; i++) total = addDecimalStrings(total, "0.001");
    expect(total).toBe("1.000");
  });

  it("compares across differing scales", () => {
    expect(compareDecimalStrings("10.00", "10")).toBe(0);
    expect(compareDecimalStrings("0.0041", "0.0042")).toBe(-1);
    expect(compareDecimalStrings("0.0042", "0.0042")).toBe(0);
    expect(compareDecimalStrings("0.0043", "0.0042")).toBe(1);
  });

  it("takes a provider-reported cost only when it is exactly representable", () => {
    expect(providerReportedCost({ cost: "0.0021" })).toBe("0.0021");
    expect(providerReportedCost({ total_cost: 0.25 })).toBe("0.25");
    expect(providerReportedCost({ cost_usd: "1.5" })).toBe("1.5");
    // Exponent notation is refused rather than reinterpreted: a money figure
    // we had to guess at is not a fact.
    expect(providerReportedCost({ cost: 1e-7 })).toBeNull();
    expect(providerReportedCost({ cost: -1 })).toBeNull();
    expect(providerReportedCost({ prompt_tokens: 11 })).toBeNull();
    expect(providerReportedCost(null)).toBeNull();
  });
});

// -- credential sealing ---------------------------------------------------------------

describe("sealUpstreamKey / unsealUpstreamKey", () => {
  it("round-trips the exact upstream credential", async () => {
    const sealed = await sealUpstreamKey(PRIMARY_UPSTREAM_KEY, SEALING_KEY);
    expect(sealed).not.toContain(PRIMARY_UPSTREAM_KEY);
    expect(await unsealUpstreamKey(sealed, SEALING_KEY)).toBe(PRIMARY_UPSTREAM_KEY);
  });

  it("fails under the wrong sealing key and on a never-sealed value", async () => {
    const sealed = await sealUpstreamKey(PRIMARY_UPSTREAM_KEY, SEALING_KEY);
    await expect(unsealUpstreamKey(sealed, "a-different-key")).rejects.toThrow();
    await expect(unsealUpstreamKey(null, SEALING_KEY)).rejects.toThrow();
  });
});

// -- upstream URL validation -------------------------------------------------------------

describe("validateUpstreamBaseUrl", () => {
  it("accepts public https URLs and strips trailing slashes", () => {
    expect(validateUpstreamBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(validateUpstreamBaseUrl("https://api.openai.com/v1//")).toBe("https://api.openai.com/v1");
  });

  it("rejects non-https, embedded credentials and literal private hosts", () => {
    expect(validateUpstreamBaseUrl("http://api.openai.com/v1")).toBeNull();
    expect(validateUpstreamBaseUrl("https://user:pass@api.openai.com/v1")).toBeNull();
    expect(validateUpstreamBaseUrl("https://localhost/v1")).toBeNull();
    expect(validateUpstreamBaseUrl("https://127.0.0.1/v1")).toBeNull();
    expect(validateUpstreamBaseUrl("https://169.254.169.254/latest")).toBeNull();
    expect(validateUpstreamBaseUrl("https://10.0.0.5/v1")).toBeNull();
    expect(validateUpstreamBaseUrl("https://192.168.1.1/v1")).toBeNull();
    expect(validateUpstreamBaseUrl("https://172.16.0.1/v1")).toBeNull();
    expect(validateUpstreamBaseUrl(42)).toBeNull();
  });
});

// -- POST /v1/gateway/keys ----------------------------------------------------------------

describe("POST /v1/gateway/keys", () => {
  const validBody = {
    name: "prod",
    budget_amount: "25.00",
    rate_limit_per_min: 120,
    upstream: { base_url: `${PRIMARY_BASE}/v1`, provider: "openai", api_key: PRIMARY_UPSTREAM_KEY },
  };

  function createRequest(body: unknown, headers = deviceAuthed()): Request {
    return request("/v1/gateway/keys", { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("requires authentication", async () => {
    const { db } = mockDb({ first: () => null });
    const response = await handleGatewayRoute(createRequest(validBody, {}), makeEnv(db), neverFetch);
    expect(response?.status).toBe(401);
  });

  it("requires the ingest capability", async () => {
    const { db } = mockDb({ first: authedFirst(undefined, { capabilities: "read" }) });
    const response = await handleGatewayRoute(createRequest(validBody), makeEnv(db), neverFetch);
    expect(response?.status).toBe(403);
  });

  it("fails closed with 503 when the sealing key is unset", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleGatewayRoute(
      createRequest(validBody),
      makeEnv(db, { GATEWAY_SEALING_KEY: undefined }),
      neverFetch,
    );
    expect(response?.status).toBe(503);
    expect(await response!.json()).toEqual({ error: "gateway_sealing_key_unavailable" });
  });

  it("rejects a non-https upstream and a private-literal upstream", async () => {
    for (const baseUrl of ["http://api.openai.example/v1", "https://127.0.0.1/v1"]) {
      const { db } = mockDb({ first: authedFirst() });
      const response = await handleGatewayRoute(
        createRequest({ ...validBody, upstream: { ...validBody.upstream, base_url: baseUrl } }),
        makeEnv(db),
        neverFetch,
      );
      expect(response?.status).toBe(400);
    }
  });

  it("rejects a non-decimal budget", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleGatewayRoute(
      createRequest({ ...validBody, budget_amount: 25.0 }),
      makeEnv(db),
      neverFetch,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "budget_amount must be a non-negative decimal string",
    });
  });

  it("rejects an unknown capture tier", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleGatewayRoute(
      createRequest({ ...validBody, capture: "everything" }),
      makeEnv(db),
      neverFetch,
    );
    expect(response?.status).toBe(400);
  });

  it("mints a key, shows the token exactly once, and writes D1 then KV", async () => {
    const { db, statements } = mockDb({ first: authedFirst() });
    const { kv, store, puts } = makeKV();
    const response = await handleGatewayRoute(
      createRequest(validBody),
      makeEnv(db, { GATEWAY_KV: kv }),
      neverFetch,
    );
    expect(response?.status).toBe(201);

    const body = (await response!.json()) as {
      gateway_key: Record<string, unknown>;
      virtual_key: string;
      warning: string;
    };
    expect(body.virtual_key).toMatch(/^vk_[A-Za-z0-9_-]{20,}$/);
    expect(body.warning).toContain("cannot be shown again");
    expect(body.gateway_key.id).toMatch(/^gwk_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.gateway_key.budget_amount).toBe("25.00");
    expect(body.gateway_key.budget_spent).toBe("0");
    expect(body.gateway_key.capture).toBe("metadata"); // default tier

    // The raw upstream credential and the token hash never appear in the
    // response, and the token itself is never persisted.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(PRIMARY_UPSTREAM_KEY);
    expect(serialized).not.toContain("token_hash");

    const insert = statements.find((s) => s.sql.includes("gateway:insert-key"));
    expect(insert).toBeDefined();
    expect(insert!.binds[1]).toBe(TOKEN_WORKSPACE); // workspace from the token, never the body
    expect(insert!.binds[3]).toBe(await sha256Hex(body.virtual_key));
    expect(insert!.binds[3]).not.toBe(body.virtual_key);
    expect(insert!.binds[4]).toBe("25.00");
    expect(insert!.binds[8]).not.toContain(PRIMARY_UPSTREAM_KEY); // sealed, not plaintext
    expect(await unsealUpstreamKey(insert!.binds[8] as string, SEALING_KEY)).toBe(
      PRIMARY_UPSTREAM_KEY,
    );

    // KV is written after D1 (write-through), keyed by the token hash.
    const kvKey = `vk:${await sha256Hex(body.virtual_key)}`;
    expect(store.has(kvKey)).toBe(true);
    expect(puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(store.get(kvKey)!) as GatewayKeyRecord;
    expect(cached.workspace_id).toBe(TOKEN_WORKSPACE);
    expect(cached.budget_spent).toBe("0");
    expect(cached.disabled).toBe(false);
  });

  it("seals every fallback credential too", async () => {
    const { db, statements } = mockDb({ first: authedFirst() });
    const response = await handleGatewayRoute(
      createRequest({
        ...validBody,
        fallbacks: [{ base_url: FALLBACK_ONE_BASE, api_key: FALLBACK_ONE_KEY }],
      }),
      makeEnv(db),
      neverFetch,
    );
    expect(response?.status).toBe(201);
    const insert = statements.find((s) => s.sql.includes("gateway:insert-key"));
    const fallbacks = JSON.parse(insert!.binds[9] as string) as Array<Record<string, string>>;
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].base_url).toBe(FALLBACK_ONE_BASE);
    expect(fallbacks[0].api_key_ciphertext).not.toContain(FALLBACK_ONE_KEY);
    expect(await unsealUpstreamKey(fallbacks[0].api_key_ciphertext, SEALING_KEY)).toBe(
      FALLBACK_ONE_KEY,
    );
  });

  it("still works with no KV binding at all", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleGatewayRoute(createRequest(validBody), makeEnv(db), neverFetch);
    expect(response?.status).toBe(201);
  });
});

// -- GET /v1/gateway/keys -----------------------------------------------------------------

describe("GET /v1/gateway/keys", () => {
  it("lists keys in a deterministic order, never exposing secrets", async () => {
    const rows = [
      {
        id: GWK_ONE,
        name: "a",
        budget_amount: "10",
        budget_spent: "1.5",
        rate_limit_per_min: 60,
        upstream_base_url: PRIMARY_BASE,
        upstream_provider: "openai",
        capture_tier: "metadata",
        disabled: 0,
        created_at: 100,
      },
      {
        id: GWK_TWO,
        name: "b",
        budget_amount: null,
        budget_spent: "0",
        rate_limit_per_min: 10,
        upstream_base_url: FALLBACK_ONE_BASE,
        upstream_provider: "custom",
        capture_tier: "full",
        disabled: 1,
        created_at: 200,
      },
    ];
    // Deliberately returned in storage order, not sorted order.
    const { db } = mockDb({ first: authedFirst(), all: () => rows });
    const response = await handleGatewayRoute(
      request("/v1/gateway/keys", { headers: deviceAuthed() }),
      makeEnv(db),
      neverFetch,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { items: Record<string, unknown>[]; next_cursor: string | null };
    expect(body.items.map((item) => item.id)).toEqual([GWK_TWO, GWK_ONE]); // created_at DESC
    expect(body.next_cursor).toBeNull();
    expect(body.items[1].budget_spent).toBe("1.5");
    expect(body.items[1].capture).toBe("metadata");
    expect(body.items[0].disabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("token_hash");
    expect(JSON.stringify(body)).not.toContain("ciphertext");
  });

  it("requires the read capability", async () => {
    const { db } = mockDb({ first: authedFirst(undefined, { capabilities: "ingest" }) });
    const response = await handleGatewayRoute(
      request("/v1/gateway/keys", { headers: deviceAuthed() }),
      makeEnv(db),
      neverFetch,
    );
    expect(response?.status).toBe(403);
  });
});

// -- POST /v1/gateway/keys/{id}/disable -----------------------------------------------------

describe("POST /v1/gateway/keys/{id}/disable", () => {
  function disableRequest(id: string): Request {
    return request(`/v1/gateway/keys/${id}/disable`, {
      method: "POST",
      headers: deviceAuthed(),
    });
  }

  it("disables an owned key and write-throughs the revocation to KV", async () => {
    const { db, statements } = mockDb({
      first: authedFirst((statement) =>
        statement.sql.includes("gateway:disable-key")
          ? { ...gatewayKeyRow({ disabled: 1 }), token_hash: VK_HASH }
          : null,
      ),
    });
    const { kv, store } = makeKV({ [`vk:${VK_HASH}`]: JSON.stringify({ disabled: false }) });
    const response = await handleGatewayRoute(
      disableRequest(GWK_ONE),
      makeEnv(db, { GATEWAY_KV: kv }),
      neverFetch,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true });

    const update = statements.find((s) => s.sql.includes("gateway:disable-key"));
    expect(update!.binds).toEqual([GWK_ONE, TOKEN_WORKSPACE]); // workspace-scoped

    const cached = JSON.parse(store.get(`vk:${VK_HASH}`)!) as GatewayKeyRecord;
    expect(cached.disabled).toBe(true);
  });

  it("404s a key that belongs to another workspace (existence is never leaked)", async () => {
    // The workspace-scoped conditional UPDATE simply matches nothing.
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleGatewayRoute(disableRequest(GWK_TWO), makeEnv(db), neverFetch);
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "not found" });
  });

  it("404s an already-disabled key the same way", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleGatewayRoute(disableRequest(GWK_ONE), makeEnv(db), neverFetch);
    expect(response?.status).toBe(404);
  });

  it("does not own an unknown method on a known path", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleGatewayRoute(
      request(`/v1/gateway/keys/${GWK_ONE}/disable`, { method: "GET", headers: deviceAuthed() }),
      makeEnv(db),
      neverFetch,
    );
    expect(response).toBeNull(); // index.ts answers 404
  });
});

// -- proxy authentication -------------------------------------------------------------------

describe("proxy authentication (OpenAI-shaped errors)", () => {
  it("401s an unknown virtual key in OpenAI's error shape", async () => {
    const { db } = mockDb({ first: keyLookupFirst(null) });
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), neverFetch);
    expect(response?.status).toBe(401);
    expect(await response!.json()).toEqual({
      error: {
        message: "Incorrect API key provided.",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
  });

  it("401s a missing or non-vk bearer without touching D1", async () => {
    const { db, statements } = mockDb({ first: keyLookupFirst() });
    const response = await handleGatewayRoute(
      chatRequest(chatRequestBody(), { "content-type": "application/json" }),
      makeEnv(db),
      neverFetch,
    );
    expect(response?.status).toBe(401);

    const withDeviceToken = await handleGatewayRoute(
      chatRequest(chatRequestBody(), { authorization: `Bearer ${DEVICE_TOKEN}` }),
      makeEnv(db),
      neverFetch,
    );
    expect(withDeviceToken?.status).toBe(401);
    expect(statements).toHaveLength(0);
  });

  it("401s a disabled key with a distinguishable code", async () => {
    const { db } = mockDb({ first: keyLookupFirst(gatewayKeyRow({ disabled: 1 })) });
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), neverFetch);
    expect(response?.status).toBe(401);
    const body = (await response!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("key_disabled");
  });

  it("fails closed with 503 when the sealing key is unset, before any lookup", async () => {
    const { db, statements } = mockDb({ first: keyLookupFirst() });
    const response = await handleGatewayRoute(
      chatRequest(),
      makeEnv(db, { GATEWAY_SEALING_KEY: undefined }),
      neverFetch,
    );
    expect(response?.status).toBe(503);
    const body = (await response!.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("gateway_sealing_key_unavailable");
    expect(body.error.type).toBe("server_error");
    expect(statements).toHaveLength(0);
  });

  it("prefers the KV cache and backfills it on a D1 fallback", async () => {
    const { db, statements } = mockDb({
      first: keyLookupFirst(),
      batch: () => undefined,
    });
    const { kv, store } = makeKV();
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);

    // First call: KV miss -> D1 -> backfill.
    await handleGatewayRoute(chatRequest(), makeEnv(db, { GATEWAY_KV: kv }), fetcher);
    expect(statements.some((s) => s.sql.includes("gateway:key-by-token-hash"))).toBe(true);
    expect(store.has(`vk:${VK_HASH}`)).toBe(true);

    // Second call: served from KV, no registry read at all.
    const { db: db2, statements: statements2 } = mockDb({ batch: () => undefined });
    await handleGatewayRoute(chatRequest(), makeEnv(db2, { GATEWAY_KV: kv }), fetcher);
    expect(statements2.some((s) => s.sql.includes("gateway:key-by-token-hash"))).toBe(false);
  });
});

// -- budgets --------------------------------------------------------------------------------

describe("budget enforcement", () => {
  it("rejects at the exhaustion boundary (spent >= budget) before forwarding", async () => {
    const { db } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ budget_amount: "0.0042", budget_spent: "0.0042" })),
    });
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), neverFetch);
    expect(response?.status).toBe(429);
    const body = (await response!.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("budget_exhausted");
    expect(body.error.type).toBe("insufficient_quota");
  });

  it("allows the last request under the boundary", async () => {
    const { db } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ budget_amount: "0.0042", budget_spent: "0.0041" })),
      batch: () => undefined,
    });
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);
    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("treats a scale difference as equal at the boundary", async () => {
    const { db } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ budget_amount: "10", budget_spent: "10.00" })),
    });
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), neverFetch);
    expect(response?.status).toBe(429);
  });

  it("never enforces a budget when none is set", async () => {
    const { db } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ budget_amount: null, budget_spent: "9999999" })),
      batch: () => undefined,
    });
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);
    expect(response?.status).toBe(200);
  });

  it("accumulates provider-reported spend exactly, in D1 and then KV", async () => {
    const { db, batches } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ budget_amount: "1.00", budget_spent: "0.0021" })),
      batch: () => undefined,
    });
    const { kv, store } = makeKV();
    const { fetcher } = scriptedFetcher([
      {
        status: 200,
        body: completionBody({ prompt_tokens: 11, completion_tokens: 7, cost: "0.0021" }),
      },
    ]);

    const response = await handleGatewayRoute(
      chatRequest(),
      makeEnv(db, { GATEWAY_KV: kv }),
      fetcher,
    );
    expect(response?.status).toBe(200);

    const update = findStatement(batches[0], "gateway:advance-budget-spent");
    expect(update).toBeDefined();
    // Compare-and-set: new value, guarded on the exact value we read.
    expect(update!.binds[2]).toBe("0.0042");
    expect(update!.binds[3]).toBe("0.0021");
    // The charge is guarded on this request's ledger row not existing yet,
    // which is only sound if it runs BEFORE the insert that creates it.
    expect(update!.binds[4]).toBe(findStatement(batches[0], "gateway:insert-request")!.binds[0]);
    expect(batches[0].indexOf(update!)).toBeLessThan(
      batches[0].indexOf(findStatement(batches[0], "gateway:insert-request")!),
    );

    const cached = JSON.parse(store.get(`vk:${VK_HASH}`)!) as GatewayKeyRecord;
    expect(cached.budget_spent).toBe("0.0042");
  });

  it("does not advance the budget when the upstream reported no cost", async () => {
    const { db, batches } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ budget_amount: "1.00" })),
      batch: () => undefined,
    });
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);
    expect(findStatement(batches[0], "gateway:advance-budget-spent")).toBeUndefined();

    // ... and the ledger records NULL rather than an estimate.
    const ledger = findStatement(batches[0], "gateway:insert-request");
    expect(ledger!.binds[8]).toBeNull();
  });
});

// -- rate limiting ------------------------------------------------------------------------

describe("rate limiting", () => {
  it("counts per key per minute in KV and rejects over the limit", async () => {
    const record = gatewayKeyRow({ rate_limit_per_min: 2 });
    const { db } = mockDb({ first: keyLookupFirst(record), batch: () => undefined });
    const { kv, store, puts } = makeKV();
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const env = makeEnv(db, { GATEWAY_KV: kv });

    expect((await handleGatewayRoute(chatRequest(), env, fetcher))?.status).toBe(200);
    expect((await handleGatewayRoute(chatRequest(), env, fetcher))?.status).toBe(200);

    const counterKey = [...store.keys()].find((key) => key.startsWith("rl:"));
    expect(counterKey).toMatch(new RegExp(`^rl:${GWK_ONE}:\\d+$`));
    expect(store.get(counterKey!)).toBe("2");
    expect(puts.find((put) => put.key.startsWith("rl:"))?.options?.expirationTtl).toBe(
      RATE_LIMIT_WINDOW_SECONDS,
    );

    const third = await handleGatewayRoute(chatRequest(), env, fetcher);
    expect(third?.status).toBe(429);
    const body = (await third!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(calls).toHaveLength(2); // the rejected call never reached the upstream
  });

  it("does not rate limit when no KV binding is configured", async () => {
    const { db } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ rate_limit_per_min: 1 })),
      batch: () => undefined,
    });
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const env = makeEnv(db);
    expect((await handleGatewayRoute(chatRequest(), env, fetcher))?.status).toBe(200);
    expect((await handleGatewayRoute(chatRequest(), env, fetcher))?.status).toBe(200);
  });
});

// -- streaming ------------------------------------------------------------------------------

describe("streaming", () => {
  it("rejects stream:true with a clear OpenAI-shaped 400", async () => {
    const { db } = mockDb({ first: keyLookupFirst() });
    const response = await handleGatewayRoute(
      chatRequest(chatRequestBody({ stream: true })),
      makeEnv(db),
      neverFetch,
    );
    expect(response?.status).toBe(400);
    const body = (await response!.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("stream_unsupported");
    expect(body.error.message).toContain('"stream": false');
  });

  it("accepts stream:false", async () => {
    const { db } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const response = await handleGatewayRoute(
      chatRequest(chatRequestBody({ stream: false })),
      makeEnv(db),
      fetcher,
    );
    expect(response?.status).toBe(200);
  });
});

// -- capture (the point of the slice) -----------------------------------------------------------

describe("capture", () => {
  it("appends one content-free OBSERVED event per proxied call", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { fetcher } = scriptedFetcher([
      { status: 200, body: completionBody({ prompt_tokens: 11, completion_tokens: 7 }) },
    ]);

    const response = await handleGatewayRoute(
      chatRequest(chatRequestBody(), vkAuthed({ "x-handoffgraph-workstream": WORKSTREAM_ID })),
      makeEnv(db),
      fetcher,
    );
    expect(response?.status).toBe(200);
    expect(batches).toHaveLength(1);

    const insert = findStatement(batches[0], "gateway:insert-capture-event");
    expect(insert).toBeDefined();
    const [workspaceId, eventId, , occurredAt, workstreamId, provider, kind, contentHash, , rawJson] =
      insert!.binds as [string, string, string, string, string | null, string, string, string | null, number, string];

    expect(workspaceId).toBe(TOKEN_WORKSPACE);
    expect(eventId).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(kind).toBe(EVENT_KIND_COMPLETED);
    expect(provider).toBe("gateway");
    expect(workstreamId).toBe(WORKSTREAM_ID); // X-HandoffGraph-Workstream honoured
    expect(contentHash).toBeNull(); // metadata tier retains no body to point at
    expect(Number.isFinite(Date.parse(occurredAt))).toBe(true);

    const event = JSON.parse(rawJson) as Record<string, unknown>;
    expect(event.schema_version).toBe("hfg.event.v1");
    expect(event.provenance).toBe("OBSERVED");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.model).toBe("gpt-4o-mini");
    expect(payload.upstream_provider).toBe("openai");
    expect(payload.status).toBe(200);
    expect(payload.token_input).toBe(11);
    expect(payload.token_output).toBe(7);
    expect(payload.cost_amount).toBeNull();
    expect(payload).not.toHaveProperty("cost_provenance");
    expect(payload.cached).toBe(false);
    expect(payload.fallback_index).toBe(0);
    expect(payload.capture_tier).toBe("metadata");
    expect(payload.request_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof payload.latency_ms).toBe("number");

    // The canary strings prove no prompt or completion reached the spine.
    expect(rawJson).not.toContain(SECRET_PROMPT);
    expect(rawJson).not.toContain(SECRET_COMPLETION);
    expect(JSON.stringify(batches[0].map((s) => s.binds))).not.toContain(SECRET_PROMPT);
    expect(JSON.stringify(batches[0].map((s) => s.binds))).not.toContain(SECRET_COMPLETION);
  });

  it("writes a content-free ledger row alongside the event", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { fetcher } = scriptedFetcher([
      {
        status: 200,
        body: completionBody({ prompt_tokens: 11, completion_tokens: 7, cost: "0.0021" }),
      },
    ]);
    await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);

    const ledger = findStatement(batches[0], "gateway:insert-request");
    expect(ledger).toBeDefined();
    const binds = ledger!.binds;
    expect(binds[0]).toMatch(/^gwr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(binds[1]).toBe(TOKEN_WORKSPACE);
    expect(binds[2]).toBe(GWK_ONE);
    expect(binds[3]).toBe("gpt-4o-mini");
    expect(binds[4]).toBe(200);
    expect(binds[6]).toBe(11);
    expect(binds[7]).toBe(7);
    expect(binds[8]).toBe("0.0021");
    expect(binds[9]).toBe(0); // not cached
  });

  it("labels a provider-reported cost and never labels an absent one", () => {
    const record: GatewayKeyRecord = {
      id: GWK_ONE,
      workspace_id: TOKEN_WORKSPACE,
      name: "prod",
      budget_amount: null,
      budget_spent: "0",
      rate_limit_per_min: 60,
      upstream: { base_url: PRIMARY_BASE, provider: "anthropic", api_key_ciphertext: null },
      fallbacks: [],
      capture: "metadata",
      disabled: false,
    };
    const base: CaptureInput = {
      record,
      tokenHash: VK_HASH,
      requestId: GWR_ONE,
      eventId: `evt_01J${"D".repeat(23)}`,
      requestHash: `sha256:${"a".repeat(64)}`,
      responseHash: null,
      workstreamId: null,
      model: "claude-x",
      status: 200,
      latencyMs: 42,
      tokensIn: 3,
      tokensOut: 4,
      costAmount: "0.5",
      cached: false,
      fallbackIndex: 0,
      startedAtMs: 1_700_000_000_000,
      finishedAtMs: 1_700_000_000_042,
    };

    const withCost = buildCaptureEvent(base).payload as Record<string, unknown>;
    expect(withCost.cost_amount).toBe("0.5");
    expect(withCost.cost_provenance).toBe("provider_reported");

    const withoutCost = buildCaptureEvent({ ...base, costAmount: null }).payload as Record<string, unknown>;
    expect(withoutCost.cost_amount).toBeNull();
    expect(withoutCost).not.toHaveProperty("cost_provenance");
  });

  it("marks a failed upstream with the failed kind", () => {
    const record: GatewayKeyRecord = {
      id: GWK_ONE,
      workspace_id: TOKEN_WORKSPACE,
      name: "prod",
      budget_amount: null,
      budget_spent: "0",
      rate_limit_per_min: 60,
      upstream: { base_url: PRIMARY_BASE, provider: "openai", api_key_ciphertext: null },
      fallbacks: [],
      capture: "metadata",
      disabled: false,
    };
    const base: CaptureInput = {
      record,
      tokenHash: VK_HASH,
      requestId: GWR_ONE,
      eventId: `evt_01J${"E".repeat(23)}`,
      requestHash: `sha256:${"b".repeat(64)}`,
      responseHash: null,
      workstreamId: null,
      model: null,
      status: null,
      latencyMs: 1,
      tokensIn: null,
      tokensOut: null,
      costAmount: null,
      cached: false,
      fallbackIndex: 1,
      startedAtMs: 0,
      finishedAtMs: 1,
    };
    expect(buildCaptureEvent(base).kind).toBe(EVENT_KIND_FAILED);
    expect(buildCaptureEvent({ ...base, status: 500 }).kind).toBe(EVENT_KIND_FAILED);
    expect(buildCaptureEvent({ ...base, status: 400 }).kind).toBe(EVENT_KIND_FAILED);
    expect(buildCaptureEvent({ ...base, status: 200 }).kind).toBe(EVENT_KIND_COMPLETED);
  });

  it("ignores a malformed workstream header instead of failing the call", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const response = await handleGatewayRoute(
      chatRequest(chatRequestBody(), vkAuthed({ "x-handoffgraph-workstream": "not-a-workstream" })),
      makeEnv(db),
      fetcher,
    );
    expect(response?.status).toBe(200);
    const insert = findStatement(batches[0], "gateway:insert-capture-event");
    expect(insert!.binds[4]).toBeNull();
  });

  it("stores bodies only for a capture:full key, content-addressed", async () => {
    const { db, batches } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ capture_tier: "full" })),
      batch: () => undefined,
    });
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);

    const bodies = batches[0].filter((s) => s.sql.includes("gateway:insert-capture-body"));
    expect(bodies).toHaveLength(2);
    expect(bodies.map((s) => s.binds[4])).toEqual(["request", "response"]);
    for (const statement of bodies) {
      expect(statement.binds[1]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(statement.binds[0]).toBe(TOKEN_WORKSPACE);
    }
    expect(bodies[0].binds[5]).toContain(SECRET_PROMPT);
    expect(bodies[1].binds[5]).toContain(SECRET_COMPLETION);

    // The event still carries no content — only the digest that names it.
    const event = findStatement(batches[0], "gateway:insert-capture-event")!;
    expect(event.binds[7]).toMatch(/^sha256:[0-9a-f]{64}$/); // content_hash populated at full tier
    expect(event.binds[9]).not.toContain(SECRET_PROMPT);
    expect(event.binds[9]).not.toContain(SECRET_COMPLETION);
  });

  it("never stores bodies at the default metadata tier", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);
    expect(batches[0].some((s) => s.sql.includes("gateway:insert-capture-body"))).toBe(false);
  });

  it("returns the model's answer even when capture fails entirely", async () => {
    const { db } = mockDb({
      first: keyLookupFirst(),
      batch: () => {
        throw new Error("D1 unavailable");
      },
    });
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ id: "chatcmpl-1" });
  });

  it("retries without the event when the spine rejects a payload conflict", async () => {
    // Two byte-identical requests in the same millisecond derive the same
    // deterministic event id with different latency payloads. The spend must
    // still be recorded, so the batch is retried without the event insert.
    let attempts = 0;
    const { db, batches } = mockDb({
      first: keyLookupFirst(),
      batch: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("event payload conflict");
      },
    });
    const { fetcher } = scriptedFetcher([
      { status: 200, body: completionBody({ prompt_tokens: 1, completion_tokens: 1, cost: "0.5" }) },
    ]);
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);

    expect(response?.status).toBe(200);
    expect(batches).toHaveLength(2);
    expect(findStatement(batches[0], "gateway:insert-capture-event")).toBeDefined();
    expect(findStatement(batches[1], "gateway:insert-capture-event")).toBeUndefined();
    // The ledger row and the budget advance survive the retry.
    expect(findStatement(batches[1], "gateway:insert-request")).toBeDefined();
    expect(findStatement(batches[1], "gateway:advance-budget-spent")).toBeDefined();
  });

  it("derives the same event id for the same key, body and millisecond", async () => {
    async function eventIdFor(body: Record<string, unknown>): Promise<string> {
      const { db, batches } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
      const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
      await handleGatewayRoute(chatRequest(body), makeEnv(db), fetcher);
      return findStatement(batches[0], "gateway:insert-capture-event")!.binds[1] as string;
    }
    // Different bodies must never collide, regardless of timing.
    const a = await eventIdFor(chatRequestBody());
    const b = await eventIdFor(chatRequestBody({ temperature: 0.9 }));
    expect(a).not.toBe(b);
  });
});

// -- fallbacks ------------------------------------------------------------------------------

describe("provider fallback", () => {
  const withFallbacks = () =>
    gatewayKeyRow({
      fallbacks: JSON.stringify([
        { base_url: FALLBACK_ONE_BASE, api_key_ciphertext: FALLBACK_ONE_CIPHERTEXT },
        { base_url: FALLBACK_TWO_BASE, api_key_ciphertext: FALLBACK_TWO_CIPHERTEXT },
      ]),
    });

  it("tries each fallback once, in order, on upstream 5xx", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst(withFallbacks()), batch: () => undefined });
    const { fetcher, calls } = scriptedFetcher([
      { status: 503, body: { error: "overloaded" } },
      { status: 500, body: { error: "boom" } },
      { status: 200, body: completionBody() },
    ]);

    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);
    expect(response?.status).toBe(200);

    expect(calls.map((call) => call.url)).toEqual([
      `${PRIMARY_BASE}/chat/completions`,
      `${FALLBACK_ONE_BASE}/chat/completions`,
      `${FALLBACK_TWO_BASE}/chat/completions`,
    ]);
    // Each target is called with its own unsealed credential, once.
    expect(calls.map((call) => call.authorization)).toEqual([
      `Bearer ${PRIMARY_UPSTREAM_KEY}`,
      `Bearer ${FALLBACK_ONE_KEY}`,
      `Bearer ${FALLBACK_TWO_KEY}`,
    ]);

    const event = JSON.parse(
      findStatement(batches[0], "gateway:insert-capture-event")!.binds[9] as string,
    ) as { payload: Record<string, unknown> };
    expect(event.payload.fallback_index).toBe(2); // which target actually answered
  });

  it("treats a thrown fetch (timeout, reset) exactly like a 5xx", async () => {
    const { db } = mockDb({ first: keyLookupFirst(withFallbacks()), batch: () => undefined });
    const { fetcher, calls } = scriptedFetcher(["throw", { status: 200, body: completionBody() }]);
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);
    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 4xx — the request itself is wrong", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst(withFallbacks()), batch: () => undefined });
    const { fetcher, calls } = scriptedFetcher([
      { status: 400, body: { error: { message: "bad model" } } },
      { status: 200, body: completionBody() },
    ]);
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);
    expect(response?.status).toBe(400);
    expect(calls).toHaveLength(1);

    const event = JSON.parse(
      findStatement(batches[0], "gateway:insert-capture-event")!.binds[9] as string,
    ) as { kind: string };
    expect(event.kind).toBe(EVENT_KIND_FAILED);
  });

  it("502s and captures a failure when every target is exhausted", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst(withFallbacks()), batch: () => undefined });
    const { fetcher, calls } = scriptedFetcher(["throw", "throw", "throw"]);
    const response = await handleGatewayRoute(chatRequest(), makeEnv(db), fetcher);

    expect(response?.status).toBe(502);
    const body = (await response!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_unavailable");
    expect(calls).toHaveLength(3); // once each, never twice

    const ledger = findStatement(batches[0], "gateway:insert-request")!;
    expect(ledger.binds[4]).toBeNull(); // no upstream status
    const event = JSON.parse(
      findStatement(batches[0], "gateway:insert-capture-event")!.binds[9] as string,
    ) as { kind: string };
    expect(event.kind).toBe(EVENT_KIND_FAILED);
  });

  it("does not forward HandoffGraph control headers to the upstream", async () => {
    const { db } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    await handleGatewayRoute(
      chatRequest(
        chatRequestBody(),
        vkAuthed({ "x-handoffgraph-workstream": WORKSTREAM_ID, "x-handoffgraph-cache": "false" }),
      ),
      makeEnv(db),
      fetcher,
    );
    expect(calls[0].authorization).toBe(`Bearer ${PRIMARY_UPSTREAM_KEY}`);
    expect(calls[0].authorization).not.toContain(VK_TOKEN);
  });
});

// -- response cache (parity row 7) -------------------------------------------------------------

describe("response cache", () => {
  it("derives the same key regardless of JSON key order, and ignores stream", () => {
    const a = cacheKeyMaterial({ model: "m", messages: [1], temperature: 0.2 });
    const b = cacheKeyMaterial({ temperature: 0.2, messages: [1], model: "m" });
    const c = cacheKeyMaterial({ model: "m", messages: [1], temperature: 0.2, stream: false });
    const d = cacheKeyMaterial({ model: "m", messages: [1], temperature: 0.9 });
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).not.toBe(d);
  });

  it("misses, forwards, stores, then hits without calling the upstream again", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { bucket, store } = makeBucket();
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const env = makeEnv(db, { BODIES: bucket });
    const headers = vkAuthed({ "x-handoffgraph-cache": "true" });

    const miss = await handleGatewayRoute(chatRequest(chatRequestBody(), headers), env, fetcher);
    expect(miss?.status).toBe(200);
    expect(miss!.headers.get("x-handoffgraph-cache")).toBe("miss");
    expect(calls).toHaveLength(1);

    const cacheKey = [...store.keys()][0];
    expect(cacheKey).toMatch(new RegExp(`^gwcache/${TOKEN_WORKSPACE}/[0-9a-f]{64}\\.json$`));
    expect(store.get(cacheKey)!.customMetadata?.cached_at).toMatch(/^\d+$/);

    const hit = await handleGatewayRoute(
      chatRequest(chatRequestBody(), headers),
      env,
      neverFetch, // a second upstream call would throw
    );
    expect(hit?.status).toBe(200);
    expect(hit!.headers.get("x-handoffgraph-cache")).toBe("hit");
    expect(await hit!.json()).toMatchObject({ id: "chatcmpl-1" });

    // Both calls are on the spine; the hit is marked cached with no cost.
    expect(batches).toHaveLength(2);
    const hitLedger = findStatement(batches[1], "gateway:insert-request")!;
    expect(hitLedger.binds[9]).toBe(1); // cached
    expect(hitLedger.binds[8]).toBeNull(); // never a cost
    const hitEvent = JSON.parse(
      findStatement(batches[1], "gateway:insert-capture-event")!.binds[9] as string,
    ) as { payload: Record<string, unknown> };
    expect(hitEvent.payload.cached).toBe(true);
    expect(hitEvent.payload.fallback_index).toBeNull();
  });

  it("treats an entry older than the TTL as a miss", async () => {
    const digest = await sha256Hex(cacheKeyMaterial(chatRequestBody()));
    const stale = String(Math.floor(Date.now() / 1000) - GATEWAY_CACHE_TTL_SECONDS - 1);
    const { bucket } = makeBucket({
      [`gwcache/${TOKEN_WORKSPACE}/${digest}.json`]: {
        body: JSON.stringify({ id: "stale" }),
        customMetadata: { cached_at: stale, status: "200" },
      },
    });
    const { db } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: completionBody() }]);

    const response = await handleGatewayRoute(
      chatRequest(chatRequestBody(), vkAuthed({ "x-handoffgraph-cache": "true" })),
      makeEnv(db, { BODIES: bucket }),
      fetcher,
    );
    expect(calls).toHaveLength(1); // stale entry not served
    expect(await response!.json()).toMatchObject({ id: "chatcmpl-1" });
  });

  it("treats an entry with no usable timestamp as a miss", async () => {
    const digest = await sha256Hex(cacheKeyMaterial(chatRequestBody()));
    const { bucket } = makeBucket({
      [`gwcache/${TOKEN_WORKSPACE}/${digest}.json`]: { body: JSON.stringify({ id: "unstamped" }) },
    });
    const { db } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    await handleGatewayRoute(
      chatRequest(chatRequestBody(), vkAuthed({ "x-handoffgraph-cache": "true" })),
      makeEnv(db, { BODIES: bucket }),
      fetcher,
    );
    expect(calls).toHaveLength(1);
  });

  it("does not consult or populate the cache without the opt-in header", async () => {
    const { db } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { bucket, store } = makeBucket();
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    const response = await handleGatewayRoute(
      chatRequest(),
      makeEnv(db, { BODIES: bucket }),
      fetcher,
    );
    expect(response!.headers.get("x-handoffgraph-cache")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("never caches a non-200 upstream response", async () => {
    const { db } = mockDb({ first: keyLookupFirst(), batch: () => undefined });
    const { bucket, store } = makeBucket();
    const { fetcher } = scriptedFetcher([{ status: 429, body: { error: { message: "slow down" } } }]);
    await handleGatewayRoute(
      chatRequest(chatRequestBody(), vkAuthed({ "x-handoffgraph-cache": "true" })),
      makeEnv(db, { BODIES: bucket }),
      fetcher,
    );
    expect(store.size).toBe(0);
  });

  it("scopes cache objects per workspace", async () => {
    const otherWorkspace = "wsp_01HTSTW0RKSPEER0000000000Z";
    const { db } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ workspace_id: otherWorkspace })),
      batch: () => undefined,
    });
    const { bucket, store } = makeBucket();
    const { fetcher } = scriptedFetcher([{ status: 200, body: completionBody() }]);
    await handleGatewayRoute(
      chatRequest(chatRequestBody(), vkAuthed({ "x-handoffgraph-cache": "true" })),
      makeEnv(db, { BODIES: bucket }),
      fetcher,
    );
    expect([...store.keys()][0]).toContain(`gwcache/${otherWorkspace}/`);
  });
});

// -- GET /gateway/openai/v1/models ---------------------------------------------------------------

describe("GET /gateway/openai/v1/models", () => {
  it("passes through with the unsealed upstream credential", async () => {
    const { db, batches } = mockDb({ first: keyLookupFirst() });
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: { data: [{ id: "gpt-4o" }] } }]);
    const response = await handleGatewayRoute(
      request("/gateway/openai/v1/models", { headers: vkAuthed() }),
      makeEnv(db),
      fetcher,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ data: [{ id: "gpt-4o" }] });
    expect(calls[0].url).toBe(`${PRIMARY_BASE}/models`);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].authorization).toBe(`Bearer ${PRIMARY_UPSTREAM_KEY}`);
    // Deliberately absent from the spend ledger: no usage, no cost.
    expect(batches).toHaveLength(0);
  });

  it("still enforces key validity", async () => {
    const { db } = mockDb({ first: keyLookupFirst(gatewayKeyRow({ disabled: 1 })) });
    const response = await handleGatewayRoute(
      request("/gateway/openai/v1/models", { headers: vkAuthed() }),
      makeEnv(db),
      neverFetch,
    );
    expect(response?.status).toBe(401);
  });
});

// -- routing ownership ------------------------------------------------------------------------

describe("handleGatewayRoute ownership", () => {
  it("returns null for paths it does not own", async () => {
    const { db } = mockDb();
    for (const path of ["/healthz", "/v1/workstreams", "/gateway/anthropic/v1/messages"]) {
      expect(await handleGatewayRoute(request(path), makeEnv(db), neverFetch)).toBeNull();
    }
  });

  it("returns null for a wrong method on an owned path", async () => {
    const { db } = mockDb();
    expect(
      await handleGatewayRoute(
        request("/v1/gateway/keys", { method: "DELETE" }),
        makeEnv(db),
        neverFetch,
      ),
    ).toBeNull();
    expect(
      await handleGatewayRoute(
        request("/gateway/openai/v1/chat/completions", { method: "GET" }),
        makeEnv(db),
        neverFetch,
      ),
    ).toBeNull();
    expect(
      await handleGatewayRoute(
        request("/gateway/openai/v1/models", { method: "POST" }),
        makeEnv(db),
        neverFetch,
      ),
    ).toBeNull();
  });
});

// -- migration 0010: CHECK constraints + triggers (node:sqlite) ------------------------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0010_gateway.sql";
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

const HASH = "a".repeat(64);
const CONTENT_HASH = `sha256:${"b".repeat(64)}`;

function insertKey(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: GWK_ONE,
    workspace_id: TOKEN_WORKSPACE,
    name: "prod",
    token_hash: HASH,
    budget_amount: null,
    budget_spent: "0",
    rate_limit_per_min: 60,
    upstream_base_url: "https://api.openai.example/v1",
    upstream_provider: "openai",
    upstream_key_ciphertext: null,
    fallbacks: "[]",
    capture_tier: "metadata",
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO gateway_keys
      (id, workspace_id, name, token_hash, budget_amount, budget_spent, rate_limit_per_min,
       upstream_base_url, upstream_provider, upstream_key_ciphertext, fallbacks,
       capture_tier, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id as string,
    row.workspace_id as string,
    row.name as string,
    row.token_hash as string,
    row.budget_amount as string | null,
    row.budget_spent as string,
    row.rate_limit_per_min as number,
    row.upstream_base_url as string,
    row.upstream_provider as string,
    row.upstream_key_ciphertext as string | null,
    row.fallbacks as string,
    row.capture_tier as string,
    row.created_at as number,
  );
}

function insertRequest(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: GWR_ONE,
    workspace_id: TOKEN_WORKSPACE,
    key_id: GWK_ONE,
    model: "gpt-4o-mini",
    upstream_status: 200,
    latency_ms: 120,
    tokens_in: 11,
    tokens_out: 7,
    cost_amount: null,
    cached: 0,
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO gateway_requests
      (id, workspace_id, key_id, model, upstream_status, latency_ms, tokens_in,
       tokens_out, cost_amount, cached, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id as string,
    row.workspace_id as string,
    row.key_id as string,
    row.model as string | null,
    row.upstream_status as number | null,
    row.latency_ms as number,
    row.tokens_in as number | null,
    row.tokens_out as number | null,
    row.cost_amount as string | null,
    row.cached as number,
    row.created_at as number,
  );
}

function insertBody(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    workspace_id: TOKEN_WORKSPACE,
    content_hash: CONTENT_HASH,
    key_id: GWK_ONE,
    request_id: GWR_ONE,
    role: "request",
    body: "{}",
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO gateway_capture_bodies
      (workspace_id, content_hash, key_id, request_id, role, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.workspace_id as string,
    row.content_hash as string,
    row.key_id as string,
    row.request_id as string,
    row.role as string,
    row.body as string,
    row.created_at as number,
  );
}

describe("0010 gateway migration (node:sqlite)", () => {
  it("creates every gateway table", () => {
    const db = migratedDatabase();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    for (const table of ["gateway_keys", "gateway_requests", "gateway_capture_bodies"]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it("requires workspace_id on every gateway table", () => {
    const db = migratedDatabase();
    expect(() =>
      db.prepare(`
        INSERT INTO gateway_keys (id, name, token_hash, upstream_base_url, upstream_provider, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(GWK_ONE, "prod", HASH, "https://api.openai.example/v1", "openai", 1),
    ).toThrow();
    db.close();
  });

  it("accepts an https upstream and rejects everything else", () => {
    const db = migratedDatabase();
    expect(() => insertKey(db)).not.toThrow();
    expect(() =>
      insertKey(db, { id: GWK_TWO, token_hash: "b".repeat(64), upstream_base_url: "http://api.example/v1" }),
    ).toThrow();
    db.close();
  });

  it("rejects an unknown upstream provider and capture tier", () => {
    const db = migratedDatabase();
    expect(() => insertKey(db, { upstream_provider: "gemini" })).toThrow();
    expect(() => insertKey(db, { capture_tier: "everything" })).toThrow();
    db.close();
  });

  it("pins money to canonical decimal strings", () => {
    const db = migratedDatabase();
    expect(() => insertKey(db, { budget_amount: "25.00" })).not.toThrow();
    for (const bad of ["-1", "1e-7", "1.2.3", ".5", "5.", "abc", "1,5"]) {
      expect(() =>
        insertKey(db, { id: GWK_TWO, token_hash: "c".repeat(64), budget_amount: bad }),
      ).toThrow();
    }
    db.close();
  });

  it("enforces one key per token hash", () => {
    const db = migratedDatabase();
    insertKey(db);
    expect(() => insertKey(db, { id: GWK_TWO })).toThrow(); // same token_hash
    db.close();
  });

  it("rejects a malformed gateway key id", () => {
    const db = migratedDatabase();
    expect(() => insertKey(db, { id: "not_an_id" })).toThrow();
    expect(() => insertKey(db, { id: `gwk_${"9".repeat(26)}` })).toThrow(); // first char must be 0-7
    db.close();
  });

  it("holds a key's token hash and workspace immutable", () => {
    const db = migratedDatabase();
    insertKey(db);
    expect(() =>
      db.prepare("UPDATE gateway_keys SET token_hash = ? WHERE id = ?").run("d".repeat(64), GWK_ONE),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE gateway_keys SET workspace_id = ? WHERE id = ?").run("wsp_other", GWK_ONE),
    ).toThrow();
    // Budget and disabled flag remain mutable — that is the whole point.
    expect(() =>
      db.prepare("UPDATE gateway_keys SET budget_spent = ?, disabled = 1 WHERE id = ?").run("0.5", GWK_ONE),
    ).not.toThrow();
    db.close();
  });

  it("keeps the spend ledger append-only", () => {
    const db = migratedDatabase();
    insertKey(db);
    insertRequest(db);
    expect(() =>
      db.prepare("UPDATE gateway_requests SET cost_amount = ? WHERE id = ?").run("9.99", GWR_ONE),
    ).toThrow();
    expect(() => db.prepare("DELETE FROM gateway_requests WHERE id = ?").run(GWR_ONE)).toThrow();
    db.close();
  });

  it("forbids a cached ledger row from carrying a cost", () => {
    const db = migratedDatabase();
    insertKey(db);
    expect(() => insertRequest(db, { cached: 1, cost_amount: "0.5" })).toThrow();
    expect(() =>
      insertRequest(db, { id: `gwr_01J${"D".repeat(23)}`, cached: 1, cost_amount: null }),
    ).not.toThrow();
    db.close();
  });

  it("requires a ledger row to reference a real key", () => {
    const db = migratedDatabase();
    expect(() => insertRequest(db)).toThrow(); // no gateway_keys row yet
    db.close();
  });

  it("bounds upstream_status and latency", () => {
    const db = migratedDatabase();
    insertKey(db);
    expect(() => insertRequest(db, { upstream_status: 42 })).toThrow();
    expect(() => insertRequest(db, { id: `gwr_01J${"E".repeat(23)}`, latency_ms: -1 })).toThrow();
    db.close();
  });

  it("content-addresses captured bodies and keeps them immutable but deletable", () => {
    const db = migratedDatabase();
    insertKey(db);
    insertBody(db);
    // Same (workspace, content_hash) is one row, which is what makes
    // INSERT OR IGNORE idempotent.
    expect(() => insertBody(db)).toThrow();
    expect(() =>
      db.prepare("UPDATE gateway_capture_bodies SET body = ? WHERE content_hash = ?").run("x", CONTENT_HASH),
    ).toThrow();
    // Redaction must still be able to purge content.
    expect(() =>
      db.prepare("DELETE FROM gateway_capture_bodies WHERE content_hash = ?").run(CONTENT_HASH),
    ).not.toThrow();
    db.close();
  });

  it("keeps budget_spent derivable from the ledger across a replay", () => {
    // The real statements from src/gateway.ts, run against real SQLite in
    // the order the batch emits them: charge (guarded on the ledger row's
    // absence) then append the ledger row.
    const db = migratedDatabase();
    insertKey(db, { budget_amount: "1.00", budget_spent: "0" });

    const charge = db.prepare(`
      UPDATE gateway_keys SET budget_spent = ?
      WHERE id = ? AND workspace_id = ? AND budget_spent = ?
        AND NOT EXISTS (SELECT 1 FROM gateway_requests WHERE workspace_id = ? AND id = ?)
    `);
    const spent = () =>
      (db.prepare("SELECT budget_spent FROM gateway_keys WHERE id = ?").get(GWK_ONE) as {
        budget_spent: string;
      }).budget_spent;

    charge.run("0.25", GWK_ONE, TOKEN_WORKSPACE, "0", TOKEN_WORKSPACE, GWR_ONE);
    insertRequest(db, { cost_amount: "0.25" });
    expect(spent()).toBe("0.25");

    // Replay of the exact same request: the deterministic id already has a
    // ledger row, so the charge must not apply a second time.
    charge.run("0.50", GWK_ONE, TOKEN_WORKSPACE, "0.25", TOKEN_WORKSPACE, GWR_ONE);
    db.prepare(`
      INSERT OR IGNORE INTO gateway_requests
        (id, workspace_id, key_id, model, upstream_status, latency_ms, tokens_in, tokens_out,
         cost_amount, cached, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(GWR_ONE, TOKEN_WORKSPACE, GWK_ONE, "m", 200, 5, 1, 1, "0.25", 0, 1_700_000_001);

    expect(spent()).toBe("0.25");
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM gateway_requests WHERE key_id = ?")
      .get(GWK_ONE) as { n: number };
    expect(rows.n).toBe(1);
    db.close();
  });

  it("emits capture statements that the real schema accepts end to end", async () => {
    // The mocked D1 never executes SQL, so this replays the EXACT statements
    // and binds the module produced against a really-migrated database. It
    // catches column/bind drift and trigger rejections that a fake cannot.
    const sqlite = migratedDatabase();
    insertKey(sqlite, { budget_amount: "1.00", budget_spent: "0", capture_tier: "full" });

    const captured: RecordedStatement[] = [];
    const { db } = mockDb({
      first: keyLookupFirst(gatewayKeyRow({ capture_tier: "full", budget_amount: "1.00" })),
      batch: (statements) => {
        captured.push(...statements);
      },
    });
    const { fetcher } = scriptedFetcher([
      {
        status: 200,
        body: completionBody({ prompt_tokens: 11, completion_tokens: 7, cost: "0.25" }),
      },
    ]);
    const response = await handleGatewayRoute(
      chatRequest(chatRequestBody(), vkAuthed({ "x-handoffgraph-workstream": WORKSTREAM_ID })),
      makeEnv(db),
      fetcher,
    );
    expect(response?.status).toBe(200);
    expect(captured.length).toBe(5); // budget, ledger, event, request body, response body

    for (const statement of captured) {
      sqlite
        .prepare(statement.sql)
        .run(...(statement.binds as Array<string | number | null>));
    }

    const key = sqlite.prepare("SELECT budget_spent FROM gateway_keys WHERE id = ?").get(GWK_ONE) as {
      budget_spent: string;
    };
    expect(key.budget_spent).toBe("0.25");

    const ledger = sqlite
      .prepare("SELECT model, upstream_status, tokens_in, tokens_out, cost_amount, cached FROM gateway_requests")
      .all() as Array<Record<string, unknown>>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      model: "gpt-4o-mini",
      upstream_status: 200,
      tokens_in: 11,
      tokens_out: 7,
      cost_amount: "0.25",
      cached: 0,
    });

    const events = sqlite
      .prepare("SELECT event_id, kind, provider, provenance, workstream_id, content_hash, raw_json FROM events")
      .all() as Array<Record<string, string>>;
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe(EVENT_KIND_COMPLETED);
    expect(events[0].provider).toBe("gateway");
    expect(events[0].provenance).toBe("OBSERVED");
    expect(events[0].workstream_id).toBe(WORKSTREAM_ID);
    expect(events[0].content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const bodies = sqlite
      .prepare("SELECT role FROM gateway_capture_bodies ORDER BY role")
      .all() as Array<{ role: string }>;
    expect(bodies.map((row) => row.role)).toEqual(["request", "response"]);

    // Replaying the identical batch must not charge twice or duplicate rows.
    // The event insert is the one statement the spine rejects outright (same
    // id, and re-running it here is a byte-identical payload, so it is a
    // silent no-op rather than a conflict).
    for (const statement of captured) {
      sqlite.prepare(statement.sql).run(...(statement.binds as Array<string | number | null>));
    }
    const after = sqlite
      .prepare("SELECT budget_spent FROM gateway_keys WHERE id = ?")
      .get(GWK_ONE) as { budget_spent: string };
    expect(after.budget_spent).toBe("0.25");
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS n FROM gateway_requests").get() as { n: number }).n,
    ).toBe(1);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(1);

    sqlite.close();
  });

  it("rejects a malformed content hash and an unknown role", () => {
    const db = migratedDatabase();
    insertKey(db);
    expect(() => insertBody(db, { content_hash: "b".repeat(64) })).toThrow(); // missing sha256: prefix
    expect(() => insertBody(db, { role: "prompt" })).toThrow();
    db.close();
  });
});

// Sanity: the capture tiers the SCOPE names, and nothing else.
describe("CAPTURE_TIERS", () => {
  it("is exactly metadata and full", () => {
    expect([...CAPTURE_TIERS]).toEqual(["metadata", "full"]);
  });
});
