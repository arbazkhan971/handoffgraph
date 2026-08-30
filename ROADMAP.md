# Roadmap

Condensed from `HANDOFFGRAPH_VERSION_ROADMAP.md`. Each version moves only when
its acceptance gate passes. The repository contains the **v0.7.0-beta.1
release candidate** plus the ahead-of-roadmap Hosted Basic foundation. Real
cross-provider continuation acceptance and the public-release boundary remain
(updated 2026-08-30).

Two companion tracks ride alongside this release train (2026-08-28):

- [`docs/competitor-analysis.md`](docs/competitor-analysis.md) — verified
  study of 12 LLM/agent observability platforms (Langfuse, Phoenix, Opik,
  SigNoz, OpenObserve, Helicone, DeepEval, OpenLLMetry, OpenLIT, Lunary,
  Agenta, LangWatch) with the union **feature-parity matrix** (55 rows).
- [`docs/parity-plan.md`](docs/parity-plan.md) — phased P1–P4 parity program:
  Cloudflare-only hosted tier (Workers/D1/R2/Queues/Workflows/DO/Analytics
  Engine), Go local core, acceptance gates per phase, non-negotiable
  invariants. Parity rule: if any competitor ships it, we ship it.

| Version | Window | Channel | Primary outcome |
|---|---:|---|---|
| v0.0.1 | 1–7 | Internal | Problem proof + product shell |
| v0.1.0 | 8–14 | Internal | Local event spine, Git identity, redaction |
| v0.2.0 | 15–25 | Private alpha | Capture + resume Codex sessions |
| v0.3.0 | 26–35 | Private alpha | Claude capture + first Claude→Codex proof |
| v0.4.0 | 36–45 | Private alpha | Pi adapter, local MCP, provider-independent workstreams |
| v0.5.0 | 46–60 | Design alpha | Local Session Debugger (trace tree, waterfall, detections) |
| v0.6.0 | 61–75 | Public alpha | Evidence-selected checkpoint + cross-agent continuation |
| **v0.7.0** | 76–90 | Public beta | Installable, documented, open-source launch ← **release candidate** |
| v0.8.0 | 91–105 | Hosted beta | Redacted Cloudflare sync, private shares, Solo Cloud |
| v0.9.0 | 106–120 | Team beta | Shared workstreams, comments, votes, presence, billing |
| v0.10.0 | 121–145 | Team beta | Managed detections, alerts, dashboards, PR evidence |
| v0.11.0 | 146–165 | Team beta | Remote MCP, Factory Droid, policy gates |
| v0.12.0 | 166–180 | Conversion | Review queues, trace investigator beta |
| v0.13.0 | 181–210 | Expansion | Ship only the winning expansion (retention-gated) |
| v0.14.0 | 211–240 | Reliability | Scale, security, retention, cost control |
| v0.15.0 | 241–270 | RC | Public API, adapter SDK, migrations, GA hardening |
| v1.0.0 | 271–300 | GA | Supported production product, path beyond $5K MRR |

The repository also contains an ahead-of-gate **v0.8 Hosted Basic
foundation**: AuthKit-compatible accounts, hashed sessions/device credentials,
a D1 account/entitlement schema, transactionally enforced quotas, explicit
redacted CLI sync, and a reviewed durable account-deletion path. The isolated
staging D1 schema is ready, but neither staging auth nor the public production
service is live; the v0.8 gate below remains open.

## v0.1.0 acceptance gate

- [x] Event append without loss (10,000-event ingestion tested)
- [x] Duplicate event idempotency
- [x] Out-of-order input
- [x] Database crash/reopen
- [x] Deterministic rebuild produces identical graph hash
- [x] Redaction golden fixtures
- [x] Checkpoint-like state generated without a model call
- [x] Windows/Unix path fixtures
- [x] p95 append < 5 ms benchmark and regression test

## v0.2.0 acceptance gate

- [x] Codex Detect/Normalize
- [x] Hook install/uninstall fail-closed with dry-run
- [x] Deterministic re-import idempotency
- [x] Install/sessions/resume CLI wiring
- [x] Native resume works (adapter returns `codex resume <id>`; CLI prints it)
- [x] 20 real Codex sessions imported twice with stable counts, no config loss,
      and a clean deep doctor result
- [x] Stable read-only Codex App Server integration over stdio using only
      `initialize` and state-DB-only `thread/list`; file-session detection stays
      unchanged

## v0.6.0 acceptance gate

- [x] Deterministic, provenance-labelled continuation payload bounded to 12,000 characters
- [x] Same-provider native resume and cross-provider checkpoint-seeded launch specs
- [x] Preview is write-free; normal continuation appends `handoff.created`
- [x] Repository drift is checked against the source checkpoint
- [x] Machine checkpoint reference + MCP `accept_handoff` acknowledgement
- [x] Deterministic `handoff status` read model over created/accepted events
- [ ] Real-session acceptance across the six directed supported pairs:
      Codex→Claude, Claude→Codex, Codex→Pi, Pi→Codex, Claude→Pi, and
      Pi→Claude. Each proof must import the source transcript twice with a
      stable count, create a checkpoint, prove preview is write-free, record
      the handoff, accept it through MCP as the destination provider, and show
      an `accepted` handoff read model with the exact checkpoint reference.

## v0.7.0 launch gate

- [x] Tag-triggered cross-platform archives, version injection, and SHA-256 checksums
- [x] Release process and pre-release source-install documentation
- [ ] Canonical public repository exists at the declared Go module path
- [ ] First tagged prerelease plus checksummed archive, clean module install,
      and idempotent reinstall acceptance. There is no previous public stable
      release, so this first tag has no in-place upgrade baseline.

## v0.8.0 hosted-beta gate

- [x] Separate browser sessions and device bearer authentication
- [x] One personal workspace and idempotent provider-subject provisioning
- [x] Basic hard caps for 2 active devices, 10 lifetime device-token
      issuances, batch, monthly, and lifetime usage
- [x] Quota reservation, receipt, event writes, and projections share one D1 transaction
- [x] Tenant-scoped idempotency keys reject changed requests and do not double-charge retries
- [x] Fifty-account global beta cost ceiling; Local Core remains account-free
- [x] Accessible no-build account UI with usage meters and one-time device tokens
- [ ] Production WorkOS/AuthKit application and real callback acceptance
- [ ] Turnstile plus reviewed WAF/rate controls for signup and device issuance
- [x] Durable, tenant-scoped account deletion/privacy implementation reviewed
      and tested across WorkOS, R2, D1, retry, grace-sweep, and resurrection
      boundaries
- [x] Explicit CLI sync policy plus first-upload redaction-preview acceptance;
      upload requires `redaction.version = 1` and status `clean` or `redacted`
- [x] All 19 migrations applied to and verified on isolated staging D1
- [x] Production custom-domain routes configured in Wrangler (not yet deployed
      or cut over)
- [ ] Production D1 migration, HTTPS domain cutover, and deployed cross-tenant
      browser/CLI tests
- [ ] Keep production signup absent/fail-closed until all identity, abuse, and
      acceptance gates pass
- [ ] Private shares and any purchasable Solo plan (not implemented)

## Versioning policy

Semantic versioning. Before v1.0, minor versions may change unstable
interfaces but require migration notes; patch versions fix bugs without
changing schemas. After v1.0, breaking CLI/protocol/adapter/API changes
require v2.0.

## Release channels

Nightly (`v0.x.y-dev.<sha>`), alpha (`v0.x.0-alpha.n`), beta
(`v0.x.0-beta.n`), stable (`v0.x.0`).

## Definition of done

A version is complete when its acceptance tests pass, there are no open P0
security/corruption/data-loss defects, upgrade from the previous stable is
tested when such a release exists (the first public prerelease instead proves
clean install and idempotent reinstall), local capture works with the network
disabled, cloud failure never blocks the agent, and release notes + `doctor`
reflect shipped behavior.
