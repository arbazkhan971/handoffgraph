---
name: Adapter request
about: Ask for a new provider adapter (agent CLI)
title: "adapter: "
labels: enhancement, adapter
assignees: ""
---

**Which agent/provider?**

Name and version of the agent CLI (e.g. "Factory Droid 1.4", "Cursor
agent 0.9"), with a link to its docs.

**How does it record sessions today?**

Where native session data lives (paths/formats), whether it has a hook or
plugin system, and whether IDs are stable across runs. If you know the
transcript format (JSONL? JSON? SQLite?), say so.

**What would "supported" mean for you?**

Pick what you actually need, in priority order:

- [ ] Detect — find and list native sessions for this provider
- [ ] Normalize — import transcripts into `hfg.event.v1`
- [ ] Hooks — auto-capture events live via the provider's hook mechanism
- [ ] Resume — relaunch the agent from a HandoffGraph checkpoint
- [ ] `sessions`/`status` CLI visibility

**Sample data (redacted!)**

A short, realistic native transcript snippet is the single most useful
thing you can attach — adapters are built against real shapes, not
descriptions. Strip anything sensitive before pasting; attachments are
public.

**Provider constraints**

- Does the provider overwrite or rotate its native files?
- Any known conflicts with third-party hook configuration?
- Windows-specific paths or encodings to be aware of?

**Adapter contract awareness**

New adapters must follow the rules in
[CONTRIBUTING.md](../../CONTRIBUTING.md#contributing-an-adapter) —
idempotent fail-closed hook install, deterministic event IDs, unknown
fields preserved, `OBSERVED`/`DECLARED`/`INFERRED` provenance honest. If
the provider cannot meet one of these, call it out here.
