# Security Policy

## Supported versions

HandoffGraph is pre-1.0 (currently a v0.6.0-level pre-release). Security fixes are applied to
the latest `main` branch only; there are no backported release lines yet.
Once tagged releases exist, the supported window will be listed here.

## Reporting a vulnerability

**Do not open a public issue or PR for security problems.** Instead use
[GitHub private vulnerability reporting](https://github.com/handoffgraph/handoffgraph/security/advisories/new)
(`Security` → `Report a vulnerability` on the repository). Please include:

- A description of the issue and its impact.
- Steps or a proof of concept (a minimal captured-session fixture that
  reproduces it is ideal).
- Affected versions/commits, and any workarounds you have identified.

Please report privately and allow reasonable time for a fix before any
public disclosure. We aim to acknowledge reports promptly, but **no
response-time SLA is promised at this stage**.

## Scope and threat model

HandoffGraph is a **local-first** tool: it runs on your machine and writes
only to your local data directory (`~/.handoffgraph` by default) and to
the repositories you point it at. There is no network service, telemetry
server, or hosted component in the current versions; telemetry (when it
exists) is opt-in and content-free.

In scope:

- Anything that could let captured session content (which may include
  secrets embedded in commands, prompts, or tool output) escape the local
  machine.
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

Out of scope (for now):

- Vulnerabilities in the underlying agents (Claude Code, Codex, Pi)
  themselves; report those to the respective vendors.
- Bugs in unreleased, experimental branches that have never been on
  `main`.
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
