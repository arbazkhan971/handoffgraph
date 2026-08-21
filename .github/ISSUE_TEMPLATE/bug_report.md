---
name: Bug report
about: Something broke, silently failed, or produced wrong output
title: "bug: "
labels: bug
assignees: ""
---

**What happened?**

A clear description of the bug.

**What did you expect?**

What you expected to happen instead.

**Reproduction**

Steps or commands that trigger it. Best: a minimal JSONL fixture
(`hfg.event.v1` or native provider format) added as a snippet or
attachment — **redact anything sensitive first**. Note that anything you
attach becomes public.

```bash
export HFG_DATA_DIR=$(mktemp -d)
hfg ...
```

**Output / error**

```
paste exact output here
```

**Environment**

- HandoffGraph version (`hfg version`):
- OS:
- Agent + version (Claude Code / Codex / Pi), if adapter-related:
- Go version (if built from source):

**Integrity checks that still pass**

Which of these are true (helps narrow the layer)?

- [ ] `hfg doctor` is clean
- [ ] `hfg fixture verify testdata/fixtures` reports only the expected
      `truncated.jsonl` failure
- [ ] Re-importing the same input is a no-op (idempotency)
- [ ] `hfg graph --json` hash is stable across runs

**Additional context**

Anything else: config overrides, hook installation state, whether events
arrived out of order or were re-delivered.
