// Unit tests for src/webhooks.ts: HTTP management routes (mocked D1), the
// HMAC signing/sealing primitives, the cursor sweep, and the Queues consumer
// — plus a node:sqlite pass proving migration 0007's CHECK constraints and
// triggers hold.

import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { canonicalJsonStringify } from "../src/ingest";
import {
  DEFAULT_INTERESTING_KINDS,
  MAX_DELIVERY_ATTEMPTS,
  computeWebhookSignature,
  handleWebhooksRoute,
  sealWebhookSecret,
  unsealWebhookSecret,
  webhooksQueue,
  webhooksScheduled,
  type FetchLike,
  type MessageBatchLike,
  type QueueLike,
  type WebhookQueueMessage,
  type WebhooksEnv,
} from "../src/webhooks";

// -- fake D1 (mockDb pattern; see test/ingest.test.ts:708, test/account.test.ts:24) --

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

// -- fixtures -----------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const OTHER_WORKSPACE = "wsp_01HTSTW0RKSPEER0000000000Z";
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const WHE_ONE = `whe_01J${"A".repeat(23)}`;
const WHE_TWO = `whe_01J${"B".repeat(23)}`;
const WHD_ONE = `whd_01J${"C".repeat(23)}`;
const SEALING_KEY = "test-webhook-sealing-key-material";

let TOKEN_HASH = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
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

/** Resolves device auth from `FROM devices`, delegates everything else. */
function authedFirst(
  extra: (statement: RecordedStatement) => unknown | Promise<unknown> = () => null,
  deviceOverrides: Record<string, unknown> = {},
): (statement: RecordedStatement) => unknown | Promise<unknown> {
  return async (statement) => {
    if (statement.sql.includes("FROM devices")) return deviceRow(deviceOverrides);
    return extra(statement);
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

function makeEnv(db: D1DatabaseLike, overrides: Partial<WebhooksEnv> = {}): WebhooksEnv {
  return { DB: db, WEBHOOK_SEALING_KEY: SEALING_KEY, ...overrides };
}

const neverFetch: FetchLike = async () => {
  throw new Error("fetch should not have been called");
};

// -- HMAC signature vector -------------------------------------------------------

describe("computeWebhookSignature", () => {
  it("matches an independent HMAC-SHA256(secret, ts.body) computation exactly", async () => {
    const secret = "whsec_fixed-test-secret";
    const timestamp = "1700000000";
    const body = '{"event_id":"evt_1","kind":"handoff.created","workspace_id":"wsp_1"}';
    const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

    const actual = await computeWebhookSignature(secret, timestamp, body);

    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any input changes", async () => {
    const a = await computeWebhookSignature("secret-a", "1", "body");
    const b = await computeWebhookSignature("secret-b", "1", "body");
    const c = await computeWebhookSignature("secret-a", "2", "body");
    const d = await computeWebhookSignature("secret-a", "1", "other-body");
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

// -- secret sealing ---------------------------------------------------------------

describe("sealWebhookSecret / unsealWebhookSecret", () => {
  it("round-trips the exact secret under the sealing key", async () => {
    const secret = "whsec_round-trip-secret";
    const sealed = await sealWebhookSecret(secret, SEALING_KEY);
    expect(sealed).not.toContain(secret);
    const unsealed = await unsealWebhookSecret(sealed, SEALING_KEY);
    expect(unsealed).toBe(secret);
  });

  it("fails to unseal under the wrong sealing key", async () => {
    const sealed = await sealWebhookSecret("whsec_secret", SEALING_KEY);
    await expect(unsealWebhookSecret(sealed, "a-different-key")).rejects.toThrow();
  });

  it("rejects a null (never-sealed) value", async () => {
    await expect(unsealWebhookSecret(null, SEALING_KEY)).rejects.toThrow();
  });
});

// -- POST /v1/webhooks -------------------------------------------------------------

describe("POST /v1/webhooks", () => {
  function createRequest(body: unknown, headers: Record<string, string> = authed()): Request {
    return request("/v1/webhooks", { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("requires authentication", async () => {
    const { db } = mockDb({ first: () => null });
    const response = await handleWebhooksRoute(
      createRequest({ url: "https://example.com/hook", event_kinds: ["handoff.created"] }, {}),
      makeEnv(db),
    );
    expect(response?.status).toBe(401);
  });

  it("requires the ingest capability", async () => {
    const { db } = mockDb({ first: authedFirst(undefined, { capabilities: "read" }) });
    const response = await handleWebhooksRoute(
      createRequest({ url: "https://example.com/hook", event_kinds: ["handoff.created"] }),
      makeEnv(db),
    );
    expect(response?.status).toBe(403);
  });

  it("fails closed with 503 when the sealing key is unset", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleWebhooksRoute(
      createRequest({ url: "https://example.com/hook", event_kinds: ["handoff.created"] }),
      makeEnv(db, { WEBHOOK_SEALING_KEY: undefined }),
    );
    expect(response?.status).toBe(503);
    expect(await response!.json()).toEqual({ error: "webhook_sealing_key_unavailable" });
  });

  it("rejects a non-https url", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleWebhooksRoute(
      createRequest({ url: "http://example.com/hook", event_kinds: ["handoff.created"] }),
      makeEnv(db),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects event kinds outside the recognized set", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleWebhooksRoute(
      createRequest({ url: "https://example.com/hook", event_kinds: ["not.a.real.kind"] }),
      makeEnv(db),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects an empty event_kinds array", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleWebhooksRoute(
      createRequest({ url: "https://example.com/hook", event_kinds: [] }),
      makeEnv(db),
    );
    expect(response?.status).toBe(400);
  });

  it("creates an endpoint and returns the signing secret exactly once", async () => {
    const { db, statements } = mockDb({ first: authedFirst() });
    const response = await handleWebhooksRoute(
      createRequest({
        url: "https://example.com/hook",
        event_kinds: ["handoff.created", "handoff.created", "alert.fired"],
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(201);
    const body = (await response!.json()) as {
      webhook: { id: string; url: string; event_kinds: string[]; active: boolean; created_at: number };
      signing_secret: string;
    };
    expect(body.signing_secret).toMatch(/^whsec_/);
    expect(body.webhook.event_kinds).toEqual(["alert.fired", "handoff.created"]); // deduped + sorted
    expect(body.webhook.active).toBe(true);
    expect(body.webhook).not.toHaveProperty("secret_hash");
    expect(JSON.stringify(body)).not.toContain("secret_hash");

    const insert = statements.find((s) => s.sql.includes("webhooks:insert-endpoint"));
    expect(insert).toBeDefined();
    const [id, workspaceId, url, secretHash, secretCiphertext, eventKindsJson] = insert!.binds as [
      string,
      string,
      string,
      string,
      string,
      string,
      number,
    ];
    expect(id).toBe(body.webhook.id);
    expect(workspaceId).toBe(TOKEN_WORKSPACE);
    expect(url).toBe("https://example.com/hook");
    expect(secretHash).toBe(await sha256Hex(body.signing_secret));
    expect(await unsealWebhookSecret(secretCiphertext, SEALING_KEY)).toBe(body.signing_secret);
    expect(JSON.parse(eventKindsJson)).toEqual(["alert.fired", "handoff.created"]);
  });
});

// -- GET /v1/webhooks ---------------------------------------------------------------

describe("GET /v1/webhooks", () => {
  it("requires the read capability", async () => {
    const { db } = mockDb({ first: authedFirst(undefined, { capabilities: "ingest" }) });
    const response = await handleWebhooksRoute(request("/v1/webhooks", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(403);
  });

  it("lists the caller's own endpoints and never includes the secret", async () => {
    const { db, statements } = mockDb({
      first: authedFirst(),
      all: (statement) => {
        if (statement.sql.includes("webhooks:list-endpoints")) {
          expect(statement.binds[0]).toBe(TOKEN_WORKSPACE);
          return [
            {
              id: WHE_ONE,
              url: "https://example.com/hook",
              active: 1,
              event_kinds: JSON.stringify(["handoff.created"]),
              created_at: 1_700_000_000,
              // Present to prove the handler's field allowlist drops these
              // even if a future query ever over-selects.
              secret_hash: "should-never-reach-the-response",
              secret_ciphertext: "should-never-reach-the-response",
            },
          ];
        }
        return [];
      },
    });

    const response = await handleWebhooksRoute(request("/v1/webhooks", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(200);
    const text = await response!.text();
    expect(text).not.toContain("should-never-reach-the-response");
    expect(JSON.parse(text)).toEqual({
      webhooks: [
        {
          id: WHE_ONE,
          url: "https://example.com/hook",
          active: true,
          event_kinds: ["handoff.created"],
          created_at: 1_700_000_000,
        },
      ],
      next_cursor: null,
    });
    expect(statements.some((s) => s.sql.includes("webhooks:list-endpoints"))).toBe(true);
  });
});

// -- POST /v1/webhooks/{id}/disable --------------------------------------------------

describe("POST /v1/webhooks/{id}/disable", () => {
  function disableRequest(id: string): Request {
    return request(`/v1/webhooks/${id}/disable`, { method: "POST", headers: authed() });
  }

  it("requires the ingest capability", async () => {
    const { db } = mockDb({ first: authedFirst(undefined, { capabilities: "read" }) });
    const response = await handleWebhooksRoute(disableRequest(WHE_ONE), makeEnv(db));
    expect(response?.status).toBe(403);
  });

  it("disables an endpoint owned by the caller's workspace", async () => {
    const { db, statements } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("webhooks:disable-endpoint")) {
          const [id, workspaceId] = statement.binds;
          return workspaceId === TOKEN_WORKSPACE ? { id } : null;
        }
        return null;
      }),
    });
    const response = await handleWebhooksRoute(disableRequest(WHE_ONE), makeEnv(db));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true });
    const disable = statements.find((s) => s.sql.includes("webhooks:disable-endpoint"));
    expect(disable!.binds).toEqual([WHE_ONE, TOKEN_WORKSPACE]);
  });

  it("404s for an endpoint in a foreign workspace without leaking existence", async () => {
    const { db } = mockDb({
      first: authedFirst((statement) => {
        // A real WHERE workspace_id = ?2 clause would never match another
        // tenant's row; the fake mirrors that by always missing here.
        if (statement.sql.includes("webhooks:disable-endpoint")) return null;
        return null;
      }),
    });
    const response = await handleWebhooksRoute(disableRequest(WHE_ONE), makeEnv(db));
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "not found" });
  });
});

// -- POST /v1/webhooks/{id}/test -----------------------------------------------------

describe("POST /v1/webhooks/{id}/test", () => {
  function testRequest(id: string): Request {
    return request(`/v1/webhooks/${id}/test`, { method: "POST", headers: authed() });
  }

  it("404s for an unknown or foreign-workspace endpoint id", async () => {
    const { db } = mockDb({ first: authedFirst(() => null) });
    const response = await handleWebhooksRoute(testRequest(WHE_ONE), makeEnv(db), neverFetch);
    expect(response?.status).toBe(404);
  });

  it("fails closed with 503 when the sealing key is unset", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleWebhooksRoute(
      testRequest(WHE_ONE),
      makeEnv(db, { WEBHOOK_SEALING_KEY: undefined }),
      neverFetch,
    );
    expect(response?.status).toBe(503);
  });

  it("signs and posts a content-free ping through the shared delivery path", async () => {
    const rawSecret = "whsec_known-test-secret";
    const sealed = await sealWebhookSecret(rawSecret, SEALING_KEY);
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: FetchLike = async (url, init) => {
      captured = { url, init: init ?? {} };
      return new Response(null, { status: 200 });
    };
    const { db } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("webhooks:read-endpoint")) {
          return { id: WHE_ONE, url: "https://example.com/hook", active: 1, secret_ciphertext: sealed };
        }
        return null;
      }),
    });

    const response = await handleWebhooksRoute(testRequest(WHE_ONE), makeEnv(db), fakeFetch);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, response_status: 200 });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://example.com/hook");
    const headers = new Headers(captured!.init.headers as HeadersInit);
    expect(headers.get("x-handoffgraph-event")).toBe("webhook.test");
    expect(headers.get("content-type")).toContain("application/json");
    const signatureHeader = headers.get("x-handoffgraph-signature") ?? "";
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader);
    expect(match).not.toBeNull();
    const [, ts, sig] = match as RegExpExecArray;
    const expectedSig = await computeWebhookSignature(rawSecret, ts, captured!.init.body as string);
    expect(sig).toBe(expectedSig);
    const payload = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(payload.workspace_id).toBe(TOKEN_WORKSPACE);
    expect(payload.kind).toBe("webhook.test");
  });

  it("reports an unreachable endpoint as ok:false rather than a platform error", async () => {
    const sealed = await sealWebhookSecret("whsec_unreachable", SEALING_KEY);
    const { db } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("webhooks:read-endpoint")) {
          return { id: WHE_ONE, url: "https://example.com/hook", active: 1, secret_ciphertext: sealed };
        }
        return null;
      }),
    });
    const failingFetch: FetchLike = async () => {
      throw new Error("network unreachable");
    };
    const response = await handleWebhooksRoute(testRequest(WHE_ONE), makeEnv(db), failingFetch);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: false, response_status: null });
  });
});

// -- webhooksScheduled (sweep) --------------------------------------------------------

describe("webhooksScheduled (sweep)", () => {
  it("no-ops without touching D1 when the queue binding is unavailable", async () => {
    const { db, statements } = mockDb();
    await webhooksScheduled({ DB: db });
    expect(statements).toHaveLength(0);
  });

  it("filters by subscribed kind, enqueues one message per match, and advances the cursor past every scanned event", async () => {
    const sent: WebhookQueueMessage[] = [];
    const queue: QueueLike<WebhookQueueMessage> = {
      async send(message) {
        sent.push(message);
      },
    };
    const events = [
      { seq: 1, event_id: "evt_1", kind: "handoff.created", workstream_id: "ws_1", occurred_at: "2026-01-01T00:00:00Z" },
      { seq: 2, event_id: "evt_2", kind: "detection.recorded", workstream_id: "ws_1", occurred_at: "2026-01-01T00:00:01Z" },
      { seq: 3, event_id: "evt_3", kind: "handoff.created", workstream_id: null, occurred_at: "2026-01-01T00:00:02Z" },
    ];
    const { batches, db } = mockDb({
      all: (statement) => {
        if (statement.sql.includes("webhooks:sweep-active-workspaces")) {
          return [{ workspace_id: TOKEN_WORKSPACE }];
        }
        if (statement.sql.includes("webhooks:sweep-endpoints")) {
          return [{ id: WHE_ONE, event_kinds: JSON.stringify(["handoff.created"]) }];
        }
        if (statement.sql.includes("webhooks:sweep-events")) return events;
        return [];
      },
      first: (statement) => (statement.sql.includes("webhooks:sweep-cursor") ? null : null),
    });

    await webhooksScheduled({ DB: db, WEBHOOK_QUEUE: queue });

    expect(sent.map((m) => m.event_id)).toEqual(["evt_1", "evt_3"]);
    for (const message of sent) {
      expect(message.endpoint_id).toBe(WHE_ONE);
      expect(message.workspace_id).toBe(TOKEN_WORKSPACE);
    }

    expect(batches).toHaveLength(1);
    const insertDeliveries = batches[0].find((s) => s.sql.includes("webhooks:insert-deliveries"));
    const advanceCursor = batches[0].find((s) => s.sql.includes("webhooks:advance-cursor"));
    expect(insertDeliveries).toBeDefined();
    const deliveryRows = JSON.parse(insertDeliveries!.binds[0] as string) as Array<{ event_id: string }>;
    expect(deliveryRows.map((r) => r.event_id)).toEqual(["evt_1", "evt_3"]);
    // Advances past seq=2 too, even though no endpoint subscribed to its kind.
    expect(advanceCursor!.binds).toEqual([TOKEN_WORKSPACE, 3]);
  });

  it("keeps workspaces isolated: sweeping one never touches another's endpoints or events", async () => {
    const sent: WebhookQueueMessage[] = [];
    const queue: QueueLike<WebhookQueueMessage> = {
      async send(message) {
        sent.push(message);
      },
    };
    const { db } = mockDb({
      all: (statement) => {
        if (statement.sql.includes("webhooks:sweep-active-workspaces")) {
          return [{ workspace_id: TOKEN_WORKSPACE }, { workspace_id: OTHER_WORKSPACE }];
        }
        if (statement.sql.includes("webhooks:sweep-endpoints")) {
          const workspaceId = statement.binds[0];
          if (workspaceId === TOKEN_WORKSPACE) {
            return [{ id: WHE_ONE, event_kinds: JSON.stringify(["handoff.created"]) }];
          }
          if (workspaceId === OTHER_WORKSPACE) {
            return [{ id: WHE_TWO, event_kinds: JSON.stringify(["handoff.created"]) }];
          }
          return [];
        }
        if (statement.sql.includes("webhooks:sweep-events")) {
          const workspaceId = statement.binds[0];
          if (workspaceId === TOKEN_WORKSPACE) {
            return [
              { seq: 1, event_id: "evt_own", kind: "handoff.created", workstream_id: null, occurred_at: "2026-01-01T00:00:00Z" },
            ];
          }
          if (workspaceId === OTHER_WORKSPACE) {
            return [
              { seq: 1, event_id: "evt_other", kind: "handoff.created", workstream_id: null, occurred_at: "2026-01-01T00:00:00Z" },
            ];
          }
          return [];
        }
        return [];
      },
      first: () => null,
    });

    await webhooksScheduled({ DB: db, WEBHOOK_QUEUE: queue });

    expect(sent).toHaveLength(2);
    const own = sent.find((m) => m.workspace_id === TOKEN_WORKSPACE);
    const other = sent.find((m) => m.workspace_id === OTHER_WORKSPACE);
    expect(own).toMatchObject({ endpoint_id: WHE_ONE, event_id: "evt_own" });
    expect(other).toMatchObject({ endpoint_id: WHE_TWO, event_id: "evt_other" });
  });

  it("continues to the next workspace when one workspace's sweep throws", async () => {
    const sent: WebhookQueueMessage[] = [];
    const queue: QueueLike<WebhookQueueMessage> = {
      async send(message) {
        sent.push(message);
      },
    };
    const { db } = mockDb({
      all: (statement) => {
        if (statement.sql.includes("webhooks:sweep-active-workspaces")) {
          return [{ workspace_id: TOKEN_WORKSPACE }, { workspace_id: OTHER_WORKSPACE }];
        }
        if (statement.sql.includes("webhooks:sweep-endpoints")) {
          const workspaceId = statement.binds[0];
          if (workspaceId === TOKEN_WORKSPACE) throw new Error("boom");
          return [{ id: WHE_TWO, event_kinds: JSON.stringify(["handoff.created"]) }];
        }
        if (statement.sql.includes("webhooks:sweep-events")) {
          return [
            { seq: 1, event_id: "evt_other", kind: "handoff.created", workstream_id: null, occurred_at: "2026-01-01T00:00:00Z" },
          ];
        }
        return [];
      },
      first: () => null,
    });

    await expect(webhooksScheduled({ DB: db, WEBHOOK_QUEUE: queue })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.workspace_id).toBe(OTHER_WORKSPACE);
  });
});

// -- webhooksQueue (consumer) ---------------------------------------------------------

describe("webhooksQueue (consumer)", () => {
  const rawSecret = "whsec_consumer-test-secret";
  let sealed = "";

  beforeAll(async () => {
    sealed = await sealWebhookSecret(rawSecret, SEALING_KEY);
  });

  function queueMessage(overrides: Partial<WebhookQueueMessage> = {}): WebhookQueueMessage {
    return {
      delivery_id: WHD_ONE,
      workspace_id: TOKEN_WORKSPACE,
      endpoint_id: WHE_ONE,
      event_id: "evt_1",
      kind: "handoff.created",
      workstream_id: "ws_1",
      occurred_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  function batchOf(body: unknown, attempts: number): MessageBatchLike<unknown> {
    return { queue: "handoffgraph-webhooks", messages: [{ body, attempts }] };
  }

  function dbWithActiveEndpoint(active = 1) {
    return mockDb({
      first: (statement) => {
        if (statement.sql.includes("webhooks:read-endpoint")) {
          return { id: WHE_ONE, url: "https://example.com/hook", active, secret_ciphertext: sealed };
        }
        return null;
      },
    });
  }

  it("marks a 2xx response delivered and resolves without throwing", async () => {
    const { db, statements } = dbWithActiveEndpoint();
    const fakeFetch: FetchLike = async () => new Response(null, { status: 204 });

    await expect(
      webhooksQueue(batchOf(queueMessage(), 1), { DB: db, WEBHOOK_SEALING_KEY: SEALING_KEY }, fakeFetch),
    ).resolves.toBeUndefined();

    const update = statements.find((s) => s.sql.includes("webhooks:update-delivery-status"));
    expect(update).toBeDefined();
    const [deliveryId, workspaceId, status, responseStatus, attempt] = update!.binds;
    expect({ deliveryId, workspaceId, status, responseStatus, attempt }).toEqual({
      deliveryId: WHD_ONE,
      workspaceId: TOKEN_WORKSPACE,
      status: "delivered",
      responseStatus: 204,
      attempt: 1,
    });
  });

  it("rethrows on a non-2xx response with retries left and marks the row failed", async () => {
    const { db, statements } = dbWithActiveEndpoint();
    const fakeFetch: FetchLike = async () => new Response(null, { status: 500 });

    await expect(
      webhooksQueue(batchOf(queueMessage(), 1), { DB: db, WEBHOOK_SEALING_KEY: SEALING_KEY }, fakeFetch),
    ).rejects.toThrow();

    const update = statements.find((s) => s.sql.includes("webhooks:update-delivery-status"));
    const [, , status, responseStatus, attempt] = update!.binds;
    expect({ status, responseStatus, attempt }).toEqual({ status: "failed", responseStatus: 500, attempt: 1 });
  });

  it("marks the row dead on the final attempt but still rethrows so Queues can DLQ it", async () => {
    const { db, statements } = dbWithActiveEndpoint();
    const fakeFetch: FetchLike = async () => new Response(null, { status: 500 });

    await expect(
      webhooksQueue(
        batchOf(queueMessage(), MAX_DELIVERY_ATTEMPTS),
        { DB: db, WEBHOOK_SEALING_KEY: SEALING_KEY },
        fakeFetch,
      ),
    ).rejects.toThrow();

    const update = statements.find((s) => s.sql.includes("webhooks:update-delivery-status"));
    const [, , status, responseStatus, attempt] = update!.binds;
    expect({ status, responseStatus, attempt }).toEqual({
      status: "dead",
      responseStatus: 500,
      attempt: MAX_DELIVERY_ATTEMPTS,
    });
  });

  it("rethrows and marks failed when fetch itself throws (network error)", async () => {
    const { db, statements } = dbWithActiveEndpoint();
    const fakeFetch: FetchLike = async () => {
      throw new Error("network unreachable");
    };

    await expect(
      webhooksQueue(batchOf(queueMessage(), 1), { DB: db, WEBHOOK_SEALING_KEY: SEALING_KEY }, fakeFetch),
    ).rejects.toThrow();

    const update = statements.find((s) => s.sql.includes("webhooks:update-delivery-status"));
    expect(update!.binds[2]).toBe("failed");
  });

  it("signs the exact canonical content-free payload it sends", async () => {
    const { db } = dbWithActiveEndpoint();
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: FetchLike = async (url, init) => {
      captured = { url, init: init ?? {} };
      return new Response(null, { status: 200 });
    };

    await webhooksQueue(batchOf(queueMessage(), 1), { DB: db, WEBHOOK_SEALING_KEY: SEALING_KEY }, fakeFetch);

    expect(captured).not.toBeNull();
    const expectedBody = canonicalJsonStringify({
      event_id: "evt_1",
      kind: "handoff.created",
      workstream_id: "ws_1",
      occurred_at: "2026-01-01T00:00:00Z",
      workspace_id: TOKEN_WORKSPACE,
    });
    expect(captured!.init.body).toBe(expectedBody);
    const headers = new Headers(captured!.init.headers as HeadersInit);
    expect(headers.get("x-handoffgraph-event")).toBe("handoff.created");
    const signatureHeader = headers.get("x-handoffgraph-signature") ?? "";
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader);
    expect(match).not.toBeNull();
    const [, ts, sig] = match as RegExpExecArray;
    expect(sig).toBe(await computeWebhookSignature(rawSecret, ts, expectedBody));
  });

  it("marks a gone/disabled endpoint dead without throwing or calling fetch", async () => {
    const { db, statements } = mockDb({ first: () => null });
    let fetchCalled = false;
    const fakeFetch: FetchLike = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };

    await expect(
      webhooksQueue(batchOf(queueMessage(), 1), { DB: db, WEBHOOK_SEALING_KEY: SEALING_KEY }, fakeFetch),
    ).resolves.toBeUndefined();

    expect(fetchCalled).toBe(false);
    const update = statements.find((s) => s.sql.includes("webhooks:update-delivery-status"));
    expect(update!.binds[2]).toBe("dead");
  });

  it("drops a malformed message body without throwing or touching D1 status", async () => {
    const { db, statements } = mockDb();

    await expect(
      webhooksQueue(batchOf({ nonsense: true }, 1), { DB: db, WEBHOOK_SEALING_KEY: SEALING_KEY }),
    ).resolves.toBeUndefined();

    expect(statements.some((s) => s.sql.includes("webhooks:update-delivery-status"))).toBe(false);
  });
});

// -- migration 0007: CHECK constraints + triggers (node:sqlite) -----------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0007_webhooks.sql";
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

function insertEndpoint(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: WHE_ONE,
    workspace_id: TOKEN_WORKSPACE,
    url: "https://example.com/hook",
    secret_hash: HASH,
    secret_ciphertext: null,
    event_kinds: JSON.stringify(["handoff.created"]),
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO webhook_endpoints
      (id, workspace_id, url, secret_hash, secret_ciphertext, event_kinds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id as string,
    row.workspace_id as string,
    row.url as string,
    row.secret_hash as string,
    row.secret_ciphertext as string | null,
    row.event_kinds as string,
    row.created_at as number,
  );
}

function insertDelivery(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: WHD_ONE,
    workspace_id: TOKEN_WORKSPACE,
    endpoint_id: WHE_ONE,
    event_id: "evt_1",
    status: "queued",
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO webhook_deliveries (id, workspace_id, endpoint_id, event_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    row.id as string,
    row.workspace_id as string,
    row.endpoint_id as string,
    row.event_id as string,
    row.status as string,
    row.created_at as number,
  );
}

describe("0007 webhooks migration (node:sqlite)", () => {
  it("creates every webhook table", () => {
    const db = migratedDatabase();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    for (const table of ["webhook_endpoints", "webhook_deliveries", "webhook_cursors"]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it("accepts an https url and rejects everything else", () => {
    const db = migratedDatabase();
    expect(() => insertEndpoint(db, { url: "https://example.com/hook" })).not.toThrow();
    expect(() => insertEndpoint(db, { id: WHE_TWO, url: "http://example.com/hook" })).toThrow();
    db.close();
  });

  it("rejects event_kinds that are not a JSON array", () => {
    const db = migratedDatabase();
    expect(() => insertEndpoint(db, { event_kinds: "not-json" })).toThrow();
    expect(() => insertEndpoint(db, { id: WHE_TWO, event_kinds: JSON.stringify({ a: 1 }) })).toThrow();
    db.close();
  });

  it("rejects a malformed webhook endpoint id", () => {
    const db = migratedDatabase();
    expect(() => insertEndpoint(db, { id: "not_an_id" })).toThrow();
    expect(() => insertEndpoint(db, { id: `whe_${"9".repeat(26)}` })).toThrow(); // first char must be 0-7
    db.close();
  });

  it("requires workspace_id on every table", () => {
    const db = migratedDatabase();
    expect(() =>
      db.prepare(`
        INSERT INTO webhook_endpoints (id, url, secret_hash, event_kinds, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(WHE_ONE, "https://example.com/hook", HASH, JSON.stringify(["handoff.created"]), 1),
    ).toThrow();
    db.close();
  });

  it("requires a new webhook delivery to start queued", () => {
    const db = migratedDatabase();
    insertEndpoint(db);
    expect(() => insertDelivery(db, { status: "delivered" })).toThrow();
    db.close();
  });

  it("keeps delivered_at consistent with status via the composite CHECK", () => {
    const db = migratedDatabase();
    insertEndpoint(db);
    expect(() =>
      db.prepare(`
        INSERT INTO webhook_deliveries
          (id, workspace_id, endpoint_id, event_id, status, created_at, delivered_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)
      `).run(WHD_ONE, TOKEN_WORKSPACE, WHE_ONE, "evt_1", 1_700_000_000, 1_700_000_000),
    ).toThrow();
    db.close();
  });

  it("forbids reviving a terminal delivery status", () => {
    const db = migratedDatabase();
    insertEndpoint(db);
    insertDelivery(db);
    db.prepare(`
      UPDATE webhook_deliveries SET status = 'delivered', delivered_at = ? WHERE id = ?
    `).run(1_700_000_100, WHD_ONE);
    expect(() =>
      db.prepare(`UPDATE webhook_deliveries SET status = 'queued' WHERE id = ?`).run(WHD_ONE),
    ).toThrow();
    db.close();
  });

  it("enforces one delivery row per (endpoint_id, event_id)", () => {
    const db = migratedDatabase();
    insertEndpoint(db);
    insertDelivery(db);
    expect(() => insertDelivery(db, { id: `whd_01J${"D".repeat(23)}` })).toThrow();
    db.close();
  });

  it("rejects a webhook_cursors update that moves last_seq backward", () => {
    const db = migratedDatabase();
    db.prepare(`INSERT INTO webhook_cursors (workspace_id, last_seq) VALUES (?, ?)`).run(TOKEN_WORKSPACE, 10);
    expect(() =>
      db.prepare(`UPDATE webhook_cursors SET last_seq = ? WHERE workspace_id = ?`).run(5, TOKEN_WORKSPACE),
    ).toThrow();
    expect(() =>
      db.prepare(`UPDATE webhook_cursors SET last_seq = ? WHERE workspace_id = ?`).run(20, TOKEN_WORKSPACE),
    ).not.toThrow();
    db.close();
  });
});

// Sanity: DEFAULT_INTERESTING_KINDS is the exact set the SCOPE names.
describe("DEFAULT_INTERESTING_KINDS", () => {
  it("matches the specified set of interesting event kinds", () => {
    expect([...DEFAULT_INTERESTING_KINDS].sort()).toEqual(
      [
        "handoff.created",
        "handoff.accepted",
        "detection.recorded",
        "prompt.labeled",
        "verification.recorded",
        "alert.fired",
      ].sort(),
    );
  });
});
