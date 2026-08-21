package detection

import "fmt"

// defaultPackYAML is the embedded v0.5.0 launch detection pack (roadmap
// "Detection pack v0"). Rules are versioned: changing a rule's behavior
// requires bumping its version, never editing history in place.
//
// Rule notes:
//   - nonzero-command-exit / failed-test fire per span inside a trace.
//   - repeated-failing-operation groups failing spans by command
//     fingerprint across the whole workstream (>= 3).
//   - likely-loop groups non-orchestration spans by operation name within a
//     single trace (>= 5).
//   - completion-claim-without-verification flags OK traces whose observed
//     verification is not "verified".
//   - repo-drift-from-checkpoint flags traces with file activity that did
//     not end OK, so the worktree can be compared against the latest
//     checkpoint.
//   - concurrent-file-touch flags files written more than once within one
//     trace.
//   - compaction-before-checkpoint flags traces whose session was compacted
//     while the trace was still open.
//   - secret-match-blocker uses span.secret_match, computed by
//     internal/redact over the span name.
//   - token-latency-threshold fires when reliable duration data shows a
//     trace ran longer than 60s.
const defaultPackYAML = `- id: nonzero-command-exit
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: span.kind
        op: eq
        value: COMMAND
      - field: span.exit_code
        op: neq
        value: 0
  group_by: span.span_id
  threshold:
    count_gte: 1
  severity: error
  message: "Command exited with a non-zero exit code."
- id: failed-test
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: span.kind
        op: eq
        value: TEST
      - field: span.status
        op: eq
        value: error
  group_by: span.span_id
  threshold:
    count_gte: 1
  severity: error
  message: "A test failed."
- id: repeated-failing-operation
  version: 1.0.0
  scope: workstream
  when:
    conditions:
      - field: span.status
        op: eq
        value: error
      - field: span.command_fingerprint
        op: exists
  group_by: span.command_fingerprint
  threshold:
    count_gte: 3
  severity: warning
  message: "The same operation fingerprint failed at least 3 times."
- id: likely-loop
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: span.kind
        op: neq
        value: WORKFLOW
      - field: span.kind
        op: neq
        value: AGENT
      - field: span.kind
        op: neq
        value: MODEL
  group_by: span.name
  threshold:
    count_gte: 5
  severity: warning
  message: "The same operation signature ran at least 5 times in one trace - likely loop."
- id: completion-claim-without-verification
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: trace.status
        op: eq
        value: OK
      - field: trace.verification_state
        op: neq
        value: verified
  group_by: trace.trace_id
  threshold:
    count_gte: 1
  severity: warning
  message: "Trace claims completion but verification is missing or failed."
- id: repo-drift-from-checkpoint
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: trace.changed_file_count
        op: gt
        value: 0
      - field: trace.status
        op: neq
        value: OK
      - field: trace.status
        op: neq
        value: RUNNING
  group_by: trace.trace_id
  threshold:
    count_gte: 1
  severity: warning
  message: "Files were read or written in a trace that did not complete OK; compare repository state against the latest checkpoint."
- id: concurrent-file-touch
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: span.kind
        op: eq
        value: FILE_WRITE
  group_by: span.name
  threshold:
    count_gte: 2
  severity: info
  message: "The same file was written more than once in a trace - check for concurrent or conflicting writes."
- id: compaction-before-checkpoint
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: trace.status
        op: eq
        value: COMPACTED
  group_by: trace.trace_id
  threshold:
    count_gte: 1
  severity: warning
  message: "Session was compacted while the trace was still open; context may have been lost before a checkpoint."
- id: secret-match-blocker
  version: 1.0.0
  scope: workstream
  when:
    conditions:
      - field: span.secret_match
        op: eq
        value: true
  group_by: span.span_id
  threshold:
    count_gte: 1
  severity: critical
  message: "Span name matches a secret pattern; redaction must succeed before any export or sync."
- id: token-latency-threshold
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: trace.duration_ns
        op: exists
      - field: trace.duration_ns
        op: gt
        value: 60000000000
  group_by: trace.trace_id
  threshold:
    count_gte: 1
  severity: info
  message: "Trace ran longer than 60s (token/latency threshold; reliable duration data present)."
`

// defaultPack holds the parsed launch pack. Parsing and validation happen
// once at init; a malformed built-in pack is a programming error and panics
// (fail-closed) rather than shipping silently broken detections.
var defaultPack = mustParsePack()

func mustParsePack() []*Rule {
	rules, err := ParseRules([]byte(defaultPackYAML))
	if err != nil {
		panic(fmt.Sprintf("detection: default pack failed to parse or validate: %v", err))
	}
	return rules
}

// DefaultPack returns the rules of the default launch pack. The returned
// slice is a copy; the Rule values themselves are shared and must be treated
// as read-only.
func DefaultPack() []*Rule {
	return append([]*Rule(nil), defaultPack...)
}
