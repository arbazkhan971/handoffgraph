// Deterministic mock data used when /api is unreachable (e.g. `npm run dev`
// without the Go server, or before backend wiring). Mirrors the shapes of
// internal/webui responses exactly. Every view renders a "mock data" badge
// when these are in play — the provenance of what you are looking at is
// never hidden.

import type { Span, Trace, Workstream } from './types'

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
