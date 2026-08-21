# Privacy and trust model

HandoffGraph captures sensitive material — prompts, commands, file diffs,
test output, and sometimes secrets. Privacy is therefore a purchase driver,
not a checkbox. This document describes the implemented and planned posture.

## Default posture

- **Local-first.** No account is required for local use.
- **No source upload by default.** The local core never uploads anything.
- **Cloud sync is opt-in, per-repository, and explicit** (not yet shipped).
- **Redaction preview before first upload** (planned; `redact --preview`
  already runs the local pipeline).
- **Command output and prompts are local-only by default.**

## Capture vs. sync policy

Capturing a value locally never silently authorizes upload. Two separate
policies exist:

| Mode | Local body | Cloud body |
|---|---|---|
| `metadata_only` | metadata | metadata |
| `full_local` (default) | full local body | metadata |
| `sanitized` | full local body | redacted body |
| `private_encrypted` | full local body | client-encrypted body |

## Hook installation

Installing provider hooks (Codex: `handoffgraph install --agent codex`)
writes only the managed `[hooks.handoffgraph]` table into the provider's own
config file (`~/.codex/config.toml`). It never copies provider session data
anywhere — local or remote — beyond the existing local event store, and
unrelated config keys are left untouched. The redaction model is unchanged:
captured events stay local under the same policies as above.

## Redaction pipeline (implemented)

1. **Path denylist** — `.env`, credentials, key files, `*.pem`, `*.key`,
   `id_rsa`, `secrets.yaml`, etc.
2. **Known token patterns** — AWS, GitHub, OpenAI, Anthropic, Slack, Stripe,
   Google, JWTs, bearer/authorization values.
3. **High-entropy detection** — Shannon entropy over tokens with
   mixed-case+digit heuristics.
4. **User regex rules** — configurable.

**Fail-closed**: if a stage errors, the object is marked `REDACTION_FAILED`
and is never exported in its original form. The original secret is never
written into the redaction audit record. Redaction runs once before object
hashing for upload, and again before public sharing.

## What is never in telemetry

Analytics events (when enabled) contain only content-free signals: CLI
version, OS, adapter names/versions, event-kind counts, latency, and error
codes. Never repository names, file paths, prompts, tool arguments, command
output, Git remotes, or source code.

## Threat model (summary)

- **Untrusted content**: all captured terminal/Markdown content is treated as
  untrusted input. The UI must escape HTML, sanitize Markdown, enforce a
  strict Content Security Policy, validate attachment MIME types, and
  neutralize terminal escape sequences (UI ships in v0.5.0).
- **Cross-tenant isolation**: the hosted service (not in this repo) enforces
  tenant IDs on every access and passes cross-tenant authorization tests
  before public beta.
- **Secrets in logs**: Worker logs and analytics must never contain sensitive
  payloads.

## Limits of this implementation

The current repository is local-only. Encryption, hosted sync, OAuth, and
server-side processing are future work and belong to the (private) hosted
platform repository, not the open-source core.
