---
name: Feature request
about: Suggest a capability for the core or CLI
title: "feat: "
labels: enhancement
assignees: ""
---

**Problem to solve**

What are you trying to accomplish? What goes wrong or feels impossible
today? Describe the *user-facing* problem, not just the mechanism.

**Proposed solution**

What should exist? Sketch the command, flag, output, or data-shape change
you have in mind.

**Alternatives considered**

Workarounds you tried, other tools that solve it, and why they fall short.

**Scope check**

HandoffGraph is deliberately narrow: a local-first, verified cross-agent
continuity and session-debugging layer over the append-only event spine —
not generic LLM observability, a memory API, or a codebase knowledge
graph. Does the request fit that charter?

- [ ] It works on captured evidence (events/graph), not live streams
- [ ] It can be deterministic and testable via fixtures
- [ ] It does not require a hosted service

**Evidence / fixtures**

If this needs new event kinds or payload fields: how would adapters
capture it, and can you attach a sample (redacted) fixture? See
[testdata/fixtures/README.md](../../testdata/fixtures/README.md).

**Roadmap fit**

Check [ROADMAP.md](../../ROADMAP.md) if the idea is already planned for a
version; note anything that conflicts with the ground rules in
[AGENTS.md](../../AGENTS.md) (append-only events, deterministic reducers,
fail-closed redaction, provenance preserved).
