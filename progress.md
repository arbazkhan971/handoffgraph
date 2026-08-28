# HandoffGraph completion sprint

Last updated: 2026-08-24 01:10 IST

## Objective

Complete and verify the repository's next coherent end-to-end product slice:
an evidence-backed local workstream can be captured from supported agents,
inspected as traces/detections, converted into a portable checkpoint, and
continued safely in another native agent with drift checks and acceptance
evidence. Keep the existing local UI and Cloudflare ingestion prototype green.

The original sprint targets the v0.6 local workflow described by the source
roadmap. A follow-up now also delivers a bounded limited hosted-Basic account
foundation and competitive landing/account experience. Local Core remains
account-free. Paid checkout, public production auth, automated CLI sync,
collaboration, and other later features remain explicitly gated.

## Non-negotiable gates

- [x] Core CLI builds and the complete local golden workflow smoke test passes.
- [x] `continue --to codex|claude|pi` is wired, safe, previewable, and tested.
- [x] Checkpoint consumption/acceptance is recorded with evidence and drift is
      checked before launch.
- [x] Go unit tests, race tests, vet, and formatting pass (817 tests across
      28 packages in both normal and race runs).
- [x] Web UI tests and production build pass; embedded assets are current.
- [x] Cloudflare platform tests, type checks/build, migrations, and auth/ingest
      contract pass.
- [x] Documentation and command/status claims match shipped behavior.
- [x] No known P0/P1 data-loss, redaction, provenance, or determinism
      regression remains after independent diff and acceptance audits.

## Parallel workstreams

| Owner | Area | Status | Evidence / next action |
|---|---|---|---|
| root | Objective, integration, progress ledger, final E2E | Complete | Real-binary capture→checkpoint→continue→MCP accept flow and final gates pass |
| core_release | Go core/CLI/storage/adapters | Complete | v0.6 trace checkpoint, all-provider launch, trace normalization and ID hardening landed |
| web_platform | React UI + Cloudflare worker | Complete | Live API contract, D1 projection, fail-closed waitlist, builds and dry deploys pass |
| release_validation | Packaging/docs/CI/smoke flow | Complete | Six-target release snapshot/checksums and packaged-binary/MCP smoke pass |
| final_diff_audit | Independent regression/security review | Complete | No known P0/P1 remains; scoped integrity, redaction, lifecycle and prompt bounds fixed |
| acceptance_gate_audit | Independent release/acceptance verification | Complete | 817 normal/race tests; binary E2E, fixtures, performance, migrations and package gates pass |
| core_release (follow-up) | Hosted IDs/schema/plans/atomic D1 quota triggers | Complete | Migration 0003, 50-account ceiling, tenant idempotency, helper tests and local D1 apply pass |
| quota_enforcement | Hosted Basic hard limits and retry/race semantics | Complete | Trigger-authoritative reservation preparation; exact/one-over/race tests pass |
| acceptance_gate_audit (follow-up) | Hosted account UX | Complete | Strict-CSP account page, live usage meters, device creation and 10 focused tests |
| auth_security_review | Independent account/quota security audit | Complete | No in-code P0/P1 remains; public edge abuse controls are an external no-go gate |
| hosted_e2e_audit | Local D1 + Worker/landing acceptance | Complete | Real local Worker quota/replay/rollback and migration gates passed |
| ingest_field_limits | Indexed/projected storage amplification | Complete | Canonical IDs, UTF-8 caps and adversarial 250 KiB tests pass |
| final_hosted_gate | Settled hosted regression gate | Complete | Live ingest/replay/conflict/oversize/device-trigger checks pass on fresh D1 |

## Timeline

- 23:20 IST — Started sprint from clean `main` at `0509293`.
- 23:20 IST — Read repository guidance and product/architecture/roadmap sources.
- 23:20 IST — Allocated all four available agent slots.
- 23:26 IST — Found shipped lane commands were unreachable from the binary;
  registered Codex/Claude/Pi, MCP, detection, debugger UI, continuation and
  handoff surfaces in `commands.Register`; targeted command tests: 92 pass.
- 23:27 IST — Frontend/platform baseline: web 63 tests + lint/build pass;
  platform 74 tests + typecheck + Wrangler dry deploy pass. Live API envelope
  mismatch found and assigned for repair.
- 23:31 IST — Added trace-selected checkpoint creation and `checkpoint show`;
  Claude/Pi now support bounded checkpoint-seeded launch specs, while
  same-provider continuation preserves native resume.
- 23:34 IST — Unified MCP target acknowledgement with the v0.6 launch event
  model. Continuation prompts now carry a machine-readable workstream/checkpoint
  reference; MCP `accept_handoff` folds accepted/missing/unverifiable sections
  into `handoff status`. Launch + MCP targeted tests: 160 pass.
- 23:34 IST — Real-binary smoke found imported event-only workstreams were not
  addressable through MCP. `ListWorkstreams` now merges table rows with the
  append-only event log; CLI continuation → MCP acceptance → `handoff status`
  now reaches `accepted` with classified evidence.
- 23:35 IST — Release audit found the CLI entrypoint was accidentally ignored
  by Git and therefore absent upstream; the ignore, version, source-build, and
  artifact gates were repaired.
- 23:36 IST — Hardened checkpoint export: source events remain immutable,
  integrity hashes stay tied to raw events, objective/repository/event fields
  are sanitized, custom user redaction policy reaches both CLI and MCP, and
  decisions always retain a source evidence reference.
- 23:38 IST — Release artifacts validated for six OS/architecture targets;
  812 integrated Go tests, vet, format, and diff checks are green. Full race
  rerun and independent diff audit are active.
- 23:42 IST — Web API envelopes and trace detail now match the live Go server;
  the embedded UI was rebuilt. Cloudflare ingestion gained deterministic,
  workspace-scoped projections and bounded three-statement D1 batches.
- 23:44 IST — Landing waitlist persistence now fails closed with `503` when
  `WAITLIST` KV is absent or broken; the existing client fallback is activated
  instead of falsely claiming a discarded signup.
- 23:47 IST — Independent diff audit fixed workstream-scoped checkpoint hashes,
  composed URL credential/token redaction, total trace tie-breaks, terminal
  lifecycle parity, and UTF-8-safe prompt truncation that preserves the
  instruction, acknowledgement URI and footer.
- 23:49 IST — Codex checkpoint continuation corrected from non-interactive
  `codex exec` to the interactive `codex -- <payload>` new-session contract;
  Claude and Pi checkpoint starts and all native-resume paths remain covered.
- 23:50 IST — Acceptance audit replaced the graceful-close “crash” test with
  an abruptly exiting child-process WAL recovery test and added real local D1
  migration application to CI and tagged-release gates.
- 23:52 IST — Frozen-tree verification completed: build, vet, format and diff
  checks pass; 817 Go tests pass normally and under the race detector; all
  frontend, Worker, fixture, migration, binary-flow and release checks pass.
- 00:20 IST — Reframed the landing around a distinctive continuity-ledger
  story, made the first viewport product-led, added faithful interactive proof,
  fixed mobile overflow/accessibility, and hardened waitlist truth/security.
- 00:28 IST — Added honest pricing: Local Core stays $0/account-free; Hosted
  Basic is free and hard-bounded; Solo/Team are visible but non-purchasable.
- 00:35 IST — Implemented WorkOS AuthKit authorization-code + PKCE plumbing,
  verified-subject account provisioning, hashed host-only browser sessions,
  exact-Origin/CSRF checks, and one-time scoped device credentials. Provider
  tokens are discarded rather than stored.
- 00:40 IST — Added migration 0003 with users, identities, memberships,
  sessions, Basic entitlements, tenant-scoped idempotency, fixed-period and
  lifetime counters, trigger-authoritative atomic quota reservations, and a
  50-account global beta ceiling.
- 00:43 IST — Integrated Basic limits into event ingestion: 100 events/256 KiB
  per batch, 5,000 events/10 MiB per period, 25,000 events/64 MiB lifetime.
  Limit failure rolls back receipt/events/projection; retries do not double
  charge and changed requests reuse no key.
- 00:46 IST — Hosted account dashboard, plan/usage API, device management, CSP,
  documentation and production fail-closed configuration are wired. Current
  platform gate is 138 tests plus clean TypeScript; independent E2E/security
  audits are active.
- 00:52 IST — Security hardening bounded D1 growth to one browser session per
  account, 2 active devices and 10 lifetime device-token issuances. New-account
  workspace/user/identity/membership/entitlement rows now commit atomically, so
  the 50-account ceiling cannot leave orphan rows.
- 00:55 IST — Evidence ingestion now rejects non-finite and unsafe-integer JSON,
  contradictory reuse of an event ID, and unverifiable migrated idempotency
  keys. Every denial rolls back receipt, quota and projection writes.
- 00:57 IST — Removed the implicit legacy-unmetered path: any hosted workspace
  without an active entitlement fails closed. Workstream keys are now scoped by
  workspace, closing cross-tenant projection suppression.
- 01:00 IST — Signup and sign-in are separated server-side. Existing accounts
  may sign in while new signup is closed; account creation requires the
  explicit `HOSTED_SIGNUP_ENABLED=true` production switch after edge controls.
  The then-current platform gate was 152 tests with clean generated
  types/TypeScript; later hardening raised the settled count below.
- 01:05 IST — Closed the remaining in-code Basic cost amplifiers: canonical
  prefixed IDs and UTF-8 byte caps protect every indexed/projected event field;
  device insert/revoke triggers couple rows and counters atomically; expired
  monthly meters project a truthful reset; one-time tokens clear on pagehide.
- 01:08 IST — Settled hosted suite reaches 162 tests with clean TypeScript.
  Go build/vet and 817 normal + 817 isolated race tests pass; web remains 69
  tests plus lint/build, and landing remains 15 tests plus dry bundle.
- 01:10 IST — Fresh D1 migrations complete in 35 + 5 + 40 commands. Live
  Worker verification accepts/replays one bounded Basic event, rejects changed
  evidence with 409 and 250 KiB indexed IDs with 400, and leaves exactly one
  receipt/reservation/quota charge. Public signup CTAs remain on the waitlist;
  existing-account sign-in stays wired.

## Findings and decisions

- At baseline, README/HANDOVER described a v0.5-level local core plus v0.6
  launch and Cloudflare work while the condensed ROADMAP header was stale.
  They now consistently identify the implemented v0.6 local product and the
  remaining v0.7 publication gate.
- "Complete end to end" is interpreted as completing that next coherent local
  workflow, not collapsing intentionally gated v0.8-v1.0 hosted features into
  an unsafe one-hour change set.
- The core launch implementation existed but was not registered, and Claude/Pi
  checkpoint launch capability was still deliberately unsupported. Both are
  now wired, implemented, and tested.
- The MCP handoff tools used an older payload contract, so a receiving agent's
  acknowledgement could not update the new CLI handoff read model. The shared
  append-only acceptance path now connects those surfaces, with an integration
  test.
- The CLI entrypoint directory was accidentally ignored and absent from Git;
  the ignore rule, CI binary smoke, version metadata, GoReleaser config, and
  tag-gated release workflow now prevent recurrence.
- Two external publication dependencies remain deliberately unclaimed: the
  canonical `github.com/handoffgraph/handoffgraph` repository/tag do not yet
  exist, and the deployed landing Worker still needs a provisioned `WAITLIST`
  KV binding. Code now fails closed instead of reporting a discarded signup.

## Final verification

- `go build ./...`, `go vet ./...`, `gofmt -l .`, and `git diff --check` pass.
- `go test ./... -count=1`: 817 tests pass across 28 packages.
- `go test -race ./... -count=1`: the same 817 tests pass race-clean.
- Storage invariants pass for idempotency, out-of-order delivery, abrupt
  crash/WAL reopen, deterministic rebuilds, and the 10,000-item synthetic
  workload (20,005 stored events). Append p95 is 174.541 microseconds against
  the 5 ms gate; the one-shot 10k graph-hash benchmark completes.
- All 16 golden fixtures verify: 94 events, zero failures.
- A compiled-binary flow imports a Claude fixture, materializes traces and
  detections, builds/shows a trace-selected checkpoint, previews Codex/Claude/
  Pi continuation without writes, records a handoff, accepts it through MCP,
  derives `accepted` status, and finishes with `doctor` reporting OK.
- Web UI: 69 tests, lint, TypeScript/Vite production build, and byte-current
  embedded assets pass.
- Platform Worker: 162 tests, generated binding/type checks, local application
  of migrations 0001 through 0003, and Wrangler dry deploy pass.
- Landing Worker: 15 tests and Wrangler dry deploy pass; absent persistence is
  verified to return `503`.
- GoReleaser configuration validates; six Linux/macOS/Windows amd64/arm64
  snapshot archives build, every checksum verifies, and extracted CLI/MCP
  smoke tests pass.

## Remaining external/manual release gates

- Run the ROADMAP real-session acceptance matrix with installed native Codex,
  Claude, and Pi agents. HandoffGraph intentionally prints invocations and
  never executes those agents itself, so fixture/compiled-binary coverage does
  not claim this human-controlled gate.
- Transfer or mirror the repository to the canonical
  `github.com/handoffgraph/handoffgraph` location, then create the first tag;
  the tag workflow deliberately refuses to publish from the current personal
  origin.
- Provision and bind production `WAITLIST` KV, then deploy the landing Worker.
- Configure WorkOS, edge signup/device abuse controls, and production domains;
  apply D1 migrations remotely, then explicitly set
  `HOSTED_SIGNUP_ENABLED=true` and deploy. Local migration and bundle gates
  pass; no external resource was mutated in this sprint.

## Landing-page competitive upgrade — 2026-08-24

- [x] Benchmarked the current Neatlogs product story and replaced the previous
      generic dark developer page with a distinctive continuity-ledger system.
- [x] First viewport now demonstrates an interruption → checkpoint → printed
      native invocation → conditional MCP acknowledgement using an explicitly
      labelled representative v0.6 flow.
- [x] Added interactive handoff stages, evidence/provenance inspection,
      materialized trace waterfall, repository-drift simulation, honest
      local-alpha/hosted-beta split, FAQ, and responsive mobile navigation.
- [x] Corrected stale/overstated commands and switched public source links to
      the repository that currently resolves.
- [x] Hardened waitlist UX: exact `202` + JSON acknowledgement is required,
      no-JS cannot leak form fields into a GET URL, fallback storage is bounded
      to one expiring record, and storage-failure wording remains truthful.
- [x] Hardened waitlist persistence: unknown client fields and source IP are
      not stored, repeat emails use a pseudonymous dedupe key, accepted records
      expire after 90 days, API responses are `no-store`, and cross-origin
      writes are no longer enabled with a wildcard origin.
- [x] Added and wired a bespoke 1200×630 social preview card and 64×64 favicon
      with revalidatable Worker delivery.
- [x] Tightened the CSP to hash-authorized scripts, added framing/permissions
      headers, removed automatic demo motion, and raised small-text/focus
      contrast for keyboard and low-vision use.
- [x] Verification: 15 landing/API/markup tests pass; JavaScript syntax and
      diff checks pass; Wrangler production dry bundle passes; local GET/HEAD,
      social image delivery, and fail-closed `503` behavior were smoke-tested;
      desktop, full-page, and exact 320px responsive renders were inspected.
      At 320px the document and viewport widths both measure 320px.
- [ ] Production publication remains blocked on the external `WAITLIST` KV
      binding, edge abuse control, and custom-domain deployment described
      above. No public deploy was performed.

## Direct account access — 2026-08-28

- [x] Removed every public waitlist and request-access option from the landing
      page, including the form, fallback storage script, navigation links, and
      Team beta-list action.
- [x] Added direct Hosted Basic sign-up and sign-in actions while keeping Solo
      and Team visibly unavailable.
- [x] Updated the hashed script CSP, passed all 15 landing tests, and published
      the production build at `https://handoffgraph-landing.vercel.app`.
- [ ] The Cloudflare authentication backend still requires WorkOS secrets,
      remote D1 migrations, signup abuse controls, and a Worker deployment
      before the direct account actions can complete successfully.


## Competitor-parity program — 2026-08-28

Research (5 GLM-5.3-flash researcher agents) → docs/research/01..05 →
docs/competitor-analysis.md (55-row union matrix) → docs/parity-plan.md
(P1–P4, acceptance gates). Constraint locked: Cloudflare-only hosted tier,
full feature parity mandatory.

Shipped in 15 commits (5b8a98c→f1747c4), all gates green per commit:
OTLP/JSON ingest local (`otlp import|serve`, --capture tiers, 429
backpressure) + hosted (`platform/src/otlp.ts` + `POST /v1/otlp`, Go-parity
deterministic ids via golden tests, 176 vitest); scores primitive (CLI+MCP);
wide span_observations read model (migration 9: ts_bucket prune, exact
predicates, fingerprints, stale auto-rebuild); `verify` CI gate (6 checks +
baseline regression, exit codes, self-recording evidence); datasets ×
experiments (content-hash versions, object-store replay, compare);
prompt store (immutable versions + labels, get_prompt); `query usage` +
`outcomes`; agent skills + .claude-plugin. MCP now 12 tools, CLI 28
commands. Matrix status: ~34/55 rows.

Open: P3 hosted platform (R2/AE/Workflows/dashboards/teams/gateway), P2 UI
surfaces, protobuf/gRPC flavors. Launch gates unchanged (canonical repo,
real sessions, first tag). Full takeover brief: HANDOVER.md §13.
