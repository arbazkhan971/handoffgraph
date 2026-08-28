---
name: handoffgraph
description: Use when working with HandoffGraph — capturing AI coding agent sessions, verifying workstreams, recording scores/decisions/verifications, running deterministic verification gates, building checkpoints, and preparing verified cross-agent handoffs. Triggers - handoff, workstream, verify, checkpoint, session debugging, agent continuity.
---

# HandoffGraph agent workflow

HandoffGraph is a local-first, verified cross-agent continuity and
session-debugging layer for AI coding agents (Claude Code, Codex, Pi). Every
fact lives on an append-only event spine; read models are deterministic and
rebuildable; redaction is fail-closed. When you act through these commands,
your work becomes verifiable evidence instead of chat history.

## Core rules

1. Never edit or delete stored state. Everything is append-only; corrections
   are new events.
2. Never launch agent processes yourself beyond printing their native resume
   commands — `handoffgraph continue` and `resume` print invocations; the
   human runs them.
3. Cite evidence. When you claim a session state, prefer checkpoints and
   `verify` output over memory.

## Standard loop

```bash
handoffgraph init                                    # once per machine
handoffgraph workstream new "<objective>"            # one workstream per task
handoffgraph install --agent <codex|claude|pi>       # capture hooks (merge-safe)
# ... the human works in their agent; hooks capture events ...
handoffgraph sessions --detect                       # find native sessions
handoffgraph event import <session.jsonl>            # or: otlp import / serve
handoffgraph traces                                  # materialized turn traces
handoffgraph detect                                  # deterministic pathology rules
handoffgraph verify --workstream <id> --baseline <cp_id>   # CI gate, exit 0/1
handoffgraph checkpoint --workstream <id> --objective "<objective>"
handoffgraph continue --to codex --workstream <id> --preview   # print, don't run
```

## Quality scores (use these when reviewing or judging)

```bash
handoffgraph score record --workstream <id> --name human.review \
  --target-type trace --target-id <trc_...> --category approved --source human
```

Scores are numeric, category, or boolean, source-tagged. Record one whenever
you review a trace, checkpoint, or handoff — `verify` gates on them.

## Datasets and experiments

```bash
handoffgraph dataset create <name> --file <fixture.jsonl> [--file ...]
handoffgraph experiment run --dataset <name>          # deterministic; exit 0/1
handoffgraph experiment compare <runA> <runB>         # regression diff
```

Use datasets to pin known session fixtures; run experiments after changing
adapters, detection rules, or prompts; compare runs to prove no regression.

## Prompts

```bash
handoffgraph prompt create <name> --file prompt.md     # immutable version
handoffgraph prompt label <name> --version 2 --label production  # rollback = repoint
handoffgraph prompt show <name>                        # versions, labels, links
```

## MCP

`handoffgraph mcp serve` exposes 12 tools over stdio (get_workstream_context,
get_trace_context, create_checkpoint, record_decision, record_verification,
get_prompt, record_score, list_scores, claim_files, handoff_workstream,
accept_handoff, complete_workstream). Prefer MCP tools over shelling out when
you are already connected.

## Telemetry interop

`handoffgraph otlp serve --addr 127.0.0.1:4318` accepts OTLP/JSON trace
exports (OpenLLMetry, OpenLIT, Phoenix exporters). Use `--capture metadata`
or `minimal` when session content must not land on disk.

## Before handing off

1. `handoffgraph verify --workstream <id>` must pass (exit 0).
2. `handoffgraph checkpoint --workstream <id> --objective "<objective>"`.
3. `handoffgraph continue --to <agent> --workstream <id>` and give the human
   the printed native invocation.
4. The receiving agent acknowledges via MCP `accept_handoff`.
