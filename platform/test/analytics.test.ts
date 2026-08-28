// Tests for src/analytics.ts.
//
// Four layers, no workerd and no new dependencies:
//   * pure logic     — the exact decimal-string adder, the AE ingest mirror's
//     aggregation, series/summary/funnel query builders' validation, funnel
//     step matching.
//   * schema truth   — migrations 0001-0003 + 0005 applied with node:sqlite,
//     running the REAL query builders against REAL span_observations/events
//     rows so ts_bucket pruning and decimal-string folding are asserted
//     against SQLite, not a mock.
//   * handlers        — worker.fetch against the plain-object D1 seam
//     (mirrors ingest.test.ts's/observations.test.ts's mockDb pattern).
//   * ingest wiring   — the one-line recordIngestDataPoints call in
//     index.ts's handleEventBatches never affects the ingest response.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import worker, {
  type D1BoundStatement,
  type D1DatabaseLike,
  type D1Statement,
} from "../src/index";
import { sha256Hex } from "../src/auth";
import { canonicalJsonStringify, type IngestEvent } from "../src/ingest";
import {
  MAX_SPAN_ID_BYTES,
  UPSERT_SESSIONS_SQL,
  UPSERT_SPAN_FINGERPRINTS_SQL,
  UPSERT_SPAN_OBSERVATIONS_SQL,
  buildObservationProjection,
} from "../src/observations";
import {
  MAX_ANALYTICS_DATAPOINTS_PER_BATCH,
  MAX_FUNNEL_TRACES,
  addDecimalStrings,
  buildFunnelResponse,
  buildFunnelScopeQuery,
  buildIngestDataPoints,
  buildSeriesQuery,
  buildSummaryGroups,
  buildSummaryQueries,
  computeFunnel,
  foldSeriesRows,
  handleAnalyticsRoute,
  isValidDecimalAmount,
  ratio,
  recordIngestDataPoints,
  validateFunnelRequest,
  type AnalyticsEngineDatasetLike,
  type FunnelSpanRow,
  type FunnelStepPredicate,
} from "../src/analytics";

// -- fixtures -----------------------------------------------------------------

const TOKEN_WORKSPACE = `wsp_01HTSTW0RKSPACE0000000000Z`;
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const WORKSTREAM = `ws_01HTESTWS0000000000000000Z`;

let TOKEN_HASH = "";
beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
});

function eventId(i: number): string {
  const head = `01HTEST${String(i).padStart(4, "0")}`;
  return `evt_${head}${"0".repeat(26 - head.length - 1)}Z`;
}

function event(overrides: Record<string, unknown> = {}, i = 0): IngestEvent {
  return {
    schema_version: "hfg.event.v1",
    event_id: eventId(i),
    kind: "span.completed",
    occurred_at: "2026-08-21T10:00:00Z",
    observed_at: "2026-08-21T10:00:00Z",
    workstream_id: WORKSTREAM,
    provider: "claude",
    agent: "claude-code",
    model: "opus-5",
    provenance: "OBSERVED",
    ...overrides,
  } as IngestEvent;
}

function span(
  overrides: Partial<FunnelSpanRow> & Pick<FunnelSpanRow, "trace_id" | "span_id" | "started_at_ns">,
): FunnelSpanRow {
  return { kind: "OTHER", tool_name: null, status: "ok", name: "span", ...overrides };
}

// ==============================================================================
// pure logic: exact decimal-string arithmetic
// ==============================================================================

describe("addDecimalStrings", () => {
  it("sums an empty list to the additive identity", () => {
    expect(addDecimalStrings([])).toBe("0");
  });

  it("zero-pads differing fractional-digit counts before adding", () => {
    expect(addDecimalStrings(["1.5", "0.25"])).toBe("1.75");
  });

  it("carries across the decimal boundary exactly", () => {
    expect(addDecimalStrings(["0.999999999", "0.000000001"])).toBe("1");
  });

  it("sums amounts a float would corrupt (0.1 + 0.2 !== 0.3 in IEEE754)", () => {
    expect(addDecimalStrings(["0.1", "0.2"])).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3); // sanity: proves the pitfall this adder avoids
  });

  it("handles negative amounts and never emits -0", () => {
    expect(addDecimalStrings(["-0.5", "0.5"])).toBe("0");
    expect(addDecimalStrings(["-1.25", "0.25"])).toBe("-1");
  });

  it("trims trailing zeros to a canonical form", () => {
    expect(addDecimalStrings(["1.100", "0.400"])).toBe("1.5");
    expect(addDecimalStrings(["3.000"])).toBe("3");
  });

  it("sums three operands of differing fractional lengths (zero-padding, three-way)", () => {
    expect(addDecimalStrings(["1", "0.01", "0.001"])).toBe("1.011");
  });

  it("keeps integer precision a JS number would lose", () => {
    const huge = "9007199254740993"; // 2^53 + 1: not exactly representable as a float
    expect(addDecimalStrings([huge, "0"])).toBe(huge);
    expect(String(Number(huge))).not.toBe(huge);
  });

  it("skips malformed entries defensively instead of throwing", () => {
    expect(addDecimalStrings(["0.5", "not-a-number", "0.25"])).toBe("0.75");
  });
});

describe("isValidDecimalAmount", () => {
  it("accepts the documented cost_amount shapes", () => {
    for (const value of ["0", "0.5", "-1.25", "123456789012345678", "0.000000001"]) {
      expect(isValidDecimalAmount(value)).toBe(true);
    }
  });

  it("rejects malformed shapes", () => {
    for (const value of ["", "abc", "1.", ".5", "01.5", "1.0000000001", "1e5"]) {
      expect(isValidDecimalAmount(value)).toBe(false);
    }
  });
});

describe("ratio", () => {
  it("defines 0/0 as 0, not NaN", () => {
    expect(ratio(0, 0)).toBe(0);
  });

  it("rounds to 4 decimal places", () => {
    expect(ratio(1, 3)).toBe(0.3333);
  });

  it("is 1 when numerator equals denominator", () => {
    expect(ratio(5, 5)).toBe(1);
  });
});

// ==============================================================================
// pure logic: ingest-time Analytics Engine mirror
// ==============================================================================

describe("buildIngestDataPoints", () => {
  it("aggregates count/tokens/cost per event kind", () => {
    const events = [
      event({
        kind: "span.completed",
        payload: { token_input: 100, token_output: 20, cost_amount: "0.01", cost_provenance: "provider_reported" },
      }, 0),
      event({
        kind: "span.completed",
        payload: { token_input: 50, token_output: 5, cost_amount: "0.02", cost_provenance: "provider_reported" },
      }, 1),
      event({ kind: "span.started" }, 2),
    ];
    const points = buildIngestDataPoints(TOKEN_WORKSPACE, events);
    expect(points).toHaveLength(2);
    const completed = points.find((p) => p.blobs[1] === "span.completed");
    expect(completed?.blobs).toEqual([TOKEN_WORKSPACE, "span.completed"]);
    expect(completed?.doubles).toEqual([2, 150, 25, 0.03]);
    expect(completed?.indexes).toEqual([TOKEN_WORKSPACE]);
    const started = points.find((p) => p.blobs[1] === "span.started");
    expect(started?.doubles).toEqual([1, 0, 0, 0]);
  });

  it("sorts kinds and caps the sample at MAX_ANALYTICS_DATAPOINTS_PER_BATCH", () => {
    const events = Array.from({ length: MAX_ANALYTICS_DATAPOINTS_PER_BATCH + 5 }, (_, i) =>
      event({ kind: `kind.${String(i).padStart(3, "0")}` }, i));
    const points = buildIngestDataPoints(TOKEN_WORKSPACE, events);
    expect(points).toHaveLength(MAX_ANALYTICS_DATAPOINTS_PER_BATCH);
    const kinds = points.map((p) => p.blobs[1]);
    expect(kinds).toEqual([...kinds].sort());
    expect(kinds[0]).toBe("kind.000");
  });

  it("drops an unlabelled or unknown-provenance cost, the same rule observations.ts applies", () => {
    const events = [
      event({ kind: "span.completed", payload: { cost_amount: "0.5" } }, 0),
      event({ kind: "span.completed", payload: { cost_amount: "0.5", cost_provenance: "unknown" } }, 1),
    ];
    const [point] = buildIngestDataPoints(TOKEN_WORKSPACE, events);
    expect(point.doubles[3]).toBe(0);
  });

  it("falls back to 'unknown' for an empty kind rather than dropping the event", () => {
    const [point] = buildIngestDataPoints(TOKEN_WORKSPACE, [event({ kind: "" }, 0)]);
    expect(point.blobs).toEqual([TOKEN_WORKSPACE, "unknown"]);
  });

  it("is a pure function of its inputs (replay-stable)", () => {
    const events = [event({ payload: { token_input: 3 } }, 0)];
    expect(buildIngestDataPoints(TOKEN_WORKSPACE, events)).toEqual(buildIngestDataPoints(TOKEN_WORKSPACE, events));
  });
});

describe("recordIngestDataPoints", () => {
  it("no-ops silently when the ANALYTICS binding is absent", () => {
    expect(() => recordIngestDataPoints({}, TOKEN_WORKSPACE, [event()])).not.toThrow();
  });

  it("writes one point per aggregated kind through the binding", () => {
    const captured: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> = [];
    const analytics: AnalyticsEngineDatasetLike = {
      writeDataPoint: (point) => {
        captured.push(point);
      },
    };
    recordIngestDataPoints({ ANALYTICS: analytics }, TOKEN_WORKSPACE, [event({ kind: "span.completed" }, 0)]);
    expect(captured).toHaveLength(1);
    expect(captured[0].blobs).toEqual([TOKEN_WORKSPACE, "span.completed"]);
  });

  it("never throws even when the binding itself throws", () => {
    const analytics: AnalyticsEngineDatasetLike = {
      writeDataPoint: () => {
        throw new Error("boom");
      },
    };
    expect(() => recordIngestDataPoints({ ANALYTICS: analytics }, TOKEN_WORKSPACE, [event()])).not.toThrow();
  });
});

// ==============================================================================
// pure logic: series / summary query builders (validation + SQL shape)
// ==============================================================================

describe("buildSeriesQuery", () => {
  const url = (query: string) => new URL(`https://api.handoffgraph.dev/v1/analytics/series${query}`);

  it("rejects a missing or unknown metric", () => {
    expect(buildSeriesQuery(TOKEN_WORKSPACE, url("?interval=hour"))).toMatchObject({ ok: false, status: 400 });
    expect(buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=bogus&interval=hour"))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("rejects an interval other than hour or day", () => {
    expect(buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=spans&interval=minute"))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("emits the two-level ts_bucket prune for span_observations metrics", () => {
    const built = buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=cost&interval=hour&since=2026-08-21T10:00:00Z"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.sql).toContain("FROM span_observations");
    expect(built.value.sql).toContain("ts_bucket >=");
    expect(built.value.sql).toContain("started_at_ns >= CAST(");
    expect(built.value.mode).toBe("cost");
  });

  it("buckets the events metric by ingested_at against the events table, with no ts_bucket clause", () => {
    const built = buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=events&interval=day"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.sql).toContain("FROM events");
    expect(built.value.sql).not.toContain("ts_bucket");
    expect(built.value.mode).toBe("count");
  });

  it("filters errors/tokens_in/tokens_out with their column-specific predicates", () => {
    const errors = buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=errors&interval=hour"));
    expect(errors.ok && errors.value.sql).toContain("status = 'error'");
    const tokensIn = buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=tokens_in&interval=hour"));
    expect(tokensIn.ok && tokensIn.value.sql).toContain("token_in IS NOT NULL");
    const tokensOut = buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=tokens_out&interval=hour"));
    expect(tokensOut.ok && tokensOut.value.sql).toContain("token_out IS NOT NULL");
  });

  it("rejects an oversized workstream filter", () => {
    const huge = "x".repeat(MAX_SPAN_ID_BYTES + 1);
    expect(
      buildSeriesQuery(TOKEN_WORKSPACE, url(`?metric=spans&interval=hour&workstream=${huge}`)),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a malformed since/until", () => {
    expect(buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=spans&interval=hour&since=yesterday"))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("always scopes to the given workspace as bind #1", () => {
    const built = buildSeriesQuery(TOKEN_WORKSPACE, url("?metric=spans&interval=hour"));
    expect(built.ok && built.value.binds[0]).toBe(TOKEN_WORKSPACE);
  });
});

describe("foldSeriesRows", () => {
  it("defaults a missing SQL-aggregated value to 0 and sorts by bucket", () => {
    const points = foldSeriesRows("count", [
      { bucket: 2, value: 5 },
      { bucket: 1, value: null },
    ]);
    expect(points).toEqual([
      { bucket: 1, value: 0 },
      { bucket: 2, value: 5 },
    ]);
  });

  it("exact-sums cost rows per bucket instead of trusting SQL SUM on TEXT", () => {
    const points = foldSeriesRows("cost", [
      { bucket: 1, cost_amount: "0.1" },
      { bucket: 1, cost_amount: "0.2" },
      { bucket: 0, cost_amount: "1.100" },
    ]);
    expect(points).toEqual([
      { bucket: 0, value: "1.1" },
      { bucket: 1, value: "0.3" },
    ]);
  });

  it("skips rows with no cost_amount in cost mode", () => {
    expect(foldSeriesRows("cost", [{ bucket: 1, cost_amount: null }])).toEqual([]);
  });
});

describe("buildSummaryQueries", () => {
  const url = (query: string) => new URL(`https://api.handoffgraph.dev/v1/analytics/summary${query}`);

  it("builds a counts pass and a cost pass sharing the same scope filters", () => {
    const built = buildSummaryQueries(TOKEN_WORKSPACE, url("?since=2026-08-21T10:00:00Z"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.countsSQL).toContain("GROUP BY provider, model");
    expect(built.value.countsSQL).toContain("ts_bucket >=");
    expect(built.value.costSQL).toContain("cost_amount IS NOT NULL");
    expect(built.value.costSQL).toContain("ts_bucket >=");
  });

  it("rejects a malformed since/until the same way series does", () => {
    expect(buildSummaryQueries(TOKEN_WORKSPACE, url("?until=not-a-time"))).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("buildSummaryGroups", () => {
  it("merges the counts pass with the cost pass by (provider, model)", () => {
    const counts = [
      { provider: "claude", model: "opus-5", traces: 3, spans: 10, errors: 1, tokens_in: 100, tokens_out: 20 },
      { provider: "codex", model: null, traces: 1, spans: 2, errors: 0, tokens_in: 5, tokens_out: 1 },
    ];
    const costs = [
      { provider: "claude", model: "opus-5", cost_amount: "0.1" },
      { provider: "claude", model: "opus-5", cost_amount: "0.2" },
    ];
    const groups = buildSummaryGroups(counts, costs);
    expect(groups).toHaveLength(2);
    const claude = groups.find((g) => g.provider === "claude");
    expect(claude?.cost).toBe("0.3");
    expect(claude?.error_rate).toBe(0.1);
    const codex = groups.find((g) => g.provider === "codex");
    expect(codex?.cost).toBeNull(); // unrecorded, never a false "0"
  });

  it("sorts deterministically, nulls first", () => {
    const counts = [
      { provider: "openai", model: "gpt", traces: 1, spans: 1, errors: 0, tokens_in: 0, tokens_out: 0 },
      { provider: null, model: null, traces: 1, spans: 1, errors: 0, tokens_in: 0, tokens_out: 0 },
      { provider: "claude", model: null, traces: 1, spans: 1, errors: 0, tokens_in: 0, tokens_out: 0 },
    ];
    expect(buildSummaryGroups(counts, []).map((g) => g.provider)).toEqual([null, "claude", "openai"]);
  });

  it("computes a 0 error_rate for a group with zero spans instead of NaN", () => {
    const counts = [{ provider: "p", model: "m", traces: 0, spans: 0, errors: 0, tokens_in: 0, tokens_out: 0 }];
    expect(buildSummaryGroups(counts, [])[0].error_rate).toBe(0);
  });
});

// ==============================================================================
// pure logic: trace funnels
// ==============================================================================

describe("validateFunnelRequest", () => {
  it("accepts a minimal valid request", () => {
    expect(validateFunnelRequest({ steps: [{ kind: "TOOL" }] }).ok).toBe(true);
  });

  it("rejects zero, and more than 5, steps", () => {
    expect(validateFunnelRequest({ steps: [] })).toMatchObject({ ok: false, status: 400 });
    const six = Array.from({ length: 6 }, () => ({ kind: "TOOL" }));
    expect(validateFunnelRequest({ steps: six })).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts exactly 5 steps", () => {
    const five = Array.from({ length: 5 }, () => ({ kind: "TOOL" }));
    expect(validateFunnelRequest({ steps: five }).ok).toBe(true);
  });

  it("rejects a step with no predicate fields at all", () => {
    expect(validateFunnelRequest({ steps: [{}] })).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects an unknown status value but accepts every real span status", () => {
    expect(validateFunnelRequest({ steps: [{ status: "weird" }] })).toMatchObject({ ok: false, status: 400 });
    for (const status of ["unknown", "running", "ok", "error"]) {
      expect(validateFunnelRequest({ steps: [{ status }] }).ok).toBe(true);
    }
  });

  it("rejects non-object bodies and a non-array steps field", () => {
    expect(validateFunnelRequest(null)).toMatchObject({ ok: false, status: 400 });
    expect(validateFunnelRequest([])).toMatchObject({ ok: false, status: 400 });
    expect(validateFunnelRequest({ steps: "nope" })).toMatchObject({ ok: false, status: 400 });
  });

  it("parses since/until and rejects malformed ones", () => {
    const ok = validateFunnelRequest({ steps: [{ kind: "T" }], since: "2026-08-21T10:00:00Z" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.since?.ms).toBe(Date.parse("2026-08-21T10:00:00Z"));
    expect(validateFunnelRequest({ steps: [{ kind: "T" }], since: "not-a-time" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(validateFunnelRequest({ steps: [{ kind: "T" }], until: 5 })).toMatchObject({ ok: false, status: 400 });
  });

  it("bounds the workstream filter and rejects a non-string value", () => {
    expect(
      validateFunnelRequest({ steps: [{ kind: "T" }], workstream: "x".repeat(300) }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(validateFunnelRequest({ steps: [{ kind: "T" }], workstream: 5 })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("computeFunnel", () => {
  it("counts distinct traces at each step and feeds conversions correctly", () => {
    const rows: FunnelSpanRow[] = [
      span({ trace_id: "t1", span_id: "a", started_at_ns: "100", tool_name: "Bash" }),
      span({ trace_id: "t1", span_id: "b", started_at_ns: "200", status: "error" }),
      span({ trace_id: "t2", span_id: "c", started_at_ns: "100", tool_name: "Bash" }),
      span({ trace_id: "t3", span_id: "d", started_at_ns: "50", status: "error" }), // never had a Bash span
    ];
    const steps: FunnelStepPredicate[] = [{ tool_name: "Bash" }, { status: "error" }];
    const { matchedTraces, tracesScanned } = computeFunnel(rows, steps);
    expect(tracesScanned).toBe(3);
    expect(matchedTraces).toEqual([2, 1]);

    const response = buildFunnelResponse(steps, matchedTraces, tracesScanned);
    expect(response.steps[0]).toMatchObject({
      step: 1,
      matched_traces: 2,
      conversion_from_first: 1,
      conversion_from_previous: 1,
    });
    expect(response.steps[1]).toMatchObject({
      step: 2,
      matched_traces: 1,
      conversion_from_first: 0.5,
      conversion_from_previous: 0.5,
    });
  });

  it("requires step N's match to be at or after step N-1's match, chronologically", () => {
    const rows: FunnelSpanRow[] = [
      span({ trace_id: "t1", span_id: "a", started_at_ns: "50", status: "error" }), // before the anchor
      span({ trace_id: "t1", span_id: "b", started_at_ns: "100", tool_name: "Bash" }),
      span({ trace_id: "t1", span_id: "c", started_at_ns: "150", status: "error" }), // after: counts
    ];
    const steps: FunnelStepPredicate[] = [{ tool_name: "Bash" }, { status: "error" }];
    expect(computeFunnel(rows, steps).matchedTraces).toEqual([1, 1]);
  });

  it("lets one span satisfy two consecutive steps at once ('at', not strictly 'after')", () => {
    const rows: FunnelSpanRow[] = [
      span({ trace_id: "t1", span_id: "a", started_at_ns: "100", tool_name: "Bash", status: "error" }),
    ];
    const steps: FunnelStepPredicate[] = [{ tool_name: "Bash" }, { status: "error" }];
    expect(computeFunnel(rows, steps).matchedTraces).toEqual([1, 1]);
  });

  it("breaks same-timestamp ties by ascending span_id, excluding an id smaller than the current anchor", () => {
    const rows: FunnelSpanRow[] = [
      span({ trace_id: "t1", span_id: "sB", started_at_ns: "1000", tool_name: "Bash" }), // step1 anchor
      span({ trace_id: "t1", span_id: "sA", started_at_ns: "1000", status: "error" }), // sA < sB: excluded
      span({ trace_id: "t1", span_id: "sC", started_at_ns: "1000", status: "error" }), // sC > sB: included
    ];
    const steps: FunnelStepPredicate[] = [{ tool_name: "Bash" }, { status: "error" }];
    expect(computeFunnel(rows, steps).matchedTraces).toEqual([1, 1]);
  });

  it("picks the SMALLEST qualifying span_id among same-timestamp candidates as the new anchor", () => {
    // If step2 incorrectly anchored on "sD" instead of "sB", step3 ("sC", between them) would be excluded.
    const rows: FunnelSpanRow[] = [
      span({ trace_id: "t1", span_id: "sA", started_at_ns: "1000", tool_name: "Bash" }),
      span({ trace_id: "t1", span_id: "sD", started_at_ns: "1000", status: "error" }),
      span({ trace_id: "t1", span_id: "sB", started_at_ns: "1000", status: "error" }),
      span({ trace_id: "t1", span_id: "sC", started_at_ns: "1000", kind: "REVIEW" }),
    ];
    const steps: FunnelStepPredicate[] = [{ tool_name: "Bash" }, { status: "error" }, { kind: "REVIEW" }];
    expect(computeFunnel(rows, steps).matchedTraces).toEqual([1, 1, 1]);
  });

  it("is independent of input row order (re-sorts before evaluating)", () => {
    const ordered: FunnelSpanRow[] = [
      span({ trace_id: "t1", span_id: "a", started_at_ns: "100", tool_name: "Bash" }),
      span({ trace_id: "t1", span_id: "b", started_at_ns: "200", status: "error" }),
    ];
    const shuffled = [ordered[1], ordered[0]];
    const steps: FunnelStepPredicate[] = [{ tool_name: "Bash" }, { status: "error" }];
    expect(computeFunnel(shuffled, steps)).toEqual(computeFunnel(ordered, steps));
  });

  it("matches name_contains as a plain substring", () => {
    const rows: FunnelSpanRow[] = [span({ trace_id: "t1", span_id: "a", started_at_ns: "100", name: "checkout flow" })];
    expect(computeFunnel(rows, [{ name_contains: "check" }]).matchedTraces).toEqual([1]);
    expect(computeFunnel(rows, [{ name_contains: "nope" }]).matchedTraces).toEqual([0]);
  });

  it("returns all-zero matches and zero traces_scanned for an empty store", () => {
    const steps: FunnelStepPredicate[] = [{ kind: "TOOL" }, { status: "error" }];
    const { matchedTraces, tracesScanned } = computeFunnel([], steps);
    expect(tracesScanned).toBe(0);
    expect(matchedTraces).toEqual([0, 0]);
    const response = buildFunnelResponse(steps, matchedTraces, tracesScanned);
    expect(
      response.steps.every((s) => s.matched_traces === 0 && s.conversion_from_first === 0 && s.conversion_from_previous === 0),
    ).toBe(true);
  });
});

// ==============================================================================
// schema truth: real SQLite, real query builders
// ==============================================================================

const testDirectory = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  "0001_init.sql",
  "0002_workstream_event_projection.sql",
  "0003_account_foundation.sql",
  "0005_observations_sessions.sql",
];

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(readFileSync(resolve(testDirectory, `../migrations/${migration}`), "utf8"));
  }
  return db;
}

const INSERT_EVENT_ROW = `
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?, ?, 'k', ?, ?, ?, ?, ?, ?, 'OBSERVED', NULL, ?, ?)`;

/** Apply one ingest batch the way index.ts does: raw events, then the span_observations projection. */
async function ingestBatch(
  db: DatabaseSync,
  workspaceId: string,
  events: IngestEvent[],
  ingestedAtSeconds = 0,
): Promise<void> {
  for (const raw of events) {
    db.prepare(INSERT_EVENT_ROW).run(
      workspaceId,
      String(raw.event_id),
      String(raw.occurred_at),
      (raw.workstream_id as string | undefined) ?? null,
      (raw.session_id as string | undefined) ?? null,
      (raw.native_session_id as string | undefined) ?? null,
      (raw.provider as string | undefined) ?? null,
      String(raw.kind),
      ingestedAtSeconds,
      canonicalJsonStringify(raw),
    );
  }
  const projection = await buildObservationProjection(events);
  db.prepare(UPSERT_SPAN_OBSERVATIONS_SQL).run(workspaceId, canonicalJsonStringify(projection.spans));
  db.prepare(UPSERT_SPAN_FINGERPRINTS_SQL).run(workspaceId, canonicalJsonStringify(projection.fingerprints));
  db.prepare(UPSERT_SESSIONS_SQL).run(workspaceId, canonicalJsonStringify(projection.sessions));
}

function spanEvent(i: number, occurredAt: string, payload: Record<string, unknown>): IngestEvent {
  return event(
    { kind: "span.completed", occurred_at: occurredAt, payload: { span_id: `spn_${i}`, trace_id: `trc_${i}`, ...payload } },
    i,
  );
}

describe("buildSeriesQuery against real SQLite (schema truth)", () => {
  const BUCKET_A = "2026-08-21T10:15:00Z"; // hour bucket [10:00, 11:00)
  const BUCKET_B = "2026-08-21T12:30:00Z"; // hour bucket [12:00, 13:00)

  it("groups spans into hour buckets and prunes earlier buckets via ts_bucket when since is set", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, [spanEvent(0, BUCKET_A, {}), spanEvent(1, BUCKET_A, {}), spanEvent(2, BUCKET_B, {})]);

    const built = buildSeriesQuery(TOKEN_WORKSPACE, new URL("https://api.handoffgraph.dev/v1/analytics/series?metric=spans&interval=hour"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rows = db.prepare(built.value.sql).all(...(built.value.binds as never[])) as Array<{ bucket: number; value: number }>;
    const points = foldSeriesRows(built.value.mode, rows);
    expect(points.map((p) => p.value)).toEqual([2, 1]);

    const prunedURL = new URL(`https://api.handoffgraph.dev/v1/analytics/series?metric=spans&interval=hour&since=${BUCKET_B}`);
    const pruned = buildSeriesQuery(TOKEN_WORKSPACE, prunedURL);
    expect(pruned.ok).toBe(true);
    if (!pruned.ok) return;
    const prunedRows = db.prepare(pruned.value.sql).all(...(pruned.value.binds as never[])) as Array<{ bucket: number; value: number }>;
    expect(foldSeriesRows(pruned.value.mode, prunedRows)).toEqual([{ bucket: points[1].bucket, value: 1 }]);
    db.close();
  });

  it("exact-sums real TEXT cost_amount rows through the fold, not through SQL SUM", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, [
      spanEvent(0, BUCKET_A, { cost_amount: "0.1", cost_provenance: "provider_reported" }),
      spanEvent(1, BUCKET_A, { cost_amount: "0.2", cost_provenance: "provider_reported" }),
    ]);
    const built = buildSeriesQuery(TOKEN_WORKSPACE, new URL("https://api.handoffgraph.dev/v1/analytics/series?metric=cost&interval=hour"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rows = db.prepare(built.value.sql).all(...(built.value.binds as never[])) as Array<{
      bucket: number;
      cost_amount: string;
    }>;
    const [point] = foldSeriesRows(built.value.mode, rows);
    expect(point.value).toBe("0.3"); // not the float artifact 0.30000000000000004
    db.close();
  });

  it("sums token_in only over rows that carry it", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, [
      spanEvent(0, BUCKET_A, { token_input: 100, token_output: 10 }),
      spanEvent(1, BUCKET_A, {}), // no token fields
    ]);
    const built = buildSeriesQuery(TOKEN_WORKSPACE, new URL("https://api.handoffgraph.dev/v1/analytics/series?metric=tokens_in&interval=hour"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rows = db.prepare(built.value.sql).all(...(built.value.binds as never[])) as Array<{ bucket: number; value: number }>;
    expect(foldSeriesRows(built.value.mode, rows)).toEqual([{ bucket: rows[0].bucket, value: 100 }]);
    db.close();
  });

  it("buckets the events metric by ingested_at, independent of occurred_at", async () => {
    const db = migratedDatabase();
    const HOUR = 3_600;
    // kind carries no span shape, so this only exercises the events table.
    await ingestBatch(db, TOKEN_WORKSPACE, [event({ kind: "trace.started" }, 0)], 10 * HOUR);
    await ingestBatch(db, TOKEN_WORKSPACE, [event({ kind: "trace.started" }, 1)], 10 * HOUR + 100);
    await ingestBatch(db, TOKEN_WORKSPACE, [event({ kind: "trace.started" }, 2)], 12 * HOUR);

    const built = buildSeriesQuery(TOKEN_WORKSPACE, new URL("https://api.handoffgraph.dev/v1/analytics/series?metric=events&interval=hour"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rows = db.prepare(built.value.sql).all(...(built.value.binds as never[])) as Array<{ bucket: number; value: number }>;
    const points = foldSeriesRows(built.value.mode, rows);
    expect(points).toEqual([
      { bucket: 10, value: 2 },
      { bucket: 12, value: 1 },
    ]);
    db.close();
  });

  it("empty store yields an empty series", async () => {
    const db = migratedDatabase();
    const built = buildSeriesQuery(TOKEN_WORKSPACE, new URL("https://api.handoffgraph.dev/v1/analytics/series?metric=spans&interval=hour"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rows = db.prepare(built.value.sql).all(...(built.value.binds as never[])) as Array<{ bucket: number; value: number }>;
    expect(foldSeriesRows(built.value.mode, rows)).toEqual([]);
    db.close();
  });
});

describe("buildSummaryQueries against real SQLite (schema truth)", () => {
  it("aggregates traces/spans/errors/tokens per (provider, model) and exact-sums cost separately", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, [
      event({
        kind: "span.completed",
        provider: "claude",
        model: "opus-5",
        payload: { span_id: "a", trace_id: "trc_1", token_input: 10, token_output: 2, cost_amount: "0.1", cost_provenance: "provider_reported" },
      }, 0),
      event({
        kind: "span.failed",
        provider: "claude",
        model: "opus-5",
        payload: { span_id: "b", trace_id: "trc_1", token_input: 5, token_output: 1, cost_amount: "0.2", cost_provenance: "provider_reported" },
      }, 1),
    ]);
    const built = buildSummaryQueries(TOKEN_WORKSPACE, new URL("https://api.handoffgraph.dev/v1/analytics/summary"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const counts = db.prepare(built.value.countsSQL).all(...(built.value.countsBinds as never[]));
    const costs = db.prepare(built.value.costSQL).all(...(built.value.costBinds as never[]));
    const groups = buildSummaryGroups(
      counts as never[],
      costs as never[],
    );
    expect(groups).toEqual([
      {
        provider: "claude",
        model: "opus-5",
        traces: 1,
        spans: 2,
        errors: 1,
        error_rate: 0.5,
        tokens_in: 15,
        tokens_out: 3,
        cost: "0.3",
      },
    ]);
    db.close();
  });
});

describe("buildFunnelScopeQuery against real SQLite (schema truth)", () => {
  it("counts distinct traces and returns deterministically ordered span rows", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, [
      event({ kind: "span.completed", occurred_at: "2026-08-21T10:00:00Z", payload: { span_id: "s1", trace_id: "trc_2", tool_name: "Bash" } }, 0),
      event({ kind: "span.completed", occurred_at: "2026-08-21T10:01:00Z", payload: { span_id: "s2", trace_id: "trc_1", tool_name: "Bash" } }, 1),
    ]);
    const scope = buildFunnelScopeQuery(TOKEN_WORKSPACE, null, null, null);
    const countRow = db.prepare(scope.countSQL).get(...(scope.countBinds as never[])) as { trace_count: number };
    expect(countRow.trace_count).toBe(2);
    const rows = db.prepare(scope.rowsSQL).all(...(scope.rowsBinds as never[])) as unknown as FunnelSpanRow[];
    expect(rows.map((r) => r.trace_id)).toEqual(["trc_1", "trc_2"]); // ORDER BY trace_id ASC
    db.close();
  });

  it("prunes by workstream and time bounds the same way the observation queries do", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, [
      event({ kind: "span.completed", occurred_at: "2026-08-21T10:00:00Z", workstream_id: WORKSTREAM, payload: { span_id: "s1", trace_id: "trc_1" } }, 0),
      event({ kind: "span.completed", occurred_at: "2026-08-21T10:00:00Z", workstream_id: `ws_${"1".repeat(25)}Z`, payload: { span_id: "s2", trace_id: "trc_2" } }, 1),
    ]);
    const scope = buildFunnelScopeQuery(TOKEN_WORKSPACE, WORKSTREAM, null, null);
    const countRow = db.prepare(scope.countSQL).get(...(scope.countBinds as never[])) as { trace_count: number };
    expect(countRow.trace_count).toBe(1);
    db.close();
  });
});

// ==============================================================================
// handlers (mocked D1) — mirrors ingest.test.ts's / observations.test.ts's mockDb
// ==============================================================================

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (sql: string, binds: unknown[]) => unknown;
  all?: (sql: string, binds: unknown[]) => unknown[] | Promise<unknown[]>;
} = {}) {
  const statements: RecordedStatement[] = [];
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
          return ((await handlers.first?.(sql, record.binds)) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: ((await handlers.all?.(sql, record.binds)) ?? []) as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      statements.push(record);
      return record;
    },
    async batch(batchStatements: D1BoundStatement[]) {
      return batchStatements.map(() => ({ success: true }));
    },
  };
  return { db, statements };
}

const CTX = {} as never;

function makeEnv(
  db: D1DatabaseLike,
  analytics?: AnalyticsEngineDatasetLike,
): { DB: D1DatabaseLike; ANALYTICS?: AnalyticsEngineDatasetLike } {
  return analytics === undefined ? { DB: db } : { DB: db, ANALYTICS: analytics };
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

function registry(overrides: Record<string, unknown> = {}) {
  return (sql: string): unknown => (sql.includes("FROM devices") ? deviceRow(overrides) : null);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

describe("handleAnalyticsRoute", () => {
  it("returns null for a path it does not own", async () => {
    const { db } = mockDb();
    expect(await handleAnalyticsRoute(request("/v1/other"), makeEnv(db))).toBeNull();
  });
});

describe("worker: analytics auth + routing", () => {
  it("404s a known analytics path with the wrong method", async () => {
    const { db } = mockDb({ first: registry() });
    const response = await worker.fetch(
      request("/v1/analytics/series", { method: "POST", headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(404);
  });

  it("requires authentication", async () => {
    const { db } = mockDb();
    const response = await worker.fetch(request("/v1/analytics/series?metric=spans&interval=hour"), makeEnv(db), CTX);
    expect(response.status).toBe(401);
  });

  it("requires the read capability", async () => {
    const { db } = mockDb({ first: registry({ capabilities: "ingest" }) });
    const response = await worker.fetch(
      request("/v1/analytics/series?metric=spans&interval=hour", { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(403);
  });
});

describe("worker: GET /v1/analytics/series", () => {
  it("returns folded points and scopes the query to the token workspace", async () => {
    const seenBinds: unknown[][] = [];
    const { db } = mockDb({
      first: registry(),
      all: (sql, binds) => {
        seenBinds.push(binds);
        expect(sql).toContain("FROM span_observations");
        return [{ bucket: 993_186, value: 3 }];
      },
    });
    const response = await worker.fetch(
      request("/v1/analytics/series?metric=spans&interval=hour", { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      metric: "spans",
      interval: "hour",
      points: [{ bucket_start: new Date(993_186 * 3_600 * 1_000).toISOString(), value: 3 }],
    });
    expect(seenBinds[0][0]).toBe(TOKEN_WORKSPACE);
  });

  it("rejects invalid query parameters with 400", async () => {
    const { db } = mockDb({ first: registry() });
    const response = await worker.fetch(
      request("/v1/analytics/series?metric=bogus&interval=hour", { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
  });

  it("returns an empty series for an empty store", async () => {
    const { db } = mockDb({ first: registry(), all: () => [] });
    const response = await worker.fetch(
      request("/v1/analytics/series?metric=cost&interval=day", { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ metric: "cost", interval: "day", points: [] });
  });
});

describe("worker: GET /v1/analytics/summary", () => {
  it("merges counts and cost passes into groups", async () => {
    const { db } = mockDb({
      first: registry(),
      all: (sql) => {
        if (sql.includes("analytics:summary-counts")) {
          return [{ provider: "claude", model: "opus-5", traces: 2, spans: 4, errors: 1, tokens_in: 10, tokens_out: 2 }];
        }
        if (sql.includes("analytics:summary-cost")) {
          return [
            { provider: "claude", model: "opus-5", cost_amount: "0.1" },
            { provider: "claude", model: "opus-5", cost_amount: "0.2" },
          ];
        }
        return [];
      },
    });
    const response = await worker.fetch(request("/v1/analytics/summary", { headers: authed() }), makeEnv(db), CTX);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      groups: [
        {
          provider: "claude",
          model: "opus-5",
          traces: 2,
          spans: 4,
          errors: 1,
          error_rate: 0.25,
          tokens_in: 10,
          tokens_out: 2,
          cost: "0.3",
        },
      ],
    });
  });

  it("returns an empty group list for an empty store", async () => {
    const { db } = mockDb({ first: registry(), all: () => [] });
    const response = await worker.fetch(request("/v1/analytics/summary", { headers: authed() }), makeEnv(db), CTX);
    expect(await response.json()).toEqual({ groups: [] });
  });
});

describe("worker: POST /v1/analytics/funnel", () => {
  function funnelDb(traceCount: number, rows: FunnelSpanRow[]) {
    return mockDb({
      first: (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("analytics:funnel-trace-count")) return { trace_count: traceCount };
        return null;
      },
      all: (sql) => (sql.includes("analytics:funnel-spans") ? rows : []),
    });
  }

  it("computes step conversions end to end", async () => {
    const rows: FunnelSpanRow[] = [
      { trace_id: "t1", span_id: "a", started_at_ns: "100", kind: "TOOL", tool_name: "Bash", status: "ok", name: "Bash" },
      { trace_id: "t1", span_id: "b", started_at_ns: "200", kind: "OTHER", tool_name: null, status: "error", name: "boom" },
      { trace_id: "t2", span_id: "c", started_at_ns: "100", kind: "TOOL", tool_name: "Bash", status: "ok", name: "Bash" },
    ];
    const { db } = funnelDb(2, rows);
    const response = await worker.fetch(
      request("/v1/analytics/funnel", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ steps: [{ tool_name: "Bash" }, { status: "error" }] }),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { traces_scanned: number; steps: Array<Record<string, unknown>> };
    expect(body.traces_scanned).toBe(2);
    expect(body.steps[0]).toMatchObject({ step: 1, matched_traces: 2, conversion_from_first: 1 });
    expect(body.steps[1]).toMatchObject({ step: 2, matched_traces: 1, conversion_from_first: 0.5 });
  });

  it("400s with guidance when the scope exceeds the trace scan ceiling, without scanning rows", async () => {
    let scanned = false;
    const { db } = mockDb({
      first: (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("analytics:funnel-trace-count")) return { trace_count: MAX_FUNNEL_TRACES + 1 };
        return null;
      },
      all: (sql) => {
        if (sql.includes("analytics:funnel-spans")) scanned = true;
        return [];
      },
    });
    const response = await worker.fetch(
      request("/v1/analytics/funnel", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ steps: [{ kind: "TOOL" }] }),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("funnel_scope_too_large");
    expect(body.guidance).toBeTruthy();
    expect(scanned).toBe(false);
  });

  it("rejects a malformed body with 400 before querying D1", async () => {
    const { db, statements } = funnelDb(0, []);
    const response = await worker.fetch(
      request("/v1/analytics/funnel", { method: "POST", headers: authed(), body: JSON.stringify({ steps: [] }) }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
    expect(statements.some((s) => s.sql.includes("analytics:funnel"))).toBe(false);
  });

  it("rejects invalid JSON", async () => {
    const { db } = funnelDb(0, []);
    const response = await worker.fetch(
      request("/v1/analytics/funnel", { method: "POST", headers: authed(), body: "{not json" }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
  });

  it("returns zeroed steps for an empty store", async () => {
    const { db } = funnelDb(0, []);
    const response = await worker.fetch(
      request("/v1/analytics/funnel", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ steps: [{ kind: "TOOL" }] }),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { traces_scanned: number; steps: Array<Record<string, unknown>> };
    expect(body.traces_scanned).toBe(0);
    expect(body.steps[0]).toMatchObject({ matched_traces: 0, conversion_from_first: 0 });
  });
});

// ==============================================================================
// ingest wiring: recordIngestDataPoints must never affect POST /v1/event-batches
// ==============================================================================

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
    period_start: 1_700_000_000,
    period_end: 1_900_000_000,
    ...overrides,
  };
}

function ingestRegistry() {
  return async (sql: string): Promise<unknown> => {
    if (sql.includes("FROM devices")) return deviceRow();
    if (sql.includes("quota:read-policy")) return entitlementRow();
    return null;
  };
}

function eventBatchEnvelope(): Record<string, unknown> {
  return {
    schema_version: "hfg.event-batch.v1",
    events: [
      {
        schema_version: "hfg.event.v1",
        event_id: eventId(0),
        kind: "span.completed",
        occurred_at: "2026-08-21T10:00:00Z",
        observed_at: "2026-08-21T10:00:01Z",
        provenance: "OBSERVED",
        payload: { span_id: "spn_ae", token_input: 10, token_output: 2 },
      },
    ],
  };
}

describe("worker: POST /v1/event-batches Analytics Engine mirror", () => {
  it("never fails ingest when the ANALYTICS binding throws", async () => {
    const { db } = mockDb({ first: ingestRegistry() });
    const throwingAnalytics: AnalyticsEngineDatasetLike = {
      writeDataPoint: () => {
        throw new Error("boom");
      },
    };
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "ae-throws" }),
        body: JSON.stringify(eventBatchEnvelope()),
      }),
      makeEnv(db, throwingAnalytics),
      CTX,
    );
    expect(response.status).toBe(200);
  });

  it("mirrors an accepted batch's kinds to a captured ANALYTICS binding", async () => {
    const { db } = mockDb({ first: ingestRegistry() });
    const captured: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> = [];
    const analytics: AnalyticsEngineDatasetLike = {
      writeDataPoint: (point) => {
        captured.push(point);
      },
    };
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "ae-captures" }),
        body: JSON.stringify(eventBatchEnvelope()),
      }),
      makeEnv(db, analytics),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].blobs).toEqual([TOKEN_WORKSPACE, "span.completed"]);
    expect(captured[0].doubles).toEqual([1, 10, 2, 0]);
  });

  it("succeeds identically with no ANALYTICS binding at all", async () => {
    const { db } = mockDb({ first: ingestRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "ae-absent" }),
        body: JSON.stringify(eventBatchEnvelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
  });
});
