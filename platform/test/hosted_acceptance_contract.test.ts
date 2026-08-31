import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isHandoffGraphTurnstileChallenge,
  isHandoffGraphTurnstileCompletion,
  isTurnstileChallengeURL,
} from "../acceptance/browser";
import {
  ACCEPTANCE_FIXTURE_SHA256,
  ACCEPTANCE_GITHUB_REPOSITORY,
  ACCEPTANCE_SCHEMA,
  DELETION_ONE_SHOT_NOTICE,
  acceptancePurgeTables,
  acceptanceEvidenceCheckContract,
  acceptanceSentinelKeys,
  assertCLISequence,
  assertCredentialAbsentFromArguments,
  assertDeletionConfirmation,
  assertHealthyDeployment,
  assertPurgeCounts,
  assertR2ObjectMissing,
  assertReciprocalTenantIsolation,
  assertWorkOSIdentityDeleted,
  assertWorkOSIdentityReadable,
  credentialEnvironment,
  expectedReleaseAssetName,
  expectedPublishedReleaseAssets,
  expectedWorkerTag,
  parseChecksumManifest,
  parseFreshAccountQuota,
  parseCLIReport,
  parseDeletionLedger,
  parseDeletionTombstone,
  parseDeviceCredential,
  parsePublishedGitHubAnnotatedTag,
  parsePublishedGitHubRelease,
  parsePublishedGitHubTagReference,
  serializeSanitizedEvidence,
  mayCleanupDeletionSentinels,
  isCertainlyRejectedDeletionStatus,
  validateTargetOrigin,
  validateSourceSHA,
  type HostedAcceptanceEvidence,
} from "../acceptance/contracts";

const SOURCE_SHA = "a".repeat(40);
const WORKSPACE_A = `wsp_0${"A".repeat(25)}`;
const WORKSPACE_B = `wsp_0${"B".repeat(25)}`;
const WORKSTREAM_A = `ws_0${"C".repeat(25)}`;
const WORKSTREAM_B = `ws_0${"D".repeat(25)}`;
const DEVICE_ID = `dev_0${"E".repeat(25)}`;
const DEVICE_TOKEN = `hfg_dev_${"f".repeat(43)}`;
const WORKER_VERSION = "095f00a7-23a7-43b7-a227-e4c97cab5f22";

function cliReport(overrides: Record<string, unknown> = {}): unknown {
  return {
    mode: "sync",
    high_watermark: 4,
    cursor: 4,
    preview: { events: 4, clean: 4, redacted: 0, fields_redacted: 0 },
    accepted_events: 4,
    batches_sent: 1,
    up_to_date: true,
    first_upload: true,
    workspace_bound: true,
    local_capture_unaffected: true,
    ...overrides,
  };
}

function baseEvidence(): HostedAcceptanceEvidence {
  return {
    schema_version: ACCEPTANCE_SCHEMA,
    recorded_at: "2026-08-31T12:00:00.000Z",
    phase: "preflight",
    outcome: "pass",
    target: {
      environment: "staging",
      origin: "https://handoffgraph-api-staging.arbaz-khan.workers.dev",
      source_sha: SOURCE_SHA,
      worker_version_id: WORKER_VERSION,
      worker_version_tag: expectedWorkerTag(SOURCE_SHA),
    },
    checks: acceptanceEvidenceCheckContract("preflight"),
  };
}

function lifecycleEvidence(): HostedAcceptanceEvidence {
  return {
    ...baseEvidence(),
    phase: "lifecycle",
    checks: acceptanceEvidenceCheckContract("lifecycle"),
    cli: {
      version: "v0.8.0-beta.1",
      binary_sha256: "1".repeat(64),
      archive_name: "handoffgraph_0.8.0-beta.1_darwin_arm64.tar.gz",
      archive_sha256: "2".repeat(64),
    },
    accounts: [
      {
        lane: "a",
        workspace_id: WORKSPACE_A,
        workstream_id: WORKSTREAM_A,
        preview_events: 4,
        accepted_events: 4,
        repeat_up_to_date: true,
        device_terminal_status: "revoked",
      },
      {
        lane: "b",
        workspace_id: WORKSPACE_B,
        workstream_id: WORKSTREAM_B,
        preview_events: 4,
        accepted_events: 4,
        repeat_up_to_date: true,
        device_terminal_status: "revoked",
      },
    ],
  };
}

function deletionEvidence(): HostedAcceptanceEvidence {
  const evidence = lifecycleEvidence();
  evidence.phase = "deletion";
  evidence.checks = acceptanceEvidenceCheckContract("deletion");
  evidence.accounts![0].device_terminal_status = "deleted";
  evidence.deletion = {
    workspace_id: WORKSPACE_A,
    status: "complete",
    workos_absent: true,
    r2_sweeps: 2,
    purged_table_count: acceptancePurgeTables.length + 4,
    absent_sentinel_count: 4,
    empty_prefix_count: 4,
    foreign_key_violations: 0,
    lifetime_device_issuance_limit: 10,
    permanent_ledger_present: true,
  };
  return evidence;
}

describe("hosted acceptance target contract", () => {
  it("requires an exact lowercase 40-hex source identity", () => {
    expect(validateSourceSHA(SOURCE_SHA)).toBe(SOURCE_SHA);
    expect(() => validateSourceSHA("A".repeat(40))).toThrow("invalid_source_sha");
  });

  it("accepts only the checked-in bare staging and production origins", () => {
    expect(validateTargetOrigin(
      "https://handoffgraph-api-staging.arbaz-khan.workers.dev",
      "staging",
    )).toBe("https://handoffgraph-api-staging.arbaz-khan.workers.dev");
    expect(validateTargetOrigin("https://api.handoffgraph.dev", "production"))
      .toBe("https://api.handoffgraph.dev");
    for (const unsafe of [
      "http://api.handoffgraph.dev",
      "https://api.handoffgraph.dev/path",
      "https://api.handoffgraph.dev?code=secret",
      "https://user@api.handoffgraph.dev",
      "https://example.com",
    ]) {
      expect(() => validateTargetOrigin(unsafe, "production"))
        .toThrow("invalid_target_origin");
    }
  });

  it("binds liveness to the exact source tag and refuses maintenance", () => {
    const headers = new Headers({
      "cache-control": "no-store",
      "x-handoffgraph-worker-version": WORKER_VERSION,
      "x-handoffgraph-worker-tag": expectedWorkerTag(SOURCE_SHA),
    });
    expect(assertHealthyDeployment({
      status: 200,
      headers,
      body: { status: "ok" },
      sourceSHA: SOURCE_SHA,
    })).toEqual({
      worker_version_id: WORKER_VERSION,
      worker_version_tag: expectedWorkerTag(SOURCE_SHA),
    });
    headers.set("x-handoffgraph-maintenance", "true");
    expect(() => assertHealthyDeployment({
      status: 200,
      headers,
      body: { status: "ok" },
      sourceSHA: SOURCE_SHA,
    })).toThrow("hosted_maintenance_active");
  });

  it("recognizes only the exact Cloudflare Turnstile challenge host", () => {
    expect(isTurnstileChallengeURL(
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
    )).toBe(true);
    expect(isTurnstileChallengeURL(
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1",
    )).toBe(true);
    expect(isTurnstileChallengeURL(
      "https://challenges.cloudflare.com.attacker.example/turnstile/v0/api.js",
    )).toBe(false);
    expect(isTurnstileChallengeURL("http://challenges.cloudflare.com/turnstile/v0/api.js"))
      .toBe(false);
  });

  it("attributes Turnstile only to the exact HandoffGraph account page and marker", () => {
    const origin = "https://handoffgraph-api-staging.arbaz-khan.workers.dev";
    const challenge = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    expect(isHandoffGraphTurnstileChallenge({
      responseURL: challenge,
      topLevelPageURL: `${origin}/account`,
      expectedOrigin: origin,
    })).toBe(true);
    expect(isHandoffGraphTurnstileChallenge({
      responseURL: challenge,
      topLevelPageURL: "https://api.workos.com/user_management/authorize",
      expectedOrigin: origin,
    })).toBe(false);
    expect(isHandoffGraphTurnstileCompletion({
      frameURL: `${origin}/account`,
      expectedOrigin: origin,
      expectedAction: "auth-signup",
      payload: { action: "auth-signup", sitekey_present: true },
    })).toBe(true);
    expect(isHandoffGraphTurnstileCompletion({
      frameURL: "https://api.workos.com/account",
      expectedOrigin: origin,
      expectedAction: "auth-signup",
      payload: { action: "auth-signup", sitekey_present: true },
    })).toBe(false);
  });
});

describe("credential and CLI contracts", () => {
  it("pins the only upload fixture to its checked-in synthetic bytes", async () => {
    const fixture = await readFile(resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../testdata/fixtures/codex_session.jsonl",
    ));
    expect(createHash("sha256").update(fixture).digest("hex"))
      .toBe(ACCEPTANCE_FIXTURE_SHA256);
  });

  it("accepts a one-time device response but keeps the credential out of arguments", () => {
    expect(parseDeviceCredential({
      device: { id: DEVICE_ID, token: DEVICE_TOKEN },
    })).toEqual({ id: DEVICE_ID, token: DEVICE_TOKEN });
    const env = credentialEnvironment({ HFG_DATA_DIR: "/tmp/safe" }, DEVICE_TOKEN);
    expect(env.HFG_DEVICE_TOKEN).toBe(DEVICE_TOKEN);
    expect(() => assertCredentialAbsentFromArguments(
      ["sync", "--json"],
      [DEVICE_TOKEN],
    )).not.toThrow();
    expect(() => assertCredentialAbsentFromArguments(
      ["sync", DEVICE_TOKEN],
      [DEVICE_TOKEN],
    )).toThrow("credential_present_in_arguments");
  });

  it("requires preview, accepted first upload, and an up-to-date repeat", () => {
    const preview = parseCLIReport(cliReport({
      mode: "preview",
      cursor: 0,
      accepted_events: 0,
      batches_sent: 0,
      up_to_date: false,
      first_upload: true,
      workspace_bound: false,
    }));
    const first = parseCLIReport(cliReport());
    const repeat = parseCLIReport(cliReport({
      accepted_events: 0,
      batches_sent: 0,
      first_upload: false,
    }));
    expect(() => assertCLISequence(preview, first, repeat)).not.toThrow();
    expect(() => assertCLISequence(preview, first, {
      ...repeat,
      accepted_events: 1,
    })).toThrow("cli_repeat_sync_contract_failed");
  });

  it("binds the selected release archive to one strict checksum record", () => {
    const asset = "handoffgraph_0.8.0-beta.1_darwin_arm64.tar.gz";
    const digest = "3".repeat(64);
    expect(parseChecksumManifest(
      `${digest}  ${asset}\n${"4".repeat(64)}  handoffgraph_0.8.0-beta.1_linux_amd64.tar.gz\n`,
      asset,
    )).toBe(digest);
    expect(() => parseChecksumManifest(
      `${digest}  ${asset}\n${digest}  ${asset}\n`,
      asset,
    )).toThrow("invalid_checksum_manifest");
    expect(() => parseChecksumManifest(
      `${digest}  handoffgraph_0.8.0-beta.1_linux_amd64.tar.gz\n`,
      asset,
    )).toThrow("release_asset_checksum_missing");
  });

  it("derives the exact current-platform release asset name from the expected version", () => {
    expect(expectedReleaseAssetName("v0.8.0-beta.1", "darwin", "arm64"))
      .toBe("handoffgraph_0.8.0-beta.1_darwin_arm64.tar.gz");
    expect(() => expectedReleaseAssetName("0.8.0-beta.1", "darwin", "arm64"))
      .toThrow("invalid_expected_cli_version");
  });

  it("binds an immutable canonical GitHub release and tag to source and asset digests", () => {
    expect(ACCEPTANCE_GITHUB_REPOSITORY).toBe("handoffgraph/handoffgraph");
    const version = "v0.8.0-beta.1";
    const archive = "handoffgraph_0.8.0-beta.1_darwin_arm64.tar.gz";
    const assets = expectedPublishedReleaseAssets(version).map((name) => ({
      name,
      state: "uploaded",
      size: 100,
      digest: `sha256:${name === archive ? "7".repeat(64) : name === "checksums.txt" ? "8".repeat(64) : "9".repeat(64)}`,
      browser_download_url: `https://github.com/${ACCEPTANCE_GITHUB_REPOSITORY}/releases/download/${version}/${name}`,
    }));
    expect(parsePublishedGitHubRelease({
      value: {
        tag_name: version,
        draft: false,
        prerelease: true,
        immutable: true,
        assets,
      },
      version,
      archiveName: archive,
    })).toEqual({
      checksums_url: `https://github.com/${ACCEPTANCE_GITHUB_REPOSITORY}/releases/download/${version}/checksums.txt`,
      checksums_sha256: "8".repeat(64),
      archive_sha256: "7".repeat(64),
    });
    expect(() => parsePublishedGitHubRelease({
      value: {
        tag_name: version,
        draft: true,
        prerelease: true,
        immutable: false,
        assets,
      },
      version,
      archiveName: archive,
    })).toThrow("published_release_not_immutable");

    expect(parsePublishedGitHubTagReference({
      ref: `refs/tags/${version}`,
      object: { type: "tag", sha: "b".repeat(40) },
    }, version)).toEqual({ object_type: "tag", object_sha: "b".repeat(40) });
    expect(parsePublishedGitHubAnnotatedTag({
      value: {
        sha: "b".repeat(40),
        tag: version,
        object: { type: "commit", sha: SOURCE_SHA },
      },
      version,
      tagObjectSHA: "b".repeat(40),
    })).toBe(SOURCE_SHA);
  });

  it("requires fresh dedicated identities with the exact active and lifetime limits", () => {
    expect(parseFreshAccountQuota({
      workspace_id: WORKSPACE_A,
      active_devices: 0,
      max_devices: 2,
      used_device_issuances: 0,
      max_device_issuances: 10,
    })).toMatchObject({ max_devices: 2, max_device_issuances: 10 });
    expect(() => parseFreshAccountQuota({
      workspace_id: WORKSPACE_A,
      active_devices: 0,
      max_devices: 2,
      used_device_issuances: 1,
      max_device_issuances: 10,
    })).toThrow("acceptance_identity_not_fresh");
  });
});

describe("tenant and deletion proof contracts", () => {
  it("makes the post-confirmation one-shot consequence explicit at the TTY boundary", () => {
    expect(DELETION_ONE_SHOT_NOTICE).toContain("after you enter the exact confirmation");
    expect(DELETION_ONE_SHOT_NOTICE).toContain("ownership uncertain");
    expect(DELETION_ONE_SHOT_NOTICE).toContain("fresh dedicated run");
  });

  it("cleans sentinels only when deletion is certainly undispatched or rejected", () => {
    expect(mayCleanupDeletionSentinels("not_dispatched")).toBe(true);
    expect(mayCleanupDeletionSentinels("rejected")).toBe(true);
    expect(mayCleanupDeletionSentinels("uncertain")).toBe(false);
    expect(mayCleanupDeletionSentinels("accepted")).toBe(false);
    expect(isCertainlyRejectedDeletionStatus(400)).toBe(true);
    expect(isCertainlyRejectedDeletionStatus(403)).toBe(true);
    expect(isCertainlyRejectedDeletionStatus(409)).toBe(false);
    expect(isCertainlyRejectedDeletionStatus(500)).toBe(false);
    expect(isCertainlyRejectedDeletionStatus(503)).toBe(false);
  });

  it("binds WorkOS deletion proof to a pre-delete readable exact identity", () => {
    const providerSubject = "user_acceptance_subject";
    expect(() => assertWorkOSIdentityReadable({
      status: 200,
      body: { id: providerSubject },
      providerSubject,
    })).not.toThrow();
    expect(() => assertWorkOSIdentityReadable({
      status: 404,
      body: { message: "not found" },
      providerSubject,
    })).toThrow("workos_identity_not_readable");
    expect(() => assertWorkOSIdentityReadable({
      status: 200,
      body: { id: "user_other_environment" },
      providerSubject,
    })).toThrow("workos_identity_not_readable");
    expect(() => assertWorkOSIdentityDeleted(404)).not.toThrow();
    expect(() => assertWorkOSIdentityDeleted(200))
      .toThrow("workos_identity_survived_deletion");
  });

  it("requires reciprocal own visibility, foreign absence, and 404 targeting", () => {
    expect(() => assertReciprocalTenantIsolation({
      workspaceA: WORKSPACE_A,
      workspaceB: WORKSPACE_B,
      workstreamA: WORKSTREAM_A,
      workstreamB: WORKSTREAM_B,
      pageA: { workstreamIDs: [WORKSTREAM_A], nextCursor: null },
      pageB: { workstreamIDs: [WORKSTREAM_B], nextCursor: null },
      aTargetingBStatus: 404,
      bTargetingAStatus: 404,
    })).not.toThrow();
    expect(() => assertReciprocalTenantIsolation({
      workspaceA: WORKSPACE_A,
      workspaceB: WORKSPACE_B,
      workstreamA: WORKSTREAM_A,
      workstreamB: WORKSTREAM_B,
      pageA: { workstreamIDs: [WORKSTREAM_A, WORKSTREAM_B], nextCursor: null },
      pageB: { workstreamIDs: [WORKSTREAM_B], nextCursor: null },
      aTargetingBStatus: 404,
      bTargetingAStatus: 404,
    })).toThrow("cross_tenant_isolation_failed");
  });

  it("classifies only Wrangler's exact not-found result as R2 absence", () => {
    expect(() => assertR2ObjectMissing({
      code: 1,
      stdout: "",
      stderr: "✘ [ERROR] The specified key does not exist.\n",
    })).not.toThrow();
    expect(() => assertR2ObjectMissing({
      code: 1,
      stdout: "",
      stderr: "✘ [ERROR] Authentication failed.\n",
    })).toThrow("r2_absence_unproven");
    expect(() => assertR2ObjectMissing({
      code: 0,
      stdout: "sentinel",
      stderr: "",
    })).toThrow("r2_object_present");
  });

  it("covers every purge table and validates terminal timestamps and sweeps", () => {
    const rows = [
      ...acceptancePurgeTables,
      "users",
      "workspaces",
      "provider_identities",
      "workspace_deletion_kv_keys",
    ].map((table_name) => ({ table_name, row_count: 0 }));
    expect(assertPurgeCounts(rows)).toBe(rows.length);
    expect(parseDeletionTombstone({
      status: "complete",
      requested_at: 10,
      workos_deleted_at: 20,
      completed_at: 30,
      r2_sweeps: 2,
    })).toMatchObject({ status: "complete", r2_sweeps: 2 });
    expect(() => parseDeletionTombstone({
      status: "complete",
      requested_at: 10,
      workos_deleted_at: 20,
      completed_at: 30,
      r2_sweeps: 1,
    })).toThrow("invalid_deletion_tombstone");
  });

  it("keeps exact tenant sentinels separate from the permanent ledger", () => {
    const sentinels = acceptanceSentinelKeys(WORKSPACE_A, SOURCE_SHA);
    expect(sentinels).toEqual([
      `artifacts/${WORKSPACE_A}/hfg-acceptance-${SOURCE_SHA.slice(0, 12)}.txt`,
      `exports/${WORKSPACE_A}/hfg-acceptance-${SOURCE_SHA.slice(0, 12)}.txt`,
      `attachments/${WORKSPACE_A}/hfg-acceptance-${SOURCE_SHA.slice(0, 12)}.txt`,
      `gwcache/${WORKSPACE_A}/hfg-acceptance-${SOURCE_SHA.slice(0, 12)}.txt`,
    ]);
    expect(parseDeletionLedger({
      schema_version: "hfg.account-deletion-ledger.v1",
      workspace_id: WORKSPACE_A,
      requested_by_user_hash: "f".repeat(64),
      requested_at: 10,
    }, WORKSPACE_A)).toEqual({
      schema_version: "hfg.account-deletion-ledger.v1",
      workspace_id: WORKSPACE_A,
      requested_at: 10,
    });
  });

  it("requires a real TTY and the exact workspace deletion phrase", () => {
    expect(() => assertDeletionConfirmation({
      workspaceId: WORKSPACE_A,
      typed: `DELETE ${WORKSPACE_A}`,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })).not.toThrow();
    expect(() => assertDeletionConfirmation({
      workspaceId: WORKSPACE_A,
      typed: `delete ${WORKSPACE_A}`,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })).toThrow("deletion_confirmation_mismatch");
    expect(() => assertDeletionConfirmation({
      workspaceId: WORKSPACE_A,
      typed: `DELETE ${WORKSPACE_A}`,
      stdinIsTTY: false,
      stdoutIsTTY: true,
    })).toThrow("deletion_requires_tty");
  });
});

describe("sanitized evidence", () => {
  it("serializes only the allowlisted, credential-free proof", () => {
    const serialized = serializeSanitizedEvidence(baseEvidence());
    expect(JSON.parse(serialized)).toEqual(baseEvidence());
    expect(serialized).not.toContain("hfg_dev_");
    expect(serialized).not.toContain("Bearer ");
  });

  it("fails closed on unexpected keys and credential-shaped allowed values", () => {
    const forbiddenKey = baseEvidence() as unknown as Record<string, unknown>;
    forbiddenKey["providerSubject"] = "user_secret";
    expect(() => serializeSanitizedEvidence(
      forbiddenKey as unknown as HostedAcceptanceEvidence,
    )).toThrow("invalid_evidence_envelope");

    const forbiddenValue = lifecycleEvidence();
    forbiddenValue.cli!.version = DEVICE_TOKEN;
    expect(() => serializeSanitizedEvidence(forbiddenValue))
      .toThrow("invalid_expected_cli_version");
  });

  it("accepts the exact lifecycle evidence shape and rejects nested extras", () => {
    expect(() => serializeSanitizedEvidence(lifecycleEvidence())).not.toThrow();
    const unexpected = lifecycleEvidence() as unknown as {
      cli: Record<string, unknown>;
    };
    unexpected.cli.responseBody = "safe-looking";
    expect(() => serializeSanitizedEvidence(
      unexpected as unknown as HostedAcceptanceEvidence,
    )).toThrow("invalid_evidence_cli");
  });

  it("accepts only terminal deletion evidence tied to lane A", () => {
    expect(() => serializeSanitizedEvidence(deletionEvidence())).not.toThrow();
    const wrongWorkspace = deletionEvidence();
    wrongWorkspace.deletion!.workspace_id = WORKSPACE_B;
    expect(() => serializeSanitizedEvidence(wrongWorkspace))
      .toThrow("invalid_evidence_deletion");
  });
});
