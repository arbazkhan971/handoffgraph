// Unit tests for src/dashboards.ts: the fail-closed config validator, the
// HTTP surface over a mocked D1, the unauthenticated share-link boundary —
// plus a node:sqlite pass proving migration 0008's CHECK constraints and
// immutability triggers hold, and a CI dry-run over the config committed to
// deploy/dashboards/ (parity rows 39, 40).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import {
  DASHBOARD_ID_PATTERN,
  DASHBOARD_SCHEMA_VERSION,
  GRID_COLUMNS,
  MAX_CONFIG_BYTES,
  MAX_VARIABLES,
  MAX_WIDGETS,
  SHARE_TOKEN_PATTERN,
  handleDashboardsRoute,
  newShareToken,
  validateDashboardConfig,
  type DashboardsEnv,
} from "../src/dashboards";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { canonicalJsonStringify } from "../src/ingest";

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
          return ((await handlers.first?.(statement)) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: ((await handlers.all?.(statement)) ?? []) as T[] };
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
const DSH_ONE = `dsh_01J${"A".repeat(23)}`;
const DSH_TWO = `dsh_01J${"B".repeat(23)}`;

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

function makeEnv(db: D1DatabaseLike, overrides: Partial<DashboardsEnv> = {}): DashboardsEnv {
  return { DB: db, APP_ORIGIN: "https://api.handoffgraph.dev", ...overrides };
}

/** A minimal valid config; `patch` mutates the deep-cloned copy in place. */
function baseConfig(patch: (config: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    schema: DASHBOARD_SCHEMA_VERSION,
    name: "Test dashboard",
    variables: [{ name: "window", default: "-24h" }],
    widgets: [
      {
        id: "events",
        title: "Events over time",
        type: "series",
        query: {
          source: "events",
          metric: "count",
          interval: "1h",
          since: "$window",
        },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
  };
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  patch(clone);
  return clone;
}

function errorPaths(result: ReturnType<typeof validateDashboardConfig>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.path);
}

// ============================================================================
// 1. Validator matrix
// ============================================================================

describe("validateDashboardConfig — acceptance", () => {
  it("accepts a minimal config and returns canonical bytes", () => {
    const result = validateDashboardConfig(baseConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonical).toBe(canonicalJsonStringify(result.config));
    expect(result.byteLength).toBe(new TextEncoder().encode(result.canonical).byteLength);
    // Canonical means sorted keys: `name` precedes `schema` precedes
    // `variables` precedes `widgets`.
    expect(result.canonical.startsWith('{"name":')).toBe(true);
  });

  it("is a pure function: the same document always yields the same bytes", () => {
    const a = validateDashboardConfig(baseConfig());
    const b = validateDashboardConfig(baseConfig());
    expect(a.ok && b.ok && a.canonical === b.canonical).toBe(true);
  });

  it("canonicalizes away input key order, so two orderings hash identically", () => {
    const reordered = {
      widgets: baseConfig().widgets,
      variables: baseConfig().variables,
      name: "Test dashboard",
      schema: DASHBOARD_SCHEMA_VERSION,
    };
    const a = validateDashboardConfig(baseConfig());
    const b = validateDashboardConfig(reordered);
    expect(a.ok && b.ok && a.canonical === b.canonical).toBe(true);
  });

  it("canonicalizes NESTED key order too — layout, query and filters", () => {
    // Two authors writing the same dashboard by hand, one typing layout as
    // h/w/x/y and the other as x/y/w/h, must produce the same digest. The
    // validator earns this by REBUILDING the document from validated parts
    // rather than echoing the caller's object, so no input ordering — at any
    // depth — survives into the stored bytes.
    const shuffled = baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      widget.layout = { h: 4, w: 6, x: 0, y: 0 };
      widget.query = { since: "$window", interval: "1h", metric: "count", source: "events" };
    });
    const a = validateDashboardConfig(baseConfig());
    const b = validateDashboardConfig(shuffled);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(baseConfig()));
    expect(b.canonical).toBe(a.canonical);
  });

  it("canonicalizes filter maps, so filter ordering never changes the digest", () => {
    const withFilters = (order: string[]) =>
      baseConfig((c) => {
        const widget = (c.widgets as Record<string, unknown>[])[0];
        const filters: Record<string, string> = {};
        for (const key of order) filters[key] = key;
        (widget.query as Record<string, unknown>).filters = filters;
      });
    const a = validateDashboardConfig(withFilters(["kind", "provider", "status"]));
    const b = validateDashboardConfig(withFilters(["status", "kind", "provider"]));
    expect(a.ok && b.ok && a.canonical === b.canonical).toBe(true);
  });

  it("accepts every widget type with its required query shape", () => {
    const config = baseConfig((c) => {
      c.widgets = [
        {
          id: "a-series",
          title: "Series",
          type: "series",
          query: { source: "observations", metric: "count", interval: "5m" },
          layout: { x: 0, y: 0, w: 3, h: 3 },
        },
        {
          id: "b-summary",
          title: "Summary",
          type: "summary",
          query: { source: "observations", metric: "error_rate" },
          layout: { x: 3, y: 0, w: 3, h: 3 },
        },
        {
          id: "c-funnel",
          title: "Funnel",
          type: "funnel",
          query: {
            source: "observations",
            metric: "count",
            steps: [{ name: "one" }, { name: "two", filters: { kind: "tool" } }],
          },
          layout: { x: 6, y: 0, w: 3, h: 3 },
        },
        {
          id: "d-table",
          title: "Table",
          type: "table",
          query: { source: "observations", metric: "p95_duration_ms", group_by: "tool_name" },
          layout: { x: 9, y: 0, w: 3, h: 3 },
        },
      ];
    });
    expect(validateDashboardConfig(config).ok).toBe(true);
  });
});

describe("validateDashboardConfig — unknown keys are rejected, never ignored", () => {
  it("rejects an unknown top-level key", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.refreshInterval = 60;
    }));
    expect(result.ok).toBe(false);
    expect(errorPaths(result)).toContain("refreshInterval");
  });

  it("rejects an unknown widget key", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      (c.widgets as Record<string, unknown>[])[0].color = "red";
    }));
    expect(errorPaths(result)).toContain("widgets[0].color");
  });

  it("rejects an unknown query key", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      (widget.query as Record<string, unknown>).sql = "SELECT 1";
    }));
    expect(errorPaths(result)).toContain("widgets[0].query.sql");
  });

  it("rejects an unknown layout key (a typo'd width is a real layout change)", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      (widget.layout as Record<string, unknown>).width = 6;
    }));
    expect(errorPaths(result)).toContain("widgets[0].layout.width");
  });

  it("rejects an unknown filter key", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      (widget.query as Record<string, unknown>).filters = { repo: "handoffgraph" };
    }));
    expect(errorPaths(result)).toContain("widgets[0].query.filters.repo");
  });

  it("rejects an unknown variable key", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.variables = [{ name: "window", default: "-24h", label: "Window" }];
    }));
    expect(errorPaths(result)).toContain("variables[0].label");
  });
});

describe("validateDashboardConfig — identity and bounds", () => {
  it("rejects a duplicate widget id", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widgets = c.widgets as Record<string, unknown>[];
      widgets.push(JSON.parse(JSON.stringify(widgets[0])) as Record<string, unknown>);
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("duplicate widget id"))).toBe(true);
  });

  it("rejects a widget id that is not lowercase kebab-case", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      (c.widgets as Record<string, unknown>[])[0].id = "Events_1";
    }));
    expect(errorPaths(result)).toContain("widgets[0].id");
  });

  it("rejects a duplicate variable name", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.variables = [
        { name: "window", default: "-24h" },
        { name: "window", default: "-1h" },
      ];
    }));
    expect(errorPaths(result)).toContain("variables[1].name");
  });

  it(`rejects more than ${MAX_WIDGETS} widgets`, () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.widgets = Array.from({ length: MAX_WIDGETS + 1 }, (_, index) => ({
        id: `w-${index}`,
        title: `Widget ${index}`,
        type: "summary",
        query: { source: "observations", metric: "count" },
        layout: { x: 0, y: index, w: 12, h: 1 },
      }));
    }));
    expect(errorPaths(result)).toContain("widgets");
  });

  it(`rejects more than ${MAX_VARIABLES} variables`, () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.variables = Array.from({ length: MAX_VARIABLES + 1 }, (_, index) => ({
        name: `v${index}`,
        default: "",
      }));
    }));
    expect(errorPaths(result)).toContain("variables");
  });

  it("rejects an empty widget list", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.widgets = [];
    }));
    expect(errorPaths(result)).toContain("widgets");
  });

  it(`rejects a config whose canonical encoding exceeds ${MAX_CONFIG_BYTES} bytes`, () => {
    const filler = "x".repeat(250);
    const config = baseConfig((c) => {
      c.widgets = Array.from({ length: MAX_WIDGETS }, (_, index) => ({
        id: `w-${index}`,
        title: `Widget ${index}`,
        type: "summary",
        query: {
          source: "observations",
          metric: "count",
          filters: {
            agent: filler,
            fingerprint: filler,
            has: filler,
            kind: filler,
            model: filler,
            provider: filler,
            session: filler,
            status: filler,
            tool: filler,
            workstream: filler,
          },
        },
        layout: { x: 0, y: index, w: 12, h: 1 },
      }));
    });
    // Under every per-field limit, over the document limit: the size rule has
    // to be about the whole document, not any one field.
    expect(canonicalJsonStringify(config).length).toBeGreaterThan(MAX_CONFIG_BYTES);
    const result = validateDashboardConfig(config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain(`limit is ${MAX_CONFIG_BYTES}`);
  });

  it("rejects a widget that overflows the grid", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      (c.widgets as Record<string, unknown>[])[0].layout = { x: 8, y: 0, w: 6, h: 4 };
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes(`${GRID_COLUMNS}-column grid`))).toBe(true);
  });

  it("rejects non-integer and out-of-range layout values", () => {
    for (const layout of [
      { x: 0.5, y: 0, w: 6, h: 4 },
      { x: -1, y: 0, w: 6, h: 4 },
      { x: 0, y: 0, w: 0, h: 4 },
      { x: 0, y: 0, w: 6, h: 999 },
    ]) {
      const result = validateDashboardConfig(baseConfig((c) => {
        (c.widgets as Record<string, unknown>[])[0].layout = layout;
      }));
      expect(result.ok).toBe(false);
    }
  });
});

describe("validateDashboardConfig — query shapes", () => {
  it("rejects an unknown source, metric, interval and group_by", () => {
    for (const [key, value] of [
      ["source", "postgres"],
      ["metric", "vibes"],
      ["interval", "7m"],
      ["group_by", "hostname"],
    ] as const) {
      const result = validateDashboardConfig(baseConfig((c) => {
        const widget = (c.widgets as Record<string, unknown>[])[0];
        (widget.query as Record<string, unknown>)[key] = value;
      }));
      expect(errorPaths(result)).toContain(`widgets[0].query.${key}`);
    }
  });

  it("requires interval on a series widget", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      delete (widget.query as Record<string, unknown>).interval;
    }));
    expect(errorPaths(result)).toContain("widgets[0].query.interval");
  });

  it("forbids interval on a summary widget rather than ignoring it", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      widget.type = "summary";
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("not allowed on a summary widget"))).toBe(true);
  });

  it("requires group_by on a table widget", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      widget.type = "table";
      delete (widget.query as Record<string, unknown>).interval;
    }));
    expect(errorPaths(result)).toContain("widgets[0].query.group_by");
  });

  it("requires 2..8 steps on a funnel and forbids a non-count metric", () => {
    const tooFew = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      widget.type = "funnel";
      widget.query = { source: "observations", metric: "count", steps: [{ name: "only" }] };
    }));
    expect(errorPaths(tooFew)).toContain("widgets[0].query.steps");

    const wrongMetric = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      widget.type = "funnel";
      widget.query = {
        source: "observations",
        metric: "token_in",
        steps: [{ name: "one" }, { name: "two" }],
      };
    }));
    expect(errorPaths(wrongMetric)).toContain("widgets[0].query.metric");
  });

  it("rejects duplicate funnel step names", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      widget.type = "funnel";
      widget.query = {
        source: "observations",
        metric: "count",
        steps: [{ name: "same" }, { name: "same" }],
      };
    }));
    expect(errorPaths(result)).toContain("widgets[0].query.steps[1].name");
  });

  it("rejects a time bound that is neither RFC 3339, relative, nor a variable", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      (widget.query as Record<string, unknown>).since = "yesterday";
    }));
    expect(errorPaths(result)).toContain("widgets[0].query.since");
  });

  it("accepts RFC 3339 and relative time bounds", () => {
    for (const since of ["2026-08-28T00:00:00Z", "2026-08-28T00:00:00.123+05:30", "-7d", "-30m"]) {
      const result = validateDashboardConfig(baseConfig((c) => {
        const widget = (c.widgets as Record<string, unknown>[])[0];
        (widget.query as Record<string, unknown>).since = since;
      }));
      expect(result.ok).toBe(true);
    }
  });

  it("rejects a reference to an undeclared variable", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.variables = [];
      const widget = (c.widgets as Record<string, unknown>[])[0];
      (widget.query as Record<string, unknown>).since = "$window";
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("undeclared variable $window"))).toBe(true);
  });

  it("rejects a limit outside 1..1000", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      const widget = (c.widgets as Record<string, unknown>[])[0];
      (widget.query as Record<string, unknown>).limit = 5000;
    }));
    expect(errorPaths(result)).toContain("widgets[0].query.limit");
  });
});

describe("validateDashboardConfig — document shape", () => {
  it("rejects a non-object document", () => {
    for (const doc of [null, 42, "config", [], true]) {
      const result = validateDashboardConfig(doc);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a wrong or missing schema marker", () => {
    for (const schema of [undefined, "hfg.dashboard.v2", 1]) {
      const result = validateDashboardConfig(baseConfig((c) => {
        if (schema === undefined) delete c.schema;
        else c.schema = schema;
      }));
      expect(errorPaths(result)).toContain("schema");
    }
  });

  it("requires variables explicitly, so an omission is never a silent []", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      delete c.variables;
    }));
    expect(errorPaths(result)).toContain("variables");
  });

  it("reports errors sorted by path, so CI output is deterministic", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.zzz = 1;
      c.aaa = 1;
      delete c.name;
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((e) => e.path);
    expect([...paths].sort()).toEqual(paths);
  });

  it("says so when the error list is truncated, rather than capping silently", () => {
    // 24 widgets that are each wrong several ways produce well over the cap.
    const result = validateDashboardConfig(baseConfig((c) => {
      c.widgets = Array.from({ length: MAX_WIDGETS }, () => ({
        id: "NOT KEBAB",
        title: 5,
        type: "gauge",
        query: { source: "redis", metric: "vibes", nope: 1 },
        layout: { x: -1, y: -1, w: 0, h: 0 },
      }));
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const last = result.errors[result.errors.length - 1];
    expect(last.message).toMatch(/further errors were not reported$/);
    // The notice is appended after the sorted list, so a reader can tell the
    // difference between "these are all the errors" and "these are the first
    // N".
    const sortedPart = result.errors.slice(0, -1).map((e) => e.path);
    expect([...sortedPart].sort()).toEqual(sortedPart);
  });

  it("stops early instead of validating an absurdly long widget list", () => {
    const result = validateDashboardConfig(baseConfig((c) => {
      c.widgets = Array.from({ length: 5_000 }, () => ({ nonsense: true }));
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // One error about the count — not 5,000 about the entries.
    expect(result.errors).toEqual([
      { path: "widgets", message: `must contain at most ${MAX_WIDGETS} widgets` },
    ]);
  });
});

// ============================================================================
// 2. HTTP surface
// ============================================================================

describe("routing", () => {
  it("returns null for paths this module does not own", async () => {
    const { db } = mockDb();
    const response = await handleDashboardsRoute(request("/v1/workstreams"), makeEnv(db));
    expect(response).toBeNull();
  });

  it("returns null (index.ts answers 404) for a wrong method on an owned path", async () => {
    const { db } = mockDb();
    for (const [path, method] of [
      ["/v1/dashboards", "DELETE"],
      ["/v1/dashboards/validate", "GET"],
      [`/v1/dashboards/${DSH_ONE}`, "POST"],
      [`/v1/dashboards/${DSH_ONE}/versions`, "GET"],
      [`/v1/dashboards/${DSH_ONE}/shares`, "GET"],
      [`/v1/shared/dashboards/${newShareToken()}`, "POST"],
    ] as const) {
      const response = await handleDashboardsRoute(request(path, { method }), makeEnv(db));
      expect(response).toBeNull();
    }
  });

  it("does not treat /v1/dashboards/validate as a dashboard id", async () => {
    const { db, statements } = mockDb({ first: authedFirst() });
    const response = await handleDashboardsRoute(
      request("/v1/dashboards/validate", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(200);
    expect(statements.some((s) => s.sql.includes("dashboards:read-dashboard"))).toBe(false);
  });
});

describe("POST /v1/dashboards/validate (CI dry-run)", () => {
  it("returns 200 with the digest and widget count for a valid config", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const config = baseConfig();
    const response = await handleDashboardsRoute(
      request("/v1/dashboards/validate", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(200);
    const body = await response!.json<Record<string, unknown>>();
    const validated = validateDashboardConfig(config);
    expect(body.valid).toBe(true);
    expect(body.widget_count).toBe(1);
    expect(body.content_sha256).toBe(await sha256Hex(validated.ok ? validated.canonical : ""));
  });

  it("returns 400 with precise error paths for an invalid config", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleDashboardsRoute(
      request("/v1/dashboards/validate", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig((c) => { c.oops = true; }) }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(400);
    const body = await response!.json<{ valid: boolean; errors: { path: string }[] }>();
    expect(body.valid).toBe(false);
    expect(body.errors.map((e) => e.path)).toContain("oops");
  });

  it("writes nothing: no dashboard or version statement is ever prepared", async () => {
    const { db, statements, batches } = mockDb({ first: authedFirst() });
    await handleDashboardsRoute(
      request("/v1/dashboards/validate", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(batches).toHaveLength(0);
    expect(statements.every((s) => !s.sql.includes("INSERT") && !s.sql.includes("UPDATE"))).toBe(true);
  });

  it("requires the read capability", async () => {
    const { db } = mockDb({ first: authedFirst(() => null, { capabilities: "ingest" }) });
    const response = await handleDashboardsRoute(
      request("/v1/dashboards/validate", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(403);
  });

  it("rejects an unauthenticated call", async () => {
    const { db } = mockDb();
    const response = await handleDashboardsRoute(
      request("/v1/dashboards/validate", {
        method: "POST",
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(401);
  });
});

describe("POST /v1/dashboards", () => {
  it("stores version 1 with canonical bytes and the digest of those bytes", async () => {
    const { db, batches } = mockDb({ first: authedFirst() });
    const config = baseConfig();
    const response = await handleDashboardsRoute(
      request("/v1/dashboards", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ name: "Test dashboard", config }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(201);
    const body = await response!.json<{ dashboard: Record<string, unknown> }>();
    expect(body.dashboard.version).toBe(1);
    expect(DASHBOARD_ID_PATTERN.test(body.dashboard.id as string)).toBe(true);

    expect(batches).toHaveLength(1);
    const [dashboardInsert, versionInsert] = batches[0];
    expect(dashboardInsert.sql).toContain("dashboards:insert-dashboard");
    expect(dashboardInsert.binds[1]).toBe(TOKEN_WORKSPACE);
    expect(versionInsert.sql).toContain("dashboards:insert-version");
    expect(versionInsert.binds[2]).toBe(1);

    const validated = validateDashboardConfig(config);
    expect(versionInsert.binds[3]).toBe(validated.ok ? validated.canonical : "");
    expect(versionInsert.binds[4]).toBe(await sha256Hex(validated.ok ? validated.canonical : ""));
    expect(versionInsert.binds[4]).toBe(body.dashboard.content_sha256);
    expect(versionInsert.binds[5]).toBe(DEVICE_ID);
  });

  it("commits the dashboard row and version 1 in one batch", async () => {
    const { db, batches } = mockDb({ first: authedFirst() });
    await handleDashboardsRoute(
      request("/v1/dashboards", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(batches[0]).toHaveLength(2);
  });

  it("rejects a name that disagrees with config.name", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleDashboardsRoute(
      request("/v1/dashboards", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ name: "Something else", config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects an invalid config before touching the database", async () => {
    const { db, batches } = mockDb({ first: authedFirst() });
    const response = await handleDashboardsRoute(
      request("/v1/dashboards", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: { schema: "hfg.dashboard.v1" } }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it("requires the ingest capability", async () => {
    const { db } = mockDb({ first: authedFirst(() => null, { capabilities: "read" }) });
    const response = await handleDashboardsRoute(
      request("/v1/dashboards", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(403);
  });
});

describe("POST /v1/dashboards/{id}/versions", () => {
  function versionEnv(latestVersion: number | null, name = "Test dashboard") {
    return mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("dashboards:read-dashboard")) {
          return statement.binds[0] === TOKEN_WORKSPACE
            ? { id: DSH_ONE, name, created_at: 1_700_000_000 }
            : null;
        }
        if (statement.sql.includes("dashboards:latest-version")) return { version: latestVersion };
        return null;
      }),
    });
  }

  it("appends the next dense version", async () => {
    const { db, statements } = versionEnv(3);
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(201);
    const body = await response!.json<{ dashboard: { version: number } }>();
    expect(body.dashboard.version).toBe(4);
    const insert = statements.find((s) => s.sql.includes("dashboards:insert-version"));
    expect(insert?.binds[2]).toBe(4);
  });

  it("rejects a config whose name does not match the dashboard", async () => {
    const { db } = versionEnv(1, "Original name");
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(400);
  });

  it("404s for a dashboard in another workspace", async () => {
    const { db } = mockDb({
      first: authedFirst((statement) => {
        // The read is workspace-scoped, so a foreign row simply is not found.
        if (statement.sql.includes("dashboards:read-dashboard")) return null;
        return null;
      }, { workspace_id: OTHER_WORKSPACE }),
    });
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(404);
  });

  it("answers 409 when a concurrent writer already claimed the version", async () => {
    let latest = 1;
    const { db } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("dashboards:read-dashboard")) {
          return { id: DSH_ONE, name: "Test dashboard", created_at: 1 };
        }
        if (statement.sql.includes("dashboards:latest-version")) return { version: latest };
        return null;
      }),
      run(statement) {
        if (statement.sql.includes("dashboards:insert-version")) {
          latest = 2; // the winner landed while this writer was preparing
          throw new Error("UNIQUE constraint failed");
        }
      },
    });
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ config: baseConfig() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(409);
  });

  it("rethrows a write failure that is not a version conflict", async () => {
    const { db } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("dashboards:read-dashboard")) {
          return { id: DSH_ONE, name: "Test dashboard", created_at: 1 };
        }
        if (statement.sql.includes("dashboards:latest-version")) return { version: 1 };
        return null;
      }),
      run(statement) {
        if (statement.sql.includes("dashboards:insert-version")) throw new Error("D1_ERROR: disk");
      },
    });
    await expect(
      handleDashboardsRoute(
        request(`/v1/dashboards/${DSH_ONE}/versions`, {
          method: "POST",
          headers: authed(),
          body: JSON.stringify({ config: baseConfig() }),
        }),
        makeEnv(db),
      ),
    ).rejects.toThrow("D1_ERROR");
  });
});

describe("GET /v1/dashboards", () => {
  it("returns an {items, next_cursor} envelope sorted deterministically", async () => {
    const rows = [
      { id: DSH_ONE, name: "One", created_at: 100, latest_version: 2, updated_at: 150 },
      { id: DSH_TWO, name: "Two", created_at: 200, latest_version: 1, updated_at: 200 },
    ];
    const { db } = mockDb({ first: authedFirst(), all: () => rows });
    const response = await handleDashboardsRoute(
      request("/v1/dashboards", { headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(200);
    const body = await response!.json<{ items: Record<string, unknown>[]; next_cursor: string | null }>();
    // Storage order was oldest-first; the response is newest-first regardless.
    expect(body.items.map((item) => item.id)).toEqual([DSH_TWO, DSH_ONE]);
    expect(body.items[0]).toEqual({
      id: DSH_TWO,
      name: "Two",
      latest_version: 1,
      updated_at: 200,
    });
    expect(body.next_cursor).toBeNull();
  });

  it("emits a next_cursor only when another page exists", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `dsh_01J${String.fromCharCode(65 + index).repeat(23)}`,
      name: `D${index}`,
      created_at: 100 + index,
      latest_version: 1,
      updated_at: 100 + index,
    }));
    const { db } = mockDb({ first: authedFirst(), all: () => rows });
    const response = await handleDashboardsRoute(
      request("/v1/dashboards?limit=2", { headers: authed() }),
      makeEnv(db),
    );
    const body = await response!.json<{ items: unknown[]; next_cursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
  });

  it("scopes the query to the token's workspace", async () => {
    const { db, statements } = mockDb({ first: authedFirst(), all: () => [] });
    await handleDashboardsRoute(request("/v1/dashboards", { headers: authed() }), makeEnv(db));
    const list = statements.find((s) => s.sql.includes("dashboards:list"));
    expect(list?.binds[0]).toBe(TOKEN_WORKSPACE);
  });
});

describe("GET /v1/dashboards/{id}", () => {
  it("returns the latest config, the version list and content-free share metadata", async () => {
    const validated = validateDashboardConfig(baseConfig());
    const canonical = validated.ok ? validated.canonical : "";
    const { db } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("dashboards:read-dashboard")) {
          return { id: DSH_ONE, name: "Test dashboard", created_at: 100 };
        }
        if (statement.sql.includes("dashboards:latest-config")) {
          return {
            version: 2,
            config: canonical,
            content_sha256: "a".repeat(64),
            created_by_device: DEVICE_ID,
            created_at: 200,
          };
        }
        return null;
      }),
      all(statement) {
        if (statement.sql.includes("dashboards:version-list")) {
          return [
            { version: 1, content_sha256: "b".repeat(64), created_by_device: DEVICE_ID, created_at: 100 },
            { version: 2, content_sha256: "a".repeat(64), created_by_device: DEVICE_ID, created_at: 200 },
          ];
        }
        if (statement.sql.includes("dashboards:share-list")) {
          return [{ created_at: 150, revoked_at: null }];
        }
        return [];
      },
    });
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}`, { headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(200);
    const body = await response!.json<Record<string, unknown>>();
    expect((body.dashboard as Record<string, unknown>).latest_version).toBe(2);
    expect(body.config).toEqual(JSON.parse(canonical));
    expect((body.versions as { version: number }[]).map((v) => v.version)).toEqual([2, 1]);
    // Share rows expose only timestamps — never the token or its hash.
    expect(body.shares).toEqual([{ created_at: 150, revoked_at: null }]);
    expect(JSON.stringify(body.shares)).not.toContain("token");
  });

  it("404s for a dashboard in another workspace", async () => {
    const { db } = mockDb({ first: authedFirst(() => null) });
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_TWO}`, { headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(404);
  });
});

describe("GET /v1/dashboards/{id}/versions/{n} — the export format", () => {
  const validated = validateDashboardConfig(baseConfig());
  const canonical = validated.ok ? validated.canonical : "";

  function exportEnv(stored = canonical) {
    return mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("dashboards:exact-version")) {
          return statement.binds[0] === TOKEN_WORKSPACE
            ? { version: 2, config: stored, content_sha256: "c".repeat(64), created_at: 1, created_by_device: DEVICE_ID }
            : null;
        }
        return null;
      }),
    });
  }

  it("returns the stored bytes verbatim — the body IS the config document", async () => {
    const { db } = exportEnv();
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions/2`, { headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(200);
    const text = await response!.text();
    expect(text).toBe(canonical);
    // No envelope: the file on disk and the response body are the same artifact.
    expect(JSON.parse(text)).toEqual(JSON.parse(canonical));
    expect(response!.headers.get("etag")).toBe(`"sha256-${"c".repeat(64)}"`);
    expect(response!.headers.get("x-hfg-dashboard-version")).toBe("2");
  });

  it("round-trips: the exported bytes re-validate to the same bytes", async () => {
    const { db } = exportEnv();
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions/2`, { headers: authed() }),
      makeEnv(db),
    );
    const text = await response!.text();
    const revalidated = validateDashboardConfig(JSON.parse(text));
    expect(revalidated.ok).toBe(true);
    expect(revalidated.ok && revalidated.canonical).toBe(text);
  });

  it("is byte-stable across reads", async () => {
    const first = exportEnv();
    const second = exportEnv();
    const a = await (await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions/2`, { headers: authed() }),
      makeEnv(first.db),
    ))!.text();
    const b = await (await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions/2`, { headers: authed() }),
      makeEnv(second.db),
    ))!.text();
    expect(a).toBe(b);
  });

  it("404s for an unknown version and for a foreign workspace", async () => {
    const { db } = mockDb({ first: authedFirst(() => null) });
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions/99`, { headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(404);
  });

  it("404s version 0 and zero-padded aliases without querying", async () => {
    for (const suffix of ["0", "007", "0002"]) {
      const { db, statements } = mockDb({ first: authedFirst() });
      const response = await handleDashboardsRoute(
        request(`/v1/dashboards/${DSH_ONE}/versions/${suffix}`, { headers: authed() }),
        makeEnv(db),
      );
      expect(response?.status).toBe(404);
      expect(statements.some((s) => s.sql.includes("dashboards:exact-version"))).toBe(false);
    }
  });
});

// ============================================================================
// 3. Share links
// ============================================================================

describe("POST /v1/dashboards/{id}/shares", () => {
  function shareEnv() {
    return mockDb({
      first: authedFirst((statement) =>
        statement.sql.includes("dashboards:read-dashboard") && statement.binds[0] === TOKEN_WORKSPACE
          ? { id: DSH_ONE, name: "Test dashboard", created_at: 1 }
          : null,
      ),
    });
  }

  it("returns the token exactly once and stores only its sha256", async () => {
    const { db, statements } = shareEnv();
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares`, { method: "POST", headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(201);
    const body = await response!.json<{ token: string; share_url: string; warning: string }>();
    expect(SHARE_TOKEN_PATTERN.test(body.token)).toBe(true);
    expect(body.share_url).toBe(`https://api.handoffgraph.dev/v1/shared/dashboards/${body.token}`);
    expect(body.warning).toContain("cannot be shown again");

    const insert = statements.find((s) => s.sql.includes("dashboards:insert-share"));
    expect(insert?.binds[0]).toBe(await sha256Hex(body.token));
    // The raw token reaches the database nowhere, in no bind, on no statement.
    for (const statement of statements) {
      expect(JSON.stringify(statement.binds)).not.toContain(body.token);
    }
  });

  it("mints a fresh 256-bit token every time", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { db } = shareEnv();
      const response = await handleDashboardsRoute(
        request(`/v1/dashboards/${DSH_ONE}/shares`, { method: "POST", headers: authed() }),
        makeEnv(db),
      );
      const body = await response!.json<{ token: string }>();
      tokens.add(body.token);
    }
    expect(tokens.size).toBe(5);
  });

  it("falls back to the request origin when APP_ORIGIN is unset", async () => {
    const { db } = shareEnv();
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares`, { method: "POST", headers: authed() }),
      { DB: db },
    );
    const body = await response!.json<{ share_url: string }>();
    expect(body.share_url.startsWith("https://api.handoffgraph.dev/v1/shared/dashboards/")).toBe(true);
  });

  it("404s for a dashboard in another workspace", async () => {
    const { db } = mockDb({ first: authedFirst(() => null) });
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_TWO}/shares`, { method: "POST", headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(404);
  });

  it("requires the ingest capability", async () => {
    const { db } = mockDb({ first: authedFirst(() => null, { capabilities: "read" }) });
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares`, { method: "POST", headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(403);
  });
});

describe("POST /v1/dashboards/{id}/shares/revoke", () => {
  function revokeEnv(revokedRows: { token_hash: string }[], single: { token_hash: string } | null = null) {
    return mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("dashboards:read-dashboard")) {
          return { id: DSH_ONE, name: "Test dashboard", created_at: 1 };
        }
        if (statement.sql.includes("dashboards:revoke-one-share")) return single;
        return null;
      }),
      all: (statement) =>
        statement.sql.includes("dashboards:revoke-all-shares") ? revokedRows : [],
    });
  }

  it("revokes every live link when no token is supplied", async () => {
    const { db, statements } = revokeEnv([{ token_hash: "a".repeat(64) }, { token_hash: "b".repeat(64) }]);
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares/revoke`, { method: "POST", headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, revoked: 2 });
    const update = statements.find((s) => s.sql.includes("dashboards:revoke-all-shares"));
    expect(update?.binds[1]).toBe(TOKEN_WORKSPACE);
  });

  it("revokes exactly one link when a token is supplied, by hash", async () => {
    const token = newShareToken();
    const { db, statements } = revokeEnv([], { token_hash: await sha256Hex(token) });
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares/revoke`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ token }),
      }),
      makeEnv(db),
    );
    expect(await response!.json()).toEqual({ ok: true, revoked: 1 });
    const update = statements.find((s) => s.sql.includes("dashboards:revoke-one-share"));
    expect(update?.binds[2]).toBe(await sha256Hex(token));
  });

  it("404s for an already-revoked or unknown token", async () => {
    const { db } = revokeEnv([], null);
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares/revoke`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ token: newShareToken() }),
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(404);
  });

  it("rejects a malformed body instead of treating it as revoke-all", async () => {
    const { db, statements } = revokeEnv([{ token_hash: "a".repeat(64) }]);
    const response = await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares/revoke`, {
        method: "POST",
        headers: authed(),
        body: "{not json",
      }),
      makeEnv(db),
    );
    expect(response?.status).toBe(400);
    expect(statements.some((s) => s.sql.includes("dashboards:revoke-all-shares"))).toBe(false);
  });
});

describe("GET /v1/shared/dashboards/{token} — the unauthenticated trust boundary", () => {
  const validated = validateDashboardConfig(baseConfig());
  const canonical = validated.ok ? validated.canonical : "";

  function sharedEnv(row: unknown) {
    return mockDb({
      first: (statement) => (statement.sql.includes("dashboards:resolve-share") ? row : null),
    });
  }

  it("resolves an unrevoked share to the latest config with no auth header", async () => {
    const { db, statements } = sharedEnv({
      version: 3,
      config: canonical,
      content_sha256: "d".repeat(64),
    });
    const token = newShareToken();
    const response = await handleDashboardsRoute(
      request(`/v1/shared/dashboards/${token}`),
      makeEnv(db),
    );
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe(canonical);
    expect(response!.headers.get("x-hfg-dashboard-version")).toBe("3");
    expect(response!.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    // No device lookup happens at all on this path.
    expect(statements.some((s) => s.sql.includes("FROM devices"))).toBe(false);
  });

  it("looks the token up by hash only — the raw token never reaches a bind", async () => {
    const token = newShareToken();
    const { db, statements } = sharedEnv({ version: 1, config: canonical, content_sha256: "e".repeat(64) });
    await handleDashboardsRoute(request(`/v1/shared/dashboards/${token}`), makeEnv(db));
    const lookup = statements.find((s) => s.sql.includes("dashboards:resolve-share"));
    expect(lookup?.binds[0]).toBe(await sha256Hex(token));
    expect(lookup?.binds).not.toContain(token);
  });

  it("returns the config document and no workspace data whatsoever", async () => {
    const { db } = sharedEnv({ version: 1, config: canonical, content_sha256: "f".repeat(64) });
    const response = await handleDashboardsRoute(
      request(`/v1/shared/dashboards/${newShareToken()}`),
      makeEnv(db),
    );
    const text = await response!.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // The document is exactly the four config keys — no workspace id, no
    // dashboard id, no device, no rows, no counts.
    expect(Object.keys(parsed).sort()).toEqual(["name", "schema", "variables", "widgets"]);
    for (const leak of [TOKEN_WORKSPACE, DEVICE_ID, DSH_ONE, "workspace_id"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("404s for a revoked or unknown token (the SQL filters revoked_at IS NULL)", async () => {
    const { db, statements } = sharedEnv(null);
    const response = await handleDashboardsRoute(
      request(`/v1/shared/dashboards/${newShareToken()}`),
      makeEnv(db),
    );
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "not found" });
    const lookup = statements.find((s) => s.sql.includes("dashboards:resolve-share"));
    expect(lookup?.sql).toContain("revoked_at IS NULL");
  });

  it("404s a malformed token without querying, and with the same body", async () => {
    const { db, statements } = sharedEnv({ version: 1, config: canonical, content_sha256: "0".repeat(64) });
    const response = await handleDashboardsRoute(
      request("/v1/shared/dashboards/not-a-real-token"),
      makeEnv(db),
    );
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "not found" });
    expect(statements).toHaveLength(0);
  });

  it("ignores any Authorization header presented on the shared path", async () => {
    const { db, statements } = sharedEnv({ version: 1, config: canonical, content_sha256: "1".repeat(64) });
    const response = await handleDashboardsRoute(
      request(`/v1/shared/dashboards/${newShareToken()}`, { headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(200);
    expect(statements.some((s) => s.sql.includes("FROM devices"))).toBe(false);
  });
});

// ============================================================================
// 4. Tenancy: every statement this module issues is workspace-scoped
// ============================================================================

describe("tenancy", () => {
  /**
   * The route tests above drive a fake D1, so they can prove which SQL runs
   * but not what a real database would do with it. This sweep closes that gap
   * structurally: it exercises every route and asserts that no statement
   * reaches the database without naming workspace_id, and that every
   * authenticated one binds the token's workspace. A future edit that drops a
   * `WHERE workspace_id = ?1` fails here even though the fake would happily
   * answer.
   */
  it("names workspace_id in every statement, and binds the token's workspace", async () => {
    const validated = validateDashboardConfig(baseConfig());
    const canonical = validated.ok ? validated.canonical : "";
    const dashboardRow = { id: DSH_ONE, name: "Test dashboard", created_at: 1 };
    const versionRow = {
      version: 1,
      config: canonical,
      content_sha256: "a".repeat(64),
      created_by_device: DEVICE_ID,
      created_at: 1,
    };

    const { db, statements, batches } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("dashboards:read-dashboard")) return dashboardRow;
        if (statement.sql.includes("dashboards:latest-version")) return { version: 1 };
        if (statement.sql.includes("dashboards:latest-config")) return versionRow;
        if (statement.sql.includes("dashboards:exact-version")) return versionRow;
        if (statement.sql.includes("dashboards:revoke-one-share")) return { token_hash: "b".repeat(64) };
        if (statement.sql.includes("dashboards:resolve-share")) return versionRow;
        return null;
      }),
      all: () => [],
    });
    const env = makeEnv(db);
    const body = JSON.stringify({ config: baseConfig() });

    await handleDashboardsRoute(request("/v1/dashboards", { method: "POST", headers: authed(), body }), env);
    await handleDashboardsRoute(request("/v1/dashboards", { headers: authed() }), env);
    await handleDashboardsRoute(request(`/v1/dashboards/${DSH_ONE}`, { headers: authed() }), env);
    await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions`, { method: "POST", headers: authed(), body }),
      env,
    );
    await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/versions/1`, { headers: authed() }),
      env,
    );
    await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares`, { method: "POST", headers: authed() }),
      env,
    );
    await handleDashboardsRoute(
      request(`/v1/dashboards/${DSH_ONE}/shares/revoke`, { method: "POST", headers: authed() }),
      env,
    );
    const sharedToken = newShareToken();
    await handleDashboardsRoute(request(`/v1/shared/dashboards/${sharedToken}`), env);

    const issued = [...statements, ...batches.flat()].filter(
      (statement) => !statement.sql.includes("FROM devices"),
    );
    expect(issued.length).toBeGreaterThan(8);
    for (const statement of issued) {
      expect(statement.sql).toContain("workspace_id");
      // The unauthenticated share resolve is scoped by token hash and the
      // versions/shares workspace join, not by a caller-supplied workspace.
      if (statement.sql.includes("dashboards:resolve-share")) {
        expect(statement.binds).toEqual([await sha256Hex(sharedToken)]);
        continue;
      }
      expect(statement.binds).toContain(TOKEN_WORKSPACE);
    }
  });
});

// ============================================================================
// 5. Migration 0008: CHECK constraints + immutability triggers (node:sqlite)
// ============================================================================

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0008_dashboards.sql";
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

const SQLITE_WORKSPACE = `wsp_01J${"W".repeat(23)}`;
const SQLITE_DASHBOARD = `dsh_01J${"D".repeat(23)}`;
const CANONICAL_CONFIG = canonicalJsonStringify({
  schema: DASHBOARD_SCHEMA_VERSION,
  name: "Test dashboard",
  variables: [],
  widgets: [
    {
      id: "events",
      title: "Events",
      type: "summary",
      query: { source: "events", metric: "count" },
      layout: { x: 0, y: 0, w: 6, h: 4 },
    },
  ],
});

function insertDashboard(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: SQLITE_DASHBOARD,
    workspace_id: SQLITE_WORKSPACE,
    name: "Test dashboard",
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare("INSERT INTO dashboards (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)").run(
    row.id as string,
    row.workspace_id as string,
    row.name as string,
    row.created_at as number,
  );
}

function insertVersion(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    dashboard_id: SQLITE_DASHBOARD,
    workspace_id: SQLITE_WORKSPACE,
    version: 1,
    config: CANONICAL_CONFIG,
    content_sha256: "a".repeat(64),
    created_by_device: DEVICE_ID,
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO dashboard_versions
      (dashboard_id, workspace_id, version, config, content_sha256, created_by_device, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.dashboard_id as string,
    row.workspace_id as string,
    row.version as number,
    row.config as string,
    row.content_sha256 as string,
    row.created_by_device as string,
    row.created_at as number,
  );
}

function insertShare(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    token_hash: "c".repeat(64),
    dashboard_id: SQLITE_DASHBOARD,
    workspace_id: SQLITE_WORKSPACE,
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO dashboard_shares (token_hash, dashboard_id, workspace_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    row.token_hash as string,
    row.dashboard_id as string,
    row.workspace_id as string,
    row.created_at as number,
  );
}

describe("0008 dashboards migration (node:sqlite)", () => {
  it("creates every dashboards table", () => {
    const db = migratedDatabase();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    for (const table of ["dashboards", "dashboard_versions", "dashboard_shares"]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it("requires workspace_id on every dashboards table", () => {
    const db = migratedDatabase();
    expect(() =>
      db.prepare("INSERT INTO dashboards (id, name, created_at) VALUES (?, ?, ?)").run(
        SQLITE_DASHBOARD,
        "n",
        1,
      ),
    ).toThrow();
    insertDashboard(db);
    expect(() =>
      db.prepare(`
        INSERT INTO dashboard_versions
          (dashboard_id, version, config, content_sha256, created_by_device, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(SQLITE_DASHBOARD, 1, CANONICAL_CONFIG, "a".repeat(64), DEVICE_ID, 1),
    ).toThrow();
    expect(() =>
      db.prepare(`
        INSERT INTO dashboard_shares (token_hash, dashboard_id, created_at) VALUES (?, ?, ?)
      `).run("c".repeat(64), SQLITE_DASHBOARD, 1),
    ).toThrow();
    db.close();
  });

  it("rejects a malformed dashboard id", () => {
    const db = migratedDatabase();
    expect(() => insertDashboard(db, { id: "not_an_id" })).toThrow();
    expect(() => insertDashboard(db, { id: `dsh_${"9".repeat(26)}` })).toThrow();
    db.close();
  });

  it("rejects a config that is not an hfg.dashboard.v1 JSON object", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    expect(() => insertVersion(db, { config: "not json" })).toThrow();
    expect(() => insertVersion(db, { config: JSON.stringify([1, 2]) })).toThrow();
    expect(() =>
      insertVersion(db, { config: JSON.stringify({ schema: "hfg.dashboard.v2", name: "Test dashboard" }) }),
    ).toThrow();
    db.close();
  });

  it("rejects a config over 32 KiB at the schema level too", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    const oversize = JSON.stringify({
      schema: DASHBOARD_SCHEMA_VERSION,
      name: "Test dashboard",
      filler: "x".repeat(33_000),
    });
    expect(() => insertVersion(db, { config: oversize })).toThrow();
    db.close();
  });

  it("requires the version sequence to be dense from 1", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    expect(() => insertVersion(db, { version: 2 })).toThrow();
    insertVersion(db, { version: 1 });
    expect(() => insertVersion(db, { version: 3 })).toThrow();
    expect(() => insertVersion(db, { version: 2 })).not.toThrow();
    db.close();
  });

  it("refuses a second row for the same (dashboard_id, version)", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    insertVersion(db, { version: 1 });
    expect(() => insertVersion(db, { version: 1, content_sha256: "b".repeat(64) })).toThrow();
    db.close();
  });

  it("requires a version's workspace and config name to match its dashboard", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    expect(() => insertVersion(db, { workspace_id: `wsp_01J${"X".repeat(23)}` })).toThrow();
    const renamed = canonicalJsonStringify({ ...JSON.parse(CANONICAL_CONFIG) as object, name: "Other" });
    expect(() => insertVersion(db, { config: renamed })).toThrow();
    db.close();
  });

  it("makes a published version immutable", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    insertVersion(db);
    expect(() =>
      db.prepare("UPDATE dashboard_versions SET content_sha256 = ? WHERE dashboard_id = ?").run(
        "f".repeat(64),
        SQLITE_DASHBOARD,
      ),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE dashboard_versions SET config = ? WHERE dashboard_id = ?").run(
        CANONICAL_CONFIG,
        SQLITE_DASHBOARD,
      ),
    ).toThrow();
    expect(() =>
      db.prepare("DELETE FROM dashboard_versions WHERE dashboard_id = ?").run(SQLITE_DASHBOARD),
    ).toThrow();
    db.close();
  });

  it("still cascades versions away when the parent dashboard is deleted", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    insertVersion(db);
    insertShare(db);
    db.prepare("DELETE FROM dashboards WHERE id = ?").run(SQLITE_DASHBOARD);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM dashboard_versions WHERE dashboard_id = ?")
      .get(SQLITE_DASHBOARD) as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });

  it("makes the dashboard row itself immutable", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    expect(() =>
      db.prepare("UPDATE dashboards SET name = ? WHERE id = ?").run("Renamed", SQLITE_DASHBOARD),
    ).toThrow();
    db.close();
  });

  it("enforces a unique token_hash and rejects a non-hex one", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    insertShare(db);
    expect(() => insertShare(db)).toThrow();
    expect(() => insertShare(db, { token_hash: "not-a-hash" })).toThrow();
    expect(() => insertShare(db, { token_hash: "Z".repeat(64) })).toThrow();
    db.close();
  });

  it("rejects a share pointing at a dashboard in another workspace", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    expect(() => insertShare(db, { workspace_id: `wsp_01J${"Y".repeat(23)}` })).toThrow();
    db.close();
  });

  it("allows revocation exactly once and forbids un-revoking", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    insertShare(db);
    expect(() =>
      db.prepare("UPDATE dashboard_shares SET revoked_at = ? WHERE token_hash = ?").run(
        1_700_000_100,
        "c".repeat(64),
      ),
    ).not.toThrow();
    expect(() =>
      db.prepare("UPDATE dashboard_shares SET revoked_at = NULL WHERE token_hash = ?").run("c".repeat(64)),
    ).toThrow();
    db.close();
  });

  it("forbids re-pointing a live share at another dashboard", () => {
    const db = migratedDatabase();
    insertDashboard(db);
    insertDashboard(db, { id: `dsh_01J${"E".repeat(23)}` });
    insertShare(db);
    expect(() =>
      db.prepare("UPDATE dashboard_shares SET dashboard_id = ? WHERE token_hash = ?").run(
        `dsh_01J${"E".repeat(23)}`,
        "c".repeat(64),
      ),
    ).toThrow();
    db.close();
  });
});

// ============================================================================
// 6. CI dry-run over the configs committed to deploy/dashboards/
// ============================================================================

const dashboardsConfigDir = resolve(testDirectory, "../../deploy/dashboards");

describe("deploy/dashboards/*.json (in-repo CI dry-run, parity row 40)", () => {
  const files = readdirSync(dashboardsConfigDir).filter((name) => name.endsWith(".json")).sort();

  it("ships at least the coding-agent overview", () => {
    expect(files).toContain("coding-agent-overview.json");
  });

  for (const file of files) {
    it(`${file} passes the validator`, () => {
      const raw = readFileSync(resolve(dashboardsConfigDir, file), "utf8");
      const result = validateDashboardConfig(JSON.parse(raw));
      if (!result.ok) {
        throw new Error(
          `${file} is invalid:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`,
        );
      }
      expect(result.ok).toBe(true);
    });

    it(`${file} round-trips through canonicalization`, () => {
      const raw = readFileSync(resolve(dashboardsConfigDir, file), "utf8");
      const first = validateDashboardConfig(JSON.parse(raw));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      // Re-importing the exported bytes must reproduce them exactly, which is
      // what makes a committed config and a stored version the same artifact.
      const second = validateDashboardConfig(JSON.parse(first.canonical));
      expect(second.ok && second.canonical).toBe(first.canonical);
    });
  }

  it("the coding-agent overview really exercises series, summary, funnel and table", () => {
    const raw = readFileSync(resolve(dashboardsConfigDir, "coding-agent-overview.json"), "utf8");
    const result = validateDashboardConfig(JSON.parse(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = new Set(result.config.widgets.map((widget) => widget.type));
    expect([...types].sort()).toEqual(["funnel", "series", "summary", "table"]);
    const metrics = new Set(result.config.widgets.map((widget) => widget.query.metric));
    expect(metrics.has("count")).toBe(true);
    expect(metrics.has("error_rate")).toBe(true);
    expect(metrics.has("token_in")).toBe(true);
    expect(metrics.has("cost_amount")).toBe(true);
  });
});
