import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/auth";

const CTX = {} as ExecutionContext;
const CONTROLLER = {
  scheduledTime: 0,
  cron: "*/5 * * * *",
  noRetry() {},
} as ScheduledController;
const DEVICE_TOKEN = `hfg_dev_${"x".repeat(40)}`;
const SESSION_TOKEN = `hfg_session_${"y".repeat(40)}`;
const WORKSPACE_ID = `wsp_01J${"A".repeat(23)}`;
const DEVICE_ID = `dev_01J${"B".repeat(23)}`;
const SESSION_ID = `acs_01J${"C".repeat(23)}`;
const USER_ID = `usr_01J${"D".repeat(23)}`;

function fencedEnv(surface: string | undefined = "basic") {
  return {
    HOSTED_SURFACE: surface,
    DB: {
      prepare(): never {
        throw new Error("advanced route touched D1 behind the Hosted Basic fence");
      },
      batch(): never {
        throw new Error("advanced route batched D1 behind the Hosted Basic fence");
      },
    },
  };
}

function maintenanceEnv(value: string) {
  const storageTouches: string[] = [];
  const touched = (operation: string): never => {
    storageTouches.push(operation);
    throw new Error(`maintenance fence reached ${operation}`);
  };
  return {
    storageTouches,
    env: {
      HOSTED_SURFACE: "advanced",
      HOSTED_MAINTENANCE: value,
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "key_test",
      WORKOS_REDIRECT_URI: "https://api.handoffgraph.dev/v1/auth/callback",
      DB: {
        prepare(): never { return touched("D1 prepare"); },
        batch(): never { return touched("D1 batch"); },
      },
      BODIES: {
        head(): never { return touched("R2 head"); },
        get(): never { return touched("R2 get"); },
        put(): never { return touched("R2 put"); },
        list(): never { return touched("R2 list"); },
        delete(): never { return touched("R2 delete"); },
      },
    },
  };
}

async function credentialEnv(
  surface: string | undefined,
  bodies: "missing" | "malformed",
) {
  const tokenHash = await sha256Hex(DEVICE_TOKEN);
  const now = Math.floor(Date.now() / 1_000);
  return {
    HOSTED_SURFACE: surface,
    ...(bodies === "malformed" ? { BODIES: {} } : {}),
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("auth:device-by-token")) {
              return {
                id: DEVICE_ID,
                workspace_id: WORKSPACE_ID,
                token_hash: tokenHash,
                capabilities: "ingest,read",
                revoked_at: null,
              };
            }
            if (sql.includes("FROM account_sessions AS s")) {
              return {
                session_id: SESSION_ID,
                user_id: USER_ID,
                csrf_hash: "c".repeat(64),
                email: "config-drift@example.test",
                display_name: "Config Drift",
                avatar_url: null,
                workspace_id: WORKSPACE_ID,
                workspace_name: "Config drift workspace",
                role: "owner",
                plan_id: "basic",
                plan_status: "active",
                max_devices: 2,
                active_devices: 1,
                max_device_issuances: 10,
                used_device_issuances: 1,
                max_monthly_events: 5_000,
                used_monthly_events: 0,
                max_monthly_bytes: 10_485_760,
                used_monthly_bytes: 0,
                max_lifetime_events: 25_000,
                used_lifetime_events: 0,
                max_lifetime_bytes: 67_108_864,
                used_lifetime_bytes: 0,
                period_start: now - 100,
                period_end: now + 3_600,
              };
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM workstreams")) {
              return { success: true, results: [] };
            }
            throw new Error("credential config test reached an unexpected D1 list");
          },
          async run() {
            throw new Error("credential config test reached an unexpected D1 write");
          },
        };
      },
      async batch(): Promise<never> {
        throw new Error("credential config test reached an unexpected D1 batch");
      },
    },
  } as never;
}

describe("Hosted Basic deployment surface", () => {
  it.each([undefined, "false"])(
    "serves normally when HOSTED_MAINTENANCE is %s",
    async (maintenance) => {
      const env = { ...fencedEnv(), HOSTED_MAINTENANCE: maintenance };
      const health = await worker.fetch(
        new Request("https://api.handoffgraph.dev/healthz"),
        env,
        CTX,
      );
      const plans = await worker.fetch(
        new Request("https://api.handoffgraph.dev/v1/plans"),
        env,
        CTX,
      );

      expect(health.status).toBe(200);
      expect(health.headers.get("x-handoffgraph-maintenance")).toBeNull();
      expect(plans.status).toBe(200);
    },
  );

  it.each(["true", "", "TRUE", "1", "off", "false "])(
    "keeps versioned liveness available when HOSTED_MAINTENANCE is %j",
    async (maintenance) => {
      const { env, storageTouches } = maintenanceEnv(maintenance);
      const response = await worker.fetch(
        new Request("https://api.handoffgraph.dev/healthz"),
        {
          ...env,
          CF_VERSION_METADATA: {
            id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
            tag: "git-maintenance",
            timestamp: "2026-08-31T12:00:00.000Z",
          },
        } as never,
        CTX,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-handoffgraph-maintenance")).toBe("true");
      expect(response.headers.get("x-handoffgraph-worker-version"))
        .toBe("095f00a7-23a7-43b7-a227-e4c97cab5f22");
      expect(response.headers.get("x-handoffgraph-worker-tag")).toBe("git-maintenance");
      await expect(response.json()).resolves.toEqual({ status: "ok" });
      expect(storageTouches).toEqual([]);
    },
  );

  it.each(["true", "", "TRUE", "1", "off", "false "])(
    "returns one storage-free 503 fence when HOSTED_MAINTENANCE is %j",
    async (maintenance) => {
      const { env, storageTouches } = maintenanceEnv(maintenance);
      const requests = [
        new Request("https://api.handoffgraph.dev/"),
        new Request("https://api.handoffgraph.dev/account", {
          headers: { cookie: `__Host-hfg_session=${SESSION_TOKEN}` },
        }),
        new Request("https://api.handoffgraph.dev/v1/plans"),
        new Request("https://api.handoffgraph.dev/v1/auth/start"),
        new Request("https://api.handoffgraph.dev/v1/me", {
          headers: { cookie: `__Host-hfg_session=${SESSION_TOKEN}` },
        }),
        new Request("https://api.handoffgraph.dev/v1/event-batches", {
          method: "POST",
          headers: {
            authorization: `Bearer ${DEVICE_TOKEN}`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
        new Request("https://api.handoffgraph.dev/v1/workstreams", {
          headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
        }),
        new Request("https://api.handoffgraph.dev/v1/shared/dashboards/token"),
        new Request("https://api.handoffgraph.dev/not-a-route"),
        new Request("https://api.handoffgraph.dev/healthz", { method: "POST" }),
      ];

      for (const request of requests) {
        const response = await worker.fetch(request, env as never, CTX);
        expect(response.status, `${request.method} ${new URL(request.url).pathname}`).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("retry-after")).toBe("60");
        expect(response.headers.get("x-handoffgraph-maintenance")).toBe("true");
        await expect(response.json()).resolves.toEqual({
          error: "service unavailable",
          code: "hosted_maintenance",
        });
      }
      expect(storageTouches).toEqual([]);
    },
  );

  it("keeps public liveness and plan metadata available", async () => {
    const health = await worker.fetch(
      new Request("https://api.handoffgraph.dev/healthz"),
      fencedEnv(),
      CTX,
    );
    const plans = await worker.fetch(
      new Request("https://api.handoffgraph.dev/v1/plans"),
      fencedEnv(),
      CTX,
    );

    expect(health.status).toBe(200);
    expect(plans.status).toBe(200);
  });

  it.each(
    [undefined, "", "basic", "basci", "ADVANCED", "advanced"].flatMap((surface) =>
      (["missing", "malformed"] as const).map((bodies) => [surface, bodies] as const)),
  )(
    "denies valid browser and device credentials when surface=%s and BODIES=%s",
    async (surface, bodies) => {
      const env = await credentialEnv(surface, bodies);
      const browser = await worker.fetch(
        new Request("https://api.handoffgraph.dev/v1/me", {
          headers: { cookie: `__Host-hfg_session=${SESSION_TOKEN}` },
        }),
        env,
        CTX,
      );
      const device = await worker.fetch(
        new Request("https://api.handoffgraph.dev/v1/workstreams", {
          headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
        }),
        env,
        CTX,
      );

      expect(browser.status).toBe(401);
      await expect(browser.json()).resolves.toEqual({ error: "unauthorized" });
      expect(device.status).toBe(401);
      await expect(device.json()).resolves.toEqual({ error: "unauthorized" });
    },
  );

  it("falls back to the account page instead of looping on a same-origin landing", async () => {
    const staging = await worker.fetch(
      new Request("https://handoffgraph-api-staging.arbaz-khan.workers.dev/"),
      {
        ...fencedEnv(),
        LANDING_ORIGIN: "https://handoffgraph-api-staging.arbaz-khan.workers.dev",
      },
      CTX,
    );
    expect(staging.status).toBe(303);
    expect(staging.headers.get("location")).toBe("/account");

    const production = await worker.fetch(
      new Request("https://api.handoffgraph.dev/"),
      { ...fencedEnv(), LANDING_ORIGIN: "https://handoffgraph.dev" },
      CTX,
    );
    expect(production.status).toBe(303);
    expect(production.headers.get("location")).toBe("https://handoffgraph.dev/");
  });

  it.each([
    ["GET", "/v1/workspace/members"],
    ["POST", "/v1/exports"],
    ["POST", "/v1/attachments"],
    ["GET", "/v1/webhooks"],
    ["GET", "/v1/dashboards"],
    ["GET", "/v1/alerts"],
    ["GET", "/v1/gateway/keys"],
    ["GET", "/v1/api-keys"],
    ["POST", "/v1/mcp"],
    ["GET", "/v1/sessions"],
    ["GET", "/v1/analytics/summary"],
    ["GET", "/v1/prompts"],
    ["GET", "/v1/simulations"],
    ["GET", "/v1/evals"],
    ["GET", "/v1/annotation-queues"],
    ["POST", "/v1/playground/run"],
    ["GET", "/v1/ee/audit"],
    ["POST", "/v1/otlp"],
  ])("returns 404 for unreleased %s %s without touching storage", async (method, path) => {
    const response = await worker.fetch(
      new Request(`https://api.handoffgraph.dev${path}`, { method }),
      fencedEnv(),
      CTX,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });

  it.each([undefined, "", "basci", "ADVANCED"])(
    "fails closed when HOSTED_SURFACE is %s",
    async (surface) => {
      const response = await worker.fetch(
        new Request("https://api.handoffgraph.dev/v1/attachments", { method: "POST" }),
        fencedEnv(surface),
        CTX,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not found" });
    },
  );

  it.each([undefined, "", "basic", "basci", "ADVANCED"])(
    "runs privacy deletion but no object-producing cron when HOSTED_SURFACE is %s",
    async (surface) => {
      const statements: string[] = [];
      const env = {
        HOSTED_SURFACE: surface,
        DB: {
          prepare(sql: string) {
            statements.push(sql);
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() { return null; },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
          async batch() { return []; },
        },
        BODIES: {
          async put(): Promise<never> {
            throw new Error("Hosted Basic cron attempted an R2 write");
          },
          async get() { return null; },
          async delete() {},
          async list(): Promise<never> {
            throw new Error("Hosted Basic cron attempted an R2 list");
          },
        },
      };

      await worker.scheduled(CONTROLLER, env as never, CTX);

      expect(statements.some((sql) => sql.includes("account-deletion:due"))).toBe(true);
      expect(statements.some((sql) => sql.includes("artifacts:compaction-candidates"))).toBe(false);
      expect(statements.some((sql) => sql.includes("artifacts:retention-policies"))).toBe(false);
    },
  );

  it.each(["true", "", "TRUE", "1", "off", "false "])(
    "suppresses every scheduled storage sweep when HOSTED_MAINTENANCE is %j",
    async (maintenance) => {
      const { env, storageTouches } = maintenanceEnv(maintenance);

      await expect(worker.scheduled(CONTROLLER, env as never, CTX)).resolves.toBeUndefined();

      expect(storageTouches).toEqual([]);
    },
  );

  it("rejects queue delivery at the code boundary without touching storage", async () => {
    const batch = {
      queue: "handoffgraph-webhooks",
      messages: [{
        body: {
          delivery_id: "whd_01JAAAAAAAAAAAAAAAAAAAAAAA",
          workspace_id: "wsp_01JAAAAAAAAAAAAAAAAAAAAAAA",
          endpoint_id: "whe_01JAAAAAAAAAAAAAAAAAAAAAAA",
          event_id: "evt_01JAAAAAAAAAAAAAAAAAAAAAAA",
          kind: "handoff.created",
          workstream_id: null,
          occurred_at: "2026-08-30T00:00:00Z",
        },
        attempts: 1,
        ack() {},
        retry() {},
      }],
      ackAll() {},
      retryAll() {},
    } as never;

    await expect(worker.queue(batch, fencedEnv() as never, CTX)).resolves.toBeUndefined();
  });

  it.each(["true", "", "TRUE", "1", "off", "false "])(
    "retries queued work without storage access when HOSTED_MAINTENANCE is %j",
    async (maintenance) => {
      const { env, storageTouches } = maintenanceEnv(maintenance);
      let retryAllCalls = 0;
      const batch = {
        queue: "handoffgraph-webhooks",
        messages: [],
        ackAll(): never { throw new Error("maintenance queue acknowledged work"); },
        retryAll() { retryAllCalls += 1; },
      } as never;

      await expect(worker.queue(batch, env as never, CTX)).resolves.toBeUndefined();

      expect(retryAllCalls).toBe(1);
      expect(storageTouches).toEqual([]);
    },
  );
});
