// Deterministic mock data used when /api is unreachable (e.g. `npm run dev`
// without the Go server, or before backend wiring). Mirrors the shapes of
// internal/webui responses exactly. Every view renders a "mock data" badge
// when these are in play — the provenance of what you are looking at is
// never hidden.

import type {
  DatasetVersion,
  ExampleStatus,
  ExperimentCompare,
  ExperimentComparison,
  ExperimentRun,
  Prompt,
  PromptBody,
  PromptLabel,
  Score,
  Span,
  Trace,
  VersionInfo,
  Workstream,
} from './types'

/**
 * The version shown when no Go binary is answering /api/version — `npm run
 * dev`, or the built bundle opened without the server. It is the ONE literal
 * for that case: App.tsx's footer fallback reads it from here rather than
 * carrying a second copy that could drift.
 */
export const MOCK_VERSION = 'v0.7.0-beta.1'

export function mockVersion(): VersionInfo {
  return { version: MOCK_VERSION }
}

// Fixed reference: 2026-08-21T12:00:00Z in ns.
const BASE_NS = Date.UTC(2026, 7, 21, 12, 0, 0) * 1_000_000
const ns = (ms: number): number => BASE_NS + ms * 1_000_000

export function mockWorkstreams(): Workstream[] {
  return [
    {
      id: 'ws_01J2MOCKWORKSTREAM01',
      title: 'Fix checkout race condition',
      status: 'active',
      created_at: '2026-08-21T11:41:02Z',
      event_count: 1284,
      trace_count: 3,
    },
    {
      id: 'ws_01J2MOCKWORKSTREAM02',
      title: 'Migrate redaction engine to glob patterns',
      status: 'active',
      created_at: '2026-08-21T09:12:44Z',
      event_count: 733,
      trace_count: 2,
    },
  ]
}

export function mockTraces(): Trace[] {
  return [
    {
      schema_version: 'hfg.trace.v1',
      trace_id: 'trc_01J2MOCKTRACE000001',
      workstream_id: 'ws_01J2MOCKWORKSTREAM01',
      session_id: 'ses_01J2MOCKSESSION0001',
      provider: 'codex',
      objective_excerpt: 'Reproduce the checkout race with the parallel fixture',
      status: 'ERROR',
      started_at_ns: ns(0),
      ended_at_ns: ns(4200),
      duration_ns: 4200 * 1_000_000,
      span_count: 9,
      failed_span_count: 2,
      changed_file_count: 2,
      verification_state: 'failed',
      root_span_id: 'spn_01J2MOCKSPAN0000001',
      token_input: 18422,
      token_output: 6104,
      cost_amount: '0.0421',
      cost_currency: 'USD',
      cost_provenance: 'provider_reported',
      content_policy: 'metadata_only',
    },
    {
      schema_version: 'hfg.trace.v1',
      trace_id: 'trc_01J2MOCKTRACE000002',
      workstream_id: 'ws_01J2MOCKWORKSTREAM01',
      session_id: 'ses_01J2MOCKSESSION0002',
      provider: 'codex',
      objective_excerpt: 'Add the regression test for the WAL reopen crash',
      status: 'OK',
      started_at_ns: ns(6000),
      ended_at_ns: ns(9100),
      duration_ns: 3100 * 1_000_000,
      span_count: 6,
      failed_span_count: 0,
      changed_file_count: 1,
      verification_state: 'verified',
      root_span_id: 'spn_01J2MOCKSPAN0000011',
      cost_amount: '0.0188',
      cost_currency: 'USD',
      cost_provenance: 'catalog_estimate',
    },
    {
      schema_version: 'hfg.trace.v1',
      trace_id: 'trc_01J2MOCKTRACE000003',
      workstream_id: 'ws_01J2MOCKWORKSTREAM01',
      session_id: 'ses_01J2MOCKSESSION0003',
      provider: 'codex',
      objective_excerpt: 'Summarize the session for the handoff checkpoint',
      status: 'INTERRUPTED',
      started_at_ns: ns(12000),
      ended_at_ns: ns(13400),
      duration_ns: 1400 * 1_000_000,
      span_count: 3,
      failed_span_count: 0,
      changed_file_count: 0,
      verification_state: 'missing',
      root_span_id: 'spn_01J2MOCKSPAN0000021',
    },
    {
      schema_version: 'hfg.trace.v1',
      trace_id: 'trc_01J2MOCKTRACE000004',
      workstream_id: 'ws_01J2MOCKWORKSTREAM01',
      session_id: 'ses_01J2MOCKSESSION0004',
      provider: 'codex',
      objective_excerpt: 'Live debugging pass over the importer',
      status: 'RUNNING',
      started_at_ns: ns(20000),
      span_count: 3,
      failed_span_count: 0,
      changed_file_count: 0,
      verification_state: 'unknown',
      root_span_id: 'spn_01J2MOCKSPAN0000031',
    },
    {
      schema_version: 'hfg.trace.v1',
      trace_id: 'trc_01J2MOCKTRACE000005',
      workstream_id: 'ws_01J2MOCKWORKSTREAM02',
      session_id: 'ses_01J2MOCKSESSION0005',
      provider: 'claude',
      objective_excerpt: 'Port redaction patterns to path.Match semantics',
      status: 'OK',
      started_at_ns: ns(0),
      ended_at_ns: ns(8800),
      duration_ns: 8800 * 1_000_000,
      span_count: 5,
      failed_span_count: 0,
      changed_file_count: 3,
      verification_state: 'verified',
      root_span_id: 'spn_01J2MOCKSPAN0000041',
      token_input: 44102,
      token_output: 9871,
      cost_amount: '0.1170',
      cost_currency: 'USD',
      cost_provenance: 'provider_reported',
    },
    {
      schema_version: 'hfg.trace.v1',
      trace_id: 'trc_01J2MOCKTRACE000006',
      workstream_id: 'ws_01J2MOCKWORKSTREAM02',
      session_id: 'ses_01J2MOCKSESSION0006',
      provider: 'claude',
      objective_excerpt: 'Compacted tail of a long session',
      status: 'COMPACTED',
      started_at_ns: ns(15000),
      ended_at_ns: ns(15200),
      duration_ns: 200 * 1_000_000,
      span_count: 1,
      failed_span_count: 0,
      changed_file_count: 0,
      verification_state: 'unknown',
      root_span_id: 'spn_01J2MOCKSPAN0000051',
    },
  ]
}

export function mockSpans(traceID: string): Span[] {
  const mk = (
    id: string,
    parent: string,
    name: string,
    kind: Span['kind'],
    status: Span['status'],
    startMs: number,
    endMs: number | undefined,
    seq: number,
    extra: Partial<Span> = {},
  ): Span => ({
    span_id: id,
    trace_id: traceID,
    session_id: 'ses_01J2MOCKSESSION0001',
    parent_span_id: parent || undefined,
    kind,
    name,
    status,
    started_at_ns: ns(startMs),
    ended_at_ns: endMs === undefined ? undefined : ns(endMs),
    sequence: seq,
    provider: 'codex',
    evidence_level: 'OBSERVED',
    normalizer_version: 'v1',
    source_schema_version: 'hfg.event.v1',
    ...extra,
  })

  switch (traceID) {
    case 'trc_01J2MOCKTRACE000001':
      return [
        // Overlapping children of the agent span + idle gaps between
        // phases, so the waterfall shows both.
        mk('spn_01J2MOCKSPAN0000001', '', 'agent turn (root)', 'AGENT', 'ok', 0, 4200, 0, {
          model: 'gpt-5-codex',
        }),
        mk('spn_01J2MOCKSPAN0000002', 'spn_01J2MOCKSPAN0000001', 'think', 'MODEL', 'ok', 40, 620, 1, {
          model: 'gpt-5-codex',
        }),
        mk('spn_01J2MOCKSPAN0000003', 'spn_01J2MOCKSPAN0000001', 'grep fixture', 'TOOL', 'ok', 620, 900, 2, {
          tool_name: 'grep',
        }),
        // Overlaps with the grep above (same window).
        mk('spn_01J2MOCKSPAN0000004', 'spn_01J2MOCKSPAN0000001', 'read events.go', 'FILE_READ', 'ok', 640, 940, 3, {
          file_identity_hash: 'sha256:9f2c',
        }),
        // Idle gap 940ms -> 1700ms.
        mk('spn_01J2MOCKSPAN0000005', 'spn_01J2MOCKSPAN0000001', 'go test ./internal/storage', 'COMMAND', 'error', 1700, 3100, 4, {
          exit_code: 1,
          command_fingerprint: 'cmdfp:a71f',
        }),
        mk('spn_01J2MOCKSPAN0000006', 'spn_01J2MOCKSPAN0000005', 'TestAppendLatencyP95', 'TEST', 'error', 1750, 3050, 5, {
          exit_code: 1,
        }),
        mk('spn_01J2MOCKSPAN0000007', 'spn_01J2MOCKSPAN0000001', 'edit db.go', 'FILE_WRITE', 'ok', 3150, 3500, 6, {
          file_identity_hash: 'sha256:41ba',
        }),
        mk('spn_01J2MOCKSPAN0000008', 'spn_01J2MOCKSPAN0000001', 'go build ./...', 'BUILD', 'ok', 3520, 3900, 7, {
          exit_code: 0,
        }),
        // DECLARED evidence: the agent asserted this next step.
        mk('spn_01J2MOCKSPAN0000009', 'spn_01J2MOCKSPAN0000001', 'plan: fix WAL reopen', 'OTHER', 'ok', 3950, 4150, 8, {
          evidence_level: 'DECLARED',
        }),
      ]
    case 'trc_01J2MOCKTRACE000002':
      return [
        mk('spn_01J2MOCKSPAN0000011', '', 'agent turn (root)', 'AGENT', 'ok', 6000, 9100, 10, {
          session_id: 'ses_01J2MOCKSESSION0002',
          model: 'gpt-5-codex',
        }),
        mk('spn_01J2MOCKSPAN0000012', 'spn_01J2MOCKSPAN0000011', 'think', 'MODEL', 'ok', 6040, 7000, 11, {
          session_id: 'ses_01J2MOCKSESSION0002',
          model: 'gpt-5-codex',
        }),
        mk('spn_01J2MOCKSPAN0000013', 'spn_01J2MOCKSPAN0000011', 'write bench_test.go', 'FILE_WRITE', 'ok', 7100, 8200, 12, {
          session_id: 'ses_01J2MOCKSESSION0002',
          file_identity_hash: 'sha256:c0de',
        }),
        mk('spn_01J2MOCKSPAN0000014', 'spn_01J2MOCKSPAN0000011', 'go test -race', 'COMMAND', 'ok', 8250, 9000, 13, {
          session_id: 'ses_01J2MOCKSESSION0002',
          exit_code: 0,
        }),
        // INFERRED evidence: normalized summary, not a direct observation.
        mk('spn_01J2MOCKSPAN0000015', 'spn_01J2MOCKSPAN0000014', 'tests passed (inferred rollup)', 'TEST', 'ok', 8600, 8950, 14, {
          session_id: 'ses_01J2MOCKSESSION0002',
          evidence_level: 'INFERRED',
        }),
        mk('spn_01J2MOCKSPAN0000016', 'spn_01J2MOCKSPAN0000011', 'read HANDOVER.md', 'RETRIEVAL', 'ok', 9020, 9090, 15, {
          session_id: 'ses_01J2MOCKSESSION0002',
        }),
      ]
    case 'trc_01J2MOCKTRACE000003':
      return [
        mk('spn_01J2MOCKSPAN0000021', '', 'agent turn (root)', 'AGENT', 'unknown', 12000, 13400, 20, {
          session_id: 'ses_01J2MOCKSESSION0003',
        }),
        mk('spn_01J2MOCKSPAN0000022', 'spn_01J2MOCKSPAN0000021', 'think', 'MODEL', 'unknown', 12020, 13400, 21, {
          session_id: 'ses_01J2MOCKSESSION0003',
        }),
        mk('spn_01J2MOCKSPAN0000023', 'spn_01J2MOCKSPAN0000021', 'draft summary', 'OTHER', 'running', 13000, undefined, 22, {
          session_id: 'ses_01J2MOCKSESSION0003',
          evidence_level: 'INFERRED',
        }),
      ]
    case 'trc_01J2MOCKTRACE000004':
      return [
        mk('spn_01J2MOCKSPAN0000031', '', 'agent turn (root)', 'AGENT', 'running', 20000, undefined, 30, {
          session_id: 'ses_01J2MOCKSESSION0004',
        }),
        mk('spn_01J2MOCKSPAN0000032', 'spn_01J2MOCKSPAN0000031', 'inspect spool', 'TOOL', 'running', 20300, undefined, 31, {
          session_id: 'ses_01J2MOCKSESSION0004',
          tool_name: 'inspect',
        }),
        mk('spn_01J2MOCKSPAN0000033', 'spn_01J2MOCKSPAN0000031', 'log tail', 'LOG', 'ok', 20100, 20400, 32, {
          session_id: 'ses_01J2MOCKSESSION0004',
        }),
      ]
    case 'trc_01J2MOCKTRACE000005':
      return [
        mk('spn_01J2MOCKSPAN0000041', '', 'agent turn (root)', 'AGENT', 'ok', 0, 8800, 40, {
          session_id: 'ses_01J2MOCKSESSION0005',
          provider: 'claude',
          model: 'claude-opus-4',
        }),
        mk('spn_01J2MOCKSPAN0000042', 'spn_01J2MOCKSPAN0000041', 'think', 'MODEL', 'ok', 50, 2400, 41, {
          session_id: 'ses_01J2MOCKSESSION0005',
          provider: 'claude',
          model: 'claude-opus-4',
        }),
        mk('spn_01J2MOCKSPAN0000043', 'spn_01J2MOCKSPAN0000041', 'edit patterns.go', 'FILE_WRITE', 'ok', 2450, 6100, 42, {
          session_id: 'ses_01J2MOCKSESSION0005',
          provider: 'claude',
          file_identity_hash: 'sha256:aa17',
        }),
        mk('spn_01J2MOCKSPAN0000044', 'spn_01J2MOCKSPAN0000041', 'go test ./internal/redact', 'COMMAND', 'ok', 6150, 8100, 43, {
          session_id: 'ses_01J2MOCKSESSION0005',
          provider: 'claude',
          exit_code: 0,
        }),
        mk('spn_01J2MOCKSPAN0000045', 'spn_01J2MOCKSPAN0000041', 'BadPattern rejection', 'TEST', 'ok', 7800, 8050, 44, {
          session_id: 'ses_01J2MOCKSESSION0005',
          provider: 'claude',
        }),
      ]
    case 'trc_01J2MOCKTRACE000006':
      return [
        mk('spn_01J2MOCKSPAN0000051', '', 'agent turn (root)', 'AGENT', 'unknown', 15000, 15200, 50, {
          session_id: 'ses_01J2MOCKSESSION0006',
          provider: 'claude',
        }),
      ]
    default:
      return []
  }
}

export function mockTrace(traceID: string): Trace | undefined {
  return mockTraces().find((t) => t.trace_id === traceID)
}

// ---- Scores ----

// Scores are returned newest first by /api/scores; the mock preserves that
// order. Every data type is represented, and so is every provenance level:
// the LLM-judge row is INFERRED and must render distinctly from the
// deterministic OBSERVED rows next to it.
export function mockScores(): Score[] {
  const score = (
    id: string,
    occurredAt: string,
    workstream: string,
    name: string,
    target: Score['target_type'],
    targetID: string,
    source: Score['source'],
    provenance: Score['provenance'],
    slots: Pick<Score, 'data_type' | 'value' | 'string_value' | 'bool_value'>,
    comment?: string,
  ): Score => ({
    schema_version: 'hfg.score.v1',
    score_id: id,
    workstream_id: workstream,
    occurred_at: occurredAt,
    name,
    target_type: target,
    target_id: targetID,
    source,
    provenance,
    comment,
    ...slots,
  })

  return [
    score(
      'evt_01J2MOCKSCORE000006',
      '2026-08-21T12:04:31Z',
      'ws_01J2MOCKWORKSTREAM01',
      'helpfulness',
      'span',
      'spn_01J2MOCKSPAN0000002',
      'evaluation',
      'INFERRED',
      { data_type: 'NUMERIC', value: 0.62 },
      'llm judge (rubric v2): thin evidence for the root-cause claim',
    ),
    score(
      'evt_01J2MOCKSCORE000005',
      '2026-08-21T12:03:02Z',
      'ws_01J2MOCKWORKSTREAM01',
      'objective_met',
      'trace',
      'trc_01J2MOCKTRACE000003',
      'api',
      'DECLARED',
      { data_type: 'CATEGORY', string_value: 'partial' },
      'agent-asserted; the turn was interrupted before verification',
    ),
    score(
      'evt_01J2MOCKSCORE000004',
      '2026-08-21T12:01:44Z',
      'ws_01J2MOCKWORKSTREAM01',
      'verdict',
      'trace',
      'trc_01J2MOCKTRACE000001',
      'human',
      'OBSERVED',
      { data_type: 'CATEGORY', string_value: 'regression' },
      'reviewed the failing WAL reopen test',
    ),
    score(
      'evt_01J2MOCKSCORE000003',
      '2026-08-21T12:01:10Z',
      'ws_01J2MOCKWORKSTREAM01',
      'tests_pass',
      'trace',
      'trc_01J2MOCKTRACE000001',
      'detection',
      'OBSERVED',
      { data_type: 'BOOLEAN', bool_value: false },
    ),
    score(
      'evt_01J2MOCKSCORE000002',
      '2026-08-21T12:00:52Z',
      'ws_01J2MOCKWORKSTREAM01',
      'tests_pass',
      'trace',
      'trc_01J2MOCKTRACE000002',
      'detection',
      'OBSERVED',
      { data_type: 'BOOLEAN', bool_value: true },
    ),
    score(
      'evt_01J2MOCKSCORE000001',
      '2026-08-21T11:58:20Z',
      'ws_01J2MOCKWORKSTREAM02',
      'latency_p95_ms',
      'trace',
      'trc_01J2MOCKTRACE000005',
      'api',
      'OBSERVED',
      { data_type: 'NUMERIC', value: 412.5 },
    ),
  ]
}

// ---- Datasets & experiments ----

// Mock content hashes are shortened for readability; real ones are full
// sha256 digests of the sorted example manifest.
const DS_CORE_V1 = 'sha256:3f1a7c02d95b6e41'
const DS_CORE_V2 = 'sha256:9c74be0d1188a35f'
const DS_HANDOFF_V1 = 'sha256:be0d4471aa20c9e3'

// Sorted the way /api/datasets returns them: by name, then creation order.
export function mockDatasets(): DatasetVersion[] {
  return [
    {
      event_id: 'evt_01J2MOCKDATASET0001',
      name: 'core-regressions',
      version: DS_CORE_V1,
      example_count: 2,
      content_hash: DS_CORE_V1,
      created_at: '2026-08-21T09:14:00Z',
    },
    {
      event_id: 'evt_01J2MOCKDATASET0002',
      name: 'core-regressions',
      version: DS_CORE_V2,
      example_count: 3,
      content_hash: DS_CORE_V2,
      created_at: '2026-08-21T11:02:00Z',
    },
    {
      event_id: 'evt_01J2MOCKDATASET0003',
      name: 'handoff-golden',
      version: DS_HANDOFF_V1,
      example_count: 2,
      content_hash: DS_HANDOFF_V1,
      created_at: '2026-08-20T16:40:00Z',
    },
  ]
}

interface MockExampleResult {
  name: string
  status: ExampleStatus
  p0: number
}

// Per-example verdicts behind each run. The run rows and the comparison are
// both derived from this table, so the mock can never contradict itself.
const experimentResults: Record<string, MockExampleResult[]> = {
  evt_01J2MOCKEXPERIMENT01: [
    { name: 'checkout_race.jsonl', status: 'ok', p0: 0 },
    { name: 'compaction_gap.jsonl', status: 'ok', p0: 0 },
    { name: 'wal_reopen.jsonl', status: 'ok', p0: 0 },
  ],
  evt_01J2MOCKEXPERIMENT02: [
    { name: 'checkout_race.jsonl', status: 'ok', p0: 0 },
    { name: 'compaction_gap.jsonl', status: 'ok', p0: 0 },
    // The regression: a new P0 detection downgraded this example.
    { name: 'wal_reopen.jsonl', status: 'detections', p0: 1 },
  ],
  evt_01J2MOCKEXPERIMENT03: [
    { name: 'accept_handoff.jsonl', status: 'ok', p0: 0 },
    { name: 'reject_stale.jsonl', status: 'ok', p0: 0 },
  ],
}

const experimentMeta: { id: string; dataset: string; version: string; created_at: string }[] = [
  // Newest first, as /api/experiments returns them.
  {
    id: 'evt_01J2MOCKEXPERIMENT02',
    dataset: 'core-regressions',
    version: DS_CORE_V2,
    created_at: '2026-08-21T11:47:00Z',
  },
  {
    id: 'evt_01J2MOCKEXPERIMENT01',
    dataset: 'core-regressions',
    version: DS_CORE_V2,
    created_at: '2026-08-21T11:05:00Z',
  },
  {
    id: 'evt_01J2MOCKEXPERIMENT03',
    dataset: 'handoff-golden',
    version: DS_HANDOFF_V1,
    created_at: '2026-08-20T16:45:00Z',
  },
]

export function mockExperiments(): ExperimentRun[] {
  return experimentMeta.map((meta) => {
    const results = experimentResults[meta.id] ?? []
    const passedCount = results.filter((r) => r.status === 'ok').length
    return {
      id: meta.id,
      dataset: meta.dataset,
      version: meta.version,
      passed: passedCount === results.length,
      passed_count: passedCount,
      failed_count: results.length - passedCount,
      example_count: results.length,
      created_at: meta.created_at,
    }
  })
}

// Mirrors datasets.Compare in Go: examples present in both runs, sorted by
// name, with a regression flagged on a status downgrade or a new P0.
const statusRank: Record<ExampleStatus, number> = { ok: 0, detections: 1, invalid: 2 }

function rankOf(status: ExampleStatus): number {
  return statusRank[status] ?? 2
}

function compareResults(a: MockExampleResult[], b: MockExampleResult[]): ExperimentComparison[] {
  const baseline = new Map(a.map((r) => [r.name, r]))
  return b
    .map((r) => r.name)
    .sort()
    .flatMap((name) => {
      const to = b.find((r) => r.name === name)
      const from = baseline.get(name)
      if (!to || !from) return []
      return [
        {
          file: name,
          from_status: from.status,
          to_status: to.status,
          from_p0: from.p0,
          to_p0: to.p0,
          regression: rankOf(to.status) > rankOf(from.status) || to.p0 > from.p0,
        },
      ]
    })
}

export function mockExperimentCompare(aID: string, bID: string): ExperimentCompare | null {
  const runs = mockExperiments()
  const a = runs.find((r) => r.id === aID)
  const b = runs.find((r) => r.id === bID)
  if (!a || !b) return null
  const items = compareResults(experimentResults[aID] ?? [], experimentResults[bID] ?? [])
  return { a, b, regressions: items.filter((c) => c.regression).length, items }
}

// ---- Prompts ----

interface MockPromptVersion {
  version: number
  body: string
  hash: string
  created_at: string
  created_by?: string
}

const promptVersions: Record<string, MockPromptVersion[]> = {
  'handoff-summary': [
    {
      version: 1,
      body: 'Summarize the session for the next agent.\nList verified facts first, then open questions.',
      hash: 'sha256:5d2f88a10c4b7e93',
      created_at: '2026-08-19T10:20:00Z',
      created_by: 'arbaz',
    },
  ],
  triage: [
    {
      version: 1,
      body: 'You are a triage agent.\nBe terse.',
      hash: 'sha256:11a4c7f0932b6de5',
      created_at: '2026-08-18T08:00:00Z',
      created_by: 'arbaz',
    },
    {
      version: 2,
      body: 'You are a triage agent.\nBe terse.\nCite the evidence you relied on.',
      hash: 'sha256:7b90ee31c5d4a026',
      created_at: '2026-08-20T14:30:00Z',
      created_by: 'arbaz',
    },
    {
      version: 3,
      body:
        'You are a triage agent.\nBe terse.\nCite the evidence you relied on.\n' +
        'Never present an inferred cause as an observed one.',
      hash: 'sha256:c3081f5ab6742d19',
      created_at: '2026-08-21T09:05:00Z',
      created_by: 'arbaz',
    },
  ],
}

// Explicit label pointers. `latest` is resolved from the version ladder, the
// way the server derives it, so a rollback only moves `production`.
const promptLabels: Record<string, PromptLabel[]> = {
  'handoff-summary': [],
  triage: [{ label: 'production', version: 2 }],
}

function resolveLabels(name: string): PromptLabel[] {
  const versions = promptVersions[name] ?? []
  const latest = versions.length ? versions[versions.length - 1].version : 0
  const resolved = new Map<string, number>()
  if (latest > 0) resolved.set('latest', latest)
  for (const ref of promptLabels[name] ?? []) resolved.set(ref.label, ref.version)
  return [...resolved.entries()]
    .map(([label, version]) => ({ label, version }))
    .sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0))
}

export function mockPrompts(): Prompt[] {
  return Object.keys(promptVersions)
    .sort()
    .map((name) => {
      const versions = promptVersions[name]
      const latest = versions[versions.length - 1]
      return {
        name,
        version_count: versions.length,
        latest_version: latest.version,
        latest_hash: latest.hash,
        latest_created_at: latest.created_at,
        labels: resolveLabels(name),
        versions: versions.map((v) => ({
          version: v.version,
          hash: v.hash,
          created_at: v.created_at,
          created_by: v.created_by,
        })),
      }
    })
}

export function mockPromptBody(name: string, version?: number): PromptBody | null {
  const versions = promptVersions[name]
  if (!versions || versions.length === 0) return null
  const labels = resolveLabels(name)
  const want = version ?? versions[versions.length - 1].version
  const found = versions.find((v) => v.version === want)
  if (!found) return null
  return {
    name,
    version: found.version,
    body: found.body,
    hash: found.hash,
    created_at: found.created_at,
    created_by: found.created_by,
    labels: labels.filter((l) => l.version === found.version).map((l) => l.label),
    latest_version: versions[versions.length - 1].version,
    version_count: versions.length,
  }
}
