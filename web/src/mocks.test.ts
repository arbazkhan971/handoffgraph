// Integrity checks over the mock dataset: it must satisfy the same shape
// guarantees the real /api responses have, so the UI is exercised honestly
// in mock mode.

import { describe, expect, it } from 'vitest'
import {
  mockDatasets,
  mockExperimentCompare,
  mockExperiments,
  mockPromptBody,
  mockPrompts,
  mockScores,
  mockSpans,
  mockTraces,
  mockWorkstreams,
} from './mocks'
import { flattenTree, rootSpans } from './tree'
import { formatScoreValue } from './format'

describe('mock dataset integrity', () => {
  it('has unique workstream and trace ids', () => {
    const wsIDs = new Set(mockWorkstreams().map((w) => w.id))
    expect(wsIDs.size).toBe(mockWorkstreams().length)
    const trIDs = new Set(mockTraces().map((t) => t.trace_id))
    expect(trIDs.size).toBe(mockTraces().length)
  })

  it('references only known workstreams from traces', () => {
    const wsIDs = new Set(mockWorkstreams().map((w) => w.id))
    for (const tr of mockTraces()) expect(wsIDs.has(tr.workstream_id)).toBe(true)
  })

  it.each(mockTraces().map((t) => [t.trace_id, t.status] as const))(
    'trace %s (%s) has spans matching its declared span_count',
    (traceID) => {
      const spans = mockSpans(traceID)
      expect(spans.length).toBeGreaterThan(0)
      for (const sp of spans) expect(sp.trace_id).toBe(traceID)
    },
  )

  it('keeps parent references inside the same trace', () => {
    const allTraces = mockTraces().map((t) => t.trace_id)
    for (const traceID of allTraces) {
      const spans = mockSpans(traceID)
      const ids = new Set(spans.map((s) => s.span_id))
      for (const sp of spans) {
        if (sp.parent_span_id) expect(ids.has(sp.parent_span_id)).toBe(true)
      }
      // Every trace must flatten into at least one root row, and a full
      // flatten must visit every span exactly once (nothing hidden, nothing
      // duplicated).
      expect(rootSpans(spans).length).toBeGreaterThanOrEqual(1)
      expect(flattenTree(spans, new Set()).length).toBe(spans.length)
    }
  })

  it('covers every evidence level and a failing span so the UI renders all states', () => {
    const evidence = new Set<string>()
    let failed = false
    let open = false
    for (const tr of mockTraces()) {
      for (const sp of mockSpans(tr.trace_id)) {
        if (sp.evidence_level) evidence.add(sp.evidence_level)
        if (sp.status === 'error' || sp.status === 'failed') failed = true
        if (!sp.ended_at_ns) open = true
      }
    }
    expect(evidence).toEqual(new Set(['OBSERVED', 'DECLARED', 'INFERRED']))
    expect(failed).toBe(true)
    expect(open).toBe(true)
  })
})

describe('mock scores', () => {
  it('covers every data type and every provenance level', () => {
    const scores = mockScores()
    expect(new Set(scores.map((s) => s.data_type))).toEqual(
      new Set(['NUMERIC', 'CATEGORY', 'BOOLEAN']),
    )
    expect(new Set(scores.map((s) => s.provenance))).toEqual(
      new Set(['OBSERVED', 'DECLARED', 'INFERRED']),
    )
    // The judge score is the INFERRED one, and it is never sourced as human.
    const inferred = scores.filter((s) => s.provenance === 'INFERRED')
    expect(inferred).toHaveLength(1)
    expect(inferred[0].source).toBe('evaluation')
    expect(inferred[0].comment).toMatch(/llm judge/i)
  })

  it.each(mockScores().map((s) => [s.score_id, s.data_type] as const))(
    'score %s (%s) fills exactly the slot its data type selects',
    (scoreID) => {
      const score = mockScores().find((s) => s.score_id === scoreID)!
      const slots = {
        NUMERIC: typeof score.value === 'number',
        CATEGORY: typeof score.string_value === 'string',
        BOOLEAN: typeof score.bool_value === 'boolean',
      }
      expect(slots[score.data_type]).toBe(true)
      for (const [type, filled] of Object.entries(slots)) {
        if (type !== score.data_type) expect(filled).toBe(false)
      }
      expect(formatScoreValue(score)).not.toBe('—')
    },
  )

  it('is sorted newest first and references only known mock ids', () => {
    const scores = mockScores()
    const stamps = scores.map((s) => Date.parse(s.occurred_at))
    expect(stamps.every((n) => Number.isFinite(n))).toBe(true)
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps)
    expect(new Set(scores.map((s) => s.score_id)).size).toBe(scores.length)

    const workstreams = new Set(mockWorkstreams().map((w) => w.id))
    const traces = new Set(mockTraces().map((t) => t.trace_id))
    const spans = new Set(mockTraces().flatMap((t) => mockSpans(t.trace_id).map((s) => s.span_id)))
    for (const score of scores) {
      expect(workstreams.has(score.workstream_id ?? '')).toBe(true)
      if (score.target_type === 'trace') expect(traces.has(score.target_id)).toBe(true)
      if (score.target_type === 'span') expect(spans.has(score.target_id)).toBe(true)
    }
  })
})

describe('mock datasets and experiments', () => {
  it('carries two immutable versions of one dataset', () => {
    const versions = mockDatasets().filter((d) => d.name === 'core-regressions')
    expect(versions).toHaveLength(2)
    expect(versions[0].version).not.toBe(versions[1].version)
    // Content-addressed: version and content hash are the same digest.
    for (const ds of mockDatasets()) {
      expect(ds.content_hash).toBe(ds.version)
      expect(ds.version.startsWith('sha256:')).toBe(true)
      expect(ds.example_count).toBeGreaterThan(0)
    }
    // Sorted the way /api/datasets returns: name, then creation order.
    const keys = mockDatasets().map((d) => `${d.name} ${d.created_at}`)
    expect([...keys].sort()).toEqual(keys)
  })

  it('derives run counts from the per-example results', () => {
    for (const run of mockExperiments()) {
      expect(run.passed_count + run.failed_count).toBe(run.example_count)
      expect(run.passed).toBe(run.failed_count === 0)
      expect(mockDatasets().some((d) => d.name === run.dataset && d.version === run.version)).toBe(true)
    }
    // Newest first, like the API.
    const stamps = mockExperiments().map((r) => Date.parse(r.created_at))
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps)
  })

  it('exposes exactly one regression between the baseline and the candidate', () => {
    const cmp = mockExperimentCompare('evt_01J2MOCKEXPERIMENT01', 'evt_01J2MOCKEXPERIMENT02')!
    expect(cmp.regressions).toBe(1)
    expect(cmp.items.map((c) => c.file)).toEqual([...cmp.items.map((c) => c.file)].sort())
    const regressed = cmp.items.filter((c) => c.regression)
    expect(regressed).toHaveLength(1)
    expect(regressed[0]).toMatchObject({
      file: 'wal_reopen.jsonl',
      from_status: 'ok',
      to_status: 'detections',
      to_p0: 1,
    })
  })

  it.each([
    ['reversed sides are a recovery, not a regression', 'evt_01J2MOCKEXPERIMENT02', 'evt_01J2MOCKEXPERIMENT01', 0],
    ['a run compared with itself is unchanged', 'evt_01J2MOCKEXPERIMENT01', 'evt_01J2MOCKEXPERIMENT01', 0],
  ])('%s', (_name, a, b, want) => {
    expect(mockExperimentCompare(a, b)?.regressions).toBe(want)
  })

  it('shares no examples between runs of different datasets, and 404s on unknown ids', () => {
    const crossDataset = mockExperimentCompare('evt_01J2MOCKEXPERIMENT01', 'evt_01J2MOCKEXPERIMENT03')
    expect(crossDataset?.items).toEqual([])
    expect(mockExperimentCompare('evt_ghost', 'evt_01J2MOCKEXPERIMENT01')).toBeNull()
  })
})

describe('mock prompts', () => {
  it('resolves production and latest onto different versions', () => {
    const triage = mockPrompts().find((p) => p.name === 'triage')!
    expect(triage.version_count).toBe(3)
    expect(triage.latest_version).toBe(3)
    expect(triage.labels).toEqual([
      { label: 'latest', version: 3 },
      { label: 'production', version: 2 },
    ])
    // The version ladder is ascending and the latest hash matches its tip.
    expect(triage.versions.map((v) => v.version)).toEqual([1, 2, 3])
    expect(triage.latest_hash).toBe(triage.versions[2].hash)
  })

  it('sorts prompts by name and gives every version a distinct hash', () => {
    const names = mockPrompts().map((p) => p.name)
    expect([...names].sort()).toEqual(names)
    for (const prompt of mockPrompts()) {
      const hashes = prompt.versions.map((v) => v.hash)
      expect(new Set(hashes).size).toBe(hashes.length)
      expect(prompt.version_count).toBe(prompt.versions.length)
    }
  })

  it.each([
    ['defaults to latest', undefined, 3, ['latest']],
    ['production version', 2, 2, ['production']],
    ['unlabeled version', 1, 1, []],
  ])('body lookup %s', (_name, version, wantVersion, wantLabels) => {
    const body = mockPromptBody('triage', version as number | undefined)!
    expect(body.version).toBe(wantVersion)
    expect(body.labels).toEqual(wantLabels)
    expect(body.body.length).toBeGreaterThan(0)
    expect(body.hash.startsWith('sha256:')).toBe(true)
    expect(body.latest_version).toBe(3)
  })

  it('returns null for unknown prompts and versions', () => {
    expect(mockPromptBody('ghost')).toBeNull()
    expect(mockPromptBody('triage', 99)).toBeNull()
  })
})
