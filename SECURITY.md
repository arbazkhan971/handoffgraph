# Security Policy

## Supported versions

HandoffGraph is pre-1.0. The supported public line is the latest published
v0.7 prerelease, alongside `main`; security fixes land on `main` first and are
not backported to older prereleases. Before the first beta tag is published,
only `main` is supported.

## Reporting a vulnerability

**Do not open a public issue or PR for security problems.** Before the
canonical public repository is published, contact the maintainers through an
existing trusted private channel. Once `github.com/handoffgraph/handoffgraph`
exists, use its GitHub private vulnerability-reporting form (`Security` →
`Report a vulnerability`). Please include:

- A description of the issue and its impact.
- Steps or a proof of concept (a minimal captured-session fixture that
  reproduces it is ideal).
- Affected versions/commits, and any workarounds you have identified.

Please report privately and allow reasonable time for a fix before any
public disclosure. We aim to acknowledge reports promptly, but **no
response-time SLA is promised at this stage**.

## Scope and threat model

HandoffGraph is **local-first**: capture and the append-only source of truth run
on your machine and write to `~/.handoffgraph` by default. Capture hooks do not
sync implicitly. The only local-to-hosted transfer is a user-invoked `sync`;
`sync --preview` makes no network request or sync-state write, and the first
upload requires explicit `--accept-redaction` after a complete content-free
preview.

The tree also contains a Cloudflare Hosted Basic service. Its isolated staging
D1 schema is prepared, but production identity, migration, domain cutover, and
browser acceptance remain open, so this policy does not claim a live public
hosted service. Hosted Basic binds only D1 and R2. Queue, KV, and Analytics
Engine resources are not bound, and advanced routes are enabled only by the
exact value `HOSTED_SURFACE="advanced"`; missing or unexpected configuration
reduces privilege to Basic.

In scope:

- Anything that could let captured session content (which may include
  secrets embedded in commands, prompts, or tool output) escape the local
  machine.
- Any implicit or surprising network transfer. Explicit sync must re-run the
  fail-closed redaction v1 pipeline and may upload only events whose attestation
  is `redaction.version = 1` with status `clean` or `redacted`.
- Bypasses or weakening of the **fail-closed redaction** guarantees:
  if a redaction error can lead to exporting original content, that is a
  security bug, not a usability issue.
- The redaction deny-list matching (`internal/redact`) — especially any
  input where a deny pattern silently fails to match.
- Data-loss or corruption in the append-only store or crash-safe spool
  (`internal/storage`, `internal/ingest`), including SQLite migration
  handling.
- Injection through imported fixtures/transcripts into the CLI or adapter
  hook installation (e.g. writing attacker-controlled paths or shell
  commands into agent hook config).
- Path traversal or symlink attacks via content-addressed object storage.
- Hosted authentication/session/CSRF failures, cross-tenant access, quota or
  idempotency bypass, credential leakage, unsafe logging, and failures in the
  owner-confirmed WorkOS/R2/D1 account-deletion saga.

Out of scope (for now):

- Vulnerabilities in the underlying agents (Claude Code, Codex, Pi)
  themselves; report those to the respective vendors.
- Ahead-of-gate advanced hosted modules that are unreachable from the Basic
  deployment are not part of the public beta contract. Reports showing that
  the Basic deployment fence can be bypassed are in scope.
- Social engineering, phishing, or physical attacks.
- Self-inflicted secrets exposure when a user explicitly disables or
  misconfigures redaction (please still report if the UI/config made the
  unsafe choice easy or ambiguous — product-safety reports are welcome).

## Handling expectations

- Acknowledgement: best effort, promptly; no SLA.
- Fixes land on `main` first; advisory publication and credits happen once
  a fix is available (and coordinated with the reporter).
- Safe-harbour: good-faith research that makes the product safer is
  appreciated; avoid degradation of service, privacy violations, and
  data destruction.

See also [docs/privacy.md](docs/privacy.md) for what the tool stores
locally, and [CONTRIBUTING.md](CONTRIBUTING.md) for general contribution
guidelines.
