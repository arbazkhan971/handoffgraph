# Explicit hosted sync

HandoffGraph never uploads during capture, hook execution, indexing, local UI
use, or any command other than an explicit `handoffgraph sync`. Local capture
continues when the hosted API is unavailable.

## Configure a device credential

Create a scoped device token in the hosted account page. The plaintext is
shown once. Keep it out of command arguments, TOML, shell history, logs, and
repository files. Use either:

- `HFG_DEVICE_TOKEN` in the current process environment; or
- `hosted_token_file` in the **user** config at
  `~/.handoffgraph/config.toml`. The path must be absolute and point directly
  to a regular file with mode `0600` or stricter on Unix. Symlinks and
  group/world-readable files are rejected.

```toml
# ~/.handoffgraph/config.toml (user scope only)
hosted_api_url = "https://api.handoffgraph.dev"
hosted_token_file = "/absolute/path/to/handoffgraph-device-token"
```

The raw token is not a supported config key. Repository-scoped
`.handoffgraph.toml` files cannot override the hosted endpoint or token file;
this prevents an untrusted checkout from redirecting a credential. A remote
endpoint must use HTTPS. HTTP is accepted only for loopback development.

## Preview and sync

```bash
# Always local and write-free: no network request and no sync-state write.
handoffgraph sync --preview

# The first upload for an endpoint/device scope refuses without this exact,
# explicit acceptance flag. It still prints only counts, never payload values.
handoffgraph sync --accept-redaction

# Later transfers remain explicit but do not require the first-upload flag.
handoffgraph sync
```

Every invocation captures a local SQLite append-sequence high-water mark,
redacts every pending event through that mark, and reports counts of clean and
redacted events plus removed field values. Any invalid redaction policy,
unclassifiable payload, prior failed-redaction marker, or oversized event
closes the hosted boundary before a request is sent. Events captured after the
high-water mark remain local until a later explicit sync.

The uploaded copy receives the configured fail-closed pipeline across payload,
free-form metadata, Git credentials, and forward-compatible unknown fields.
The local append-only event is never mutated. Payload content hashes are
recomputed after redaction, and provenance is preserved.

## Retry and tenant guarantees

Events are batched in SQLite append order at the hosted Basic-safe ceiling of
100 events and 256 KiB per request. Higher plans transfer the same data over
more requests rather than creating a Basic-incompatible pending body. Before
each request, HandoffGraph atomically persists the exact redacted body and its
deterministic idempotency key to
`~/.handoffgraph/hosted-sync-state.json` (the user-owned data directory), mode
`0600`. The local cursor advances only after a complete, validated hosted
receipt. If a request or process fails after the server accepted it, the next
manual sync replays the identical body and key, so the server returns the same
receipt without charging twice. A partial multi-batch transfer resumes at the
first unacknowledged batch.

Repository config cannot choose the hosted-state location. State is scoped by
canonical API endpoint, a one-way SHA-256 fingerprint of the high-entropy
device token, and the canonical local SQLite-store identity; neither the token
nor raw store path is persisted. This prevents one repository-scoped store
from inheriting another store's cursor. The first receipt binds that scope to
the server-derived workspace. Every later batch names that workspace, and a
changed workspace receipt is rejected without advancing the cursor. Rotating
a token therefore creates a new local scope and requires a new first-upload
acceptance; it never inherits another credential's cursor or tenant binding.

Only content-free counts and cursor progress are printed. Server response
bodies are never reflected into CLI errors, so a remote response cannot make
the CLI echo a credential or event payload.
