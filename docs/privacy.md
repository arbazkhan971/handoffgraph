# Privacy and trust model

HandoffGraph captures sensitive material — prompts, commands, file diffs,
test output, and sometimes secrets. Privacy is therefore a purchase driver,
not a checkbox. This document describes the implemented and planned posture.

## Default posture

- **Local-first.** No account is required for local use.
- **No source upload by default.** The local core never uploads anything.
- **Hosted transfer is explicit.** The local CLI does not auto-sync. The
  private-beta API accepts a batch only when a user-created, workspace-scoped
  device token sends it.
- **Redaction preview before first upload** (planned; `redact --preview`
  already runs the local pipeline).
- **No metadata-only claim.** Hosted Basic currently preserves validated event
  envelopes within hard byte/count limits. An envelope marked with a redaction
  failure is rejected, but callers must still review what they send.

## Capture vs. sync policy

Capturing a value locally never silently authorizes upload. The following
client-side sync modes are the intended policy model; they are not all wired
to the hosted API yet:

| Mode | Local body | Cloud body |
|---|---|---|
| `metadata_only` (planned) | metadata | metadata |
| `full_local` (current local default) | full local body | no automatic upload |
| `sanitized` (planned) | full local body | redacted body |
| `private_encrypted` (planned) | full local body | client-encrypted body |

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
- **Cross-tenant isolation**: the hosted Worker in `platform/` derives the
  workspace from a hashed device-token binding and scopes every read/write.
  Browser membership never substitutes for device authentication.
- **Secrets in logs**: Worker logs and analytics must never contain sensitive
  payloads.

## Hosted account data

The private-beta account foundation stores the verified WorkOS subject,
verified email address, optional display name/avatar URL, personal workspace
membership, plan/usage counters, and hashes of HandoffGraph session/device
secrets. WorkOS access and refresh tokens are discarded after callback.
Browser sessions expire after 30 days and can be revoked. A raw device token
is returned once and cannot be recovered from the database.

Hosted Basic is capped at 2 active devices and 10 device-token issuances over
the account lifetime, plus 5,000 events/10 MiB per 30-day period and 25,000
events/64 MiB for the account lifetime. Revoking a device releases an active
slot but does not refund an issuance. Limits stop new hosted writes without
stopping local capture. These caps bound storage; they are not a
retention/deletion policy.

## Limits of this implementation

The open-source repository now contains a private-beta hosted account/API
foundation, but it is not publicly deployed by this change. Automated CLI
sync policy, redaction preview enforcement before first sync, encrypted body
storage, shares, billing, self-service account deletion, production retention,
and edge bot controls remain unfinished. WorkOS credentials, Turnstile/WAF,
remote D1 migration, domains, and a reviewed deletion procedure are mandatory
before public signup. Local Core remains fully usable offline without an
account or cloud service.
