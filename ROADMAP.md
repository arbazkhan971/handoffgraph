# Roadmap

Condensed from `HANDOFFGRAPH_VERSION_ROADMAP.md`. Each version moves only when
its acceptance gate passes. This repository currently targets **v0.1.0**, with
the v0.2.0 Codex adapter in flight (see its gate below; updated 2026-08-21).

| Version | Window | Channel | Primary outcome |
|---|---:|---|---|
| v0.0.1 | 1–7 | Internal | Problem proof + product shell |
| **v0.1.0** | 8–14 | Internal | Local event spine, Git identity, redaction ← **here** |
| v0.2.0 | 15–25 | Private alpha | Capture + resume Codex sessions |
| v0.3.0 | 26–35 | Private alpha | Claude capture + first Claude→Codex proof |
| v0.4.0 | 36–45 | Private alpha | Pi adapter, local MCP, provider-independent workstreams |
| v0.5.0 | 46–60 | Design alpha | Local Session Debugger (trace tree, waterfall, detections) |
| v0.6.0 | 61–75 | Public alpha | Evidence-selected checkpoint + cross-agent continuation |
| v0.7.0 | 76–90 | Public beta | Installable, documented, open-source launch |
| v0.8.0 | 91–105 | Hosted beta | Redacted Cloudflare sync, private shares, Solo Cloud |
| v0.9.0 | 106–120 | Team beta | Shared workstreams, comments, votes, presence, billing |
| v0.10.0 | 121–145 | Team beta | Managed detections, alerts, dashboards, PR evidence |
| v0.11.0 | 146–165 | Team beta | Remote MCP, Factory Droid, policy gates |
| v0.12.0 | 166–180 | Conversion | Review queues, trace investigator beta |
| v0.13.0 | 181–210 | Expansion | Ship only the winning expansion (retention-gated) |
| v0.14.0 | 211–240 | Reliability | Scale, security, retention, cost control |
| v0.15.0 | 241–270 | RC | Public API, adapter SDK, migrations, GA hardening |
| v1.0.0 | 271–300 | GA | Supported production product, path beyond $5K MRR |

## v0.1.0 acceptance gate

- [x] Event append without loss (10,000-event ingestion tested)
- [x] Duplicate event idempotency
- [x] Out-of-order input
- [x] Database crash/reopen
- [x] Deterministic rebuild produces identical graph hash
- [x] Redaction golden fixtures
- [x] Checkpoint-like state generated without a model call
- [ ] Windows/Unix path fixtures (CI matrix pending)
- [ ] p95 append < 5 ms benchmark (to be added to CI)

## v0.2.0 acceptance gate

- [x] Codex Detect/Normalize
- [x] Hook install/uninstall fail-closed with dry-run
- [x] Deterministic re-import idempotency
- [x] Install/sessions/resume CLI wiring
- [x] Native resume works (codex exec resume)
- [ ] 20 real sessions with no config loss
- [ ] App Server integration

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
tested, local capture works with the network disabled, cloud failure never
blocks the agent, and release notes + `doctor` reflect shipped behavior.
