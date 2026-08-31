import { WORKSPACE_PURGE_TABLES, workspaceObjectPrefixes } from "../src/account";
import {
  DELETION_LEDGER_SCHEMA,
  deletionLedgerKey,
} from "../src/deletion_ledger";

export type AcceptanceEnvironment = "staging" | "production";
export type AcceptancePhase = "preflight" | "lifecycle" | "deletion";
export type AccountLane = "a" | "b";
export type DeletionDispatchState = "not_dispatched" | "uncertain" | "rejected" | "accepted";

export const ACCEPTANCE_SCHEMA = "hfg.hosted-acceptance.v1";
export const DELETION_ONE_SHOT_NOTICE =
  "ONE-SHOT: after you enter the exact confirmation, any failure may consume lifetime issuances or leave deletion ownership uncertain; reconcile operationally, then retire this identity and use a fresh dedicated run.";
export const ACCEPTANCE_FIXTURE_RELATIVE_PATH = "testdata/fixtures/codex_session.jsonl";
export const ACCEPTANCE_FIXTURE_SHA256 = "e07cf64db6f82bc8eb7fec0105d6f0ab98603684e127e06eea6f76bacc194895";
export const ACCEPTANCE_GITHUB_REPOSITORY = "handoffgraph/handoffgraph";
export const ACCEPTANCE_ORIGINS: Readonly<Record<AcceptanceEnvironment, string>> =
  Object.freeze({
    staging: "https://handoffgraph-api-staging.arbaz-khan.workers.dev",
    production: "https://api.handoffgraph.dev",
  });
export const ACCEPTANCE_LANDING_ORIGIN = "https://handoffgraph.dev";

export const ACCEPTANCE_RESOURCES = Object.freeze({
  staging: Object.freeze({
    d1: "handoffgraph-staging",
    r2: "handoffgraph-bodies-staging",
    wranglerEnvironment: "staging",
  }),
  production: Object.freeze({
    d1: "handoffgraph",
    r2: "handoffgraph-bodies",
    wranglerEnvironment: null,
  }),
});

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const WORKER_VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_ID = /^wsp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const WORKSTREAM_ID = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DEVICE_ID = /^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DEVICE_TOKEN = /^hfg_dev_[A-Za-z0-9_-]{43}$/;
const WORKOS_USER_ID = /^user_[A-Za-z0-9_-]{1,190}$/;
const SAFE_CHECK_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CLI_VERSION = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const RELEASE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\.tar\.gz|\.zip)$/;

const FORBIDDEN_EVIDENCE_KEY = /authorization|cookie|csrf|email|password|secret|token|providersubject|rawbody|responsebody|apikey/i;
const FORBIDDEN_EVIDENCE_VALUE =
  /(?:hfg_dev_[A-Za-z0-9_-]+|__Host-hfg_|Bearer\s+|[?&](?:code|state|session_id)=|sk_(?:test|live)_[A-Za-z0-9_-]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class AcceptanceContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcceptanceContractError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new AcceptanceContractError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function safeInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(code);
  }
  return value;
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") fail(code);
  return value;
}

export function parseEnvironment(value: string): AcceptanceEnvironment {
  if (value !== "staging" && value !== "production") {
    fail("invalid_environment");
  }
  return value;
}

export function parsePhase(value: string): AcceptancePhase {
  if (value !== "preflight" && value !== "lifecycle" && value !== "deletion") {
    fail("invalid_phase");
  }
  return value;
}

export function mayCleanupDeletionSentinels(state: DeletionDispatchState): boolean {
  return state === "not_dispatched" || state === "rejected";
}

export function isCertainlyRejectedDeletionStatus(status: number): boolean {
  // Only these handler responses are guaranteed to occur before the D1
  // workspace prelock. A 409 or 5xx is deliberately absent: both can be
  // returned after the prelock commits, so they are uncertain and own any
  // seeded sentinels.
  return status === 400 || status === 403;
}

export function validateSourceSHA(value: string): string {
  const normalized = value.toLowerCase();
  if (value !== normalized || !SOURCE_SHA.test(normalized)) fail("invalid_source_sha");
  return normalized;
}

export function validateExpectedCLIVersion(value: string): string {
  if (!CLI_VERSION.test(value)) fail("invalid_expected_cli_version");
  return value;
}

export function expectedReleaseAssetName(
  version: string,
  operatingSystem: "darwin" | "linux",
  architecture: "amd64" | "arm64",
): string {
  return `handoffgraph_${validateExpectedCLIVersion(version).slice(1)}_${operatingSystem}_${architecture}.tar.gz`;
}

export function expectedPublishedReleaseAssets(version: string): string[] {
  const release = validateExpectedCLIVersion(version).slice(1);
  return [
    "checksums.txt",
    `handoffgraph_${release}_darwin_amd64.tar.gz`,
    `handoffgraph_${release}_darwin_arm64.tar.gz`,
    `handoffgraph_${release}_linux_amd64.tar.gz`,
    `handoffgraph_${release}_linux_arm64.tar.gz`,
    `handoffgraph_${release}_windows_amd64.zip`,
    `handoffgraph_${release}_windows_arm64.zip`,
  ].sort();
}

export interface PublishedReleaseIdentity {
  checksums_url: string;
  checksums_sha256: string;
  archive_sha256: string;
}

export function parsePublishedGitHubRelease(input: {
  value: unknown;
  version: string;
  archiveName: string;
}): PublishedReleaseIdentity {
  const version = validateExpectedCLIVersion(input.version);
  if (!RELEASE_ASSET.test(input.archiveName)) fail("invalid_release_asset_name");
  if (!isRecord(input.value) || !Array.isArray(input.value.assets)) {
    fail("invalid_published_release");
  }
  const expectedPrerelease = version.includes("-");
  if (
    input.value.tag_name !== version ||
    input.value.draft !== false ||
    input.value.prerelease !== expectedPrerelease ||
    input.value.immutable !== true
  ) fail("published_release_not_immutable");

  const expectedNames = expectedPublishedReleaseAssets(version);
  const assets = new Map<string, { url: string; digest: string }>();
  for (const value of input.value.assets) {
    if (!isRecord(value) || typeof value.name !== "string" || assets.has(value.name)) {
      fail("invalid_published_release_assets");
    }
    if (
      value.state !== "uploaded" ||
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size <= 0 ||
      typeof value.browser_download_url !== "string" ||
      typeof value.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(value.digest)
    ) fail("invalid_published_release_assets");
    const expectedURL = `https://github.com/${ACCEPTANCE_GITHUB_REPOSITORY}/releases/download/${version}/${value.name}`;
    if (value.browser_download_url !== expectedURL) {
      fail("invalid_published_release_assets");
    }
    assets.set(value.name, {
      url: value.browser_download_url,
      digest: value.digest.slice("sha256:".length),
    });
  }
  const actualNames = [...assets.keys()].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) fail("invalid_published_release_assets");
  const checksums = assets.get("checksums.txt");
  const archive = assets.get(input.archiveName);
  if (checksums === undefined || archive === undefined) {
    fail("published_release_asset_missing");
  }
  return {
    checksums_url: checksums.url,
    checksums_sha256: checksums.digest,
    archive_sha256: archive.digest,
  };
}

export interface PublishedTagReference {
  object_type: "commit" | "tag";
  object_sha: string;
}

export function parsePublishedGitHubTagReference(
  value: unknown,
  version: string,
): PublishedTagReference {
  const expectedVersion = validateExpectedCLIVersion(version);
  if (!isRecord(value) || value.ref !== `refs/tags/${expectedVersion}` || !isRecord(value.object)) {
    fail("invalid_published_tag_reference");
  }
  const objectType = value.object.type;
  const objectSHA = value.object.sha;
  if (
    (objectType !== "commit" && objectType !== "tag") ||
    typeof objectSHA !== "string" ||
    !SOURCE_SHA.test(objectSHA)
  ) fail("invalid_published_tag_reference");
  return { object_type: objectType, object_sha: objectSHA };
}

export function parsePublishedGitHubAnnotatedTag(input: {
  value: unknown;
  version: string;
  tagObjectSHA: string;
}): string {
  const version = validateExpectedCLIVersion(input.version);
  const tagObjectSHA = validateSourceSHA(input.tagObjectSHA);
  if (
    !isRecord(input.value) ||
    input.value.sha !== tagObjectSHA ||
    input.value.tag !== version ||
    !isRecord(input.value.object) ||
    input.value.object.type !== "commit" ||
    typeof input.value.object.sha !== "string" ||
    !SOURCE_SHA.test(input.value.object.sha)
  ) fail("invalid_published_annotated_tag");
  return input.value.object.sha;
}

export function validateSHA256(value: string, code = "invalid_sha256"): string {
  if (!SHA256.test(value)) fail(code);
  return value;
}

export function parseChecksumManifest(text: string, assetName: string): string {
  if (!RELEASE_ASSET.test(assetName)) fail("invalid_release_asset_name");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length === 0 || lines.some((line) => line === "")) {
    fail("invalid_checksum_manifest");
  }
  const seen = new Set<string>();
  let expected: string | null = null;
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (match === null || seen.has(match[2])) fail("invalid_checksum_manifest");
    seen.add(match[2]);
    if (match[2] === assetName) expected = match[1];
  }
  if (expected === null) fail("release_asset_checksum_missing");
  return expected;
}

export function expectedWorkerTag(sourceSHA: string): string {
  return `git-${validateSourceSHA(sourceSHA).slice(0, 12)}`;
}

export function validateTargetOrigin(
  value: string,
  environment: AcceptanceEnvironment,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_target_origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== ACCEPTANCE_ORIGINS[environment]
  ) {
    fail("invalid_target_origin");
  }
  return url.origin;
}

export interface HeaderReader {
  get(name: string): string | null;
}

export interface DeploymentIdentity {
  worker_version_id: string;
  worker_version_tag: string;
}

export function assertHealthyDeployment(input: {
  status: number;
  headers: HeaderReader;
  body: unknown;
  sourceSHA: string;
}): DeploymentIdentity {
  if (input.status !== 200) fail("health_status_mismatch");
  if (input.headers.get("cache-control") !== "no-store") {
    fail("health_cache_policy_mismatch");
  }
  if (input.headers.get("x-handoffgraph-maintenance") !== null) {
    fail("hosted_maintenance_active");
  }
  if (!isRecord(input.body) || Object.keys(input.body).length !== 1 || input.body.status !== "ok") {
    fail("health_body_mismatch");
  }
  const version = input.headers.get("x-handoffgraph-worker-version");
  const tag = input.headers.get("x-handoffgraph-worker-tag");
  if (version === null || !WORKER_VERSION_ID.test(version)) {
    fail("worker_version_missing");
  }
  if (tag !== expectedWorkerTag(input.sourceSHA)) {
    fail("worker_tag_mismatch");
  }
  return { worker_version_id: version, worker_version_tag: tag };
}

export function validateWorkspaceID(value: unknown): string {
  if (typeof value !== "string" || !WORKSPACE_ID.test(value)) {
    fail("invalid_workspace_id");
  }
  return value;
}

export function validateWorkstreamID(value: unknown): string {
  if (typeof value !== "string" || !WORKSTREAM_ID.test(value)) {
    fail("invalid_workstream_id");
  }
  return value;
}

export function parseAccountWorkspace(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.workspace)) {
    fail("invalid_account_response");
  }
  return validateWorkspaceID(value.workspace.id);
}

export interface DeviceCredential {
  id: string;
  token: string;
}

export function parseDeviceCredential(value: unknown): DeviceCredential {
  if (!isRecord(value) || !isRecord(value.device)) {
    fail("invalid_device_response");
  }
  const id = value.device.id;
  const token = value.device.token;
  if (typeof id !== "string" || !DEVICE_ID.test(id)) {
    fail("invalid_device_id");
  }
  if (typeof token !== "string" || !DEVICE_TOKEN.test(token)) {
    fail("invalid_device_credential");
  }
  return { id, token };
}

export interface AccountQuotaSnapshot {
  workspace_id: string;
  active_devices: number;
  max_devices: number;
  used_device_issuances: number;
  max_device_issuances: number;
}

export function parseAccountQuota(value: unknown): AccountQuotaSnapshot {
  if (!isRecord(value)) fail("invalid_account_quota");
  exactKeys(value, [
    "workspace_id",
    "active_devices",
    "max_devices",
    "used_device_issuances",
    "max_device_issuances",
  ], "invalid_account_quota");
  const snapshot = {
    workspace_id: validateWorkspaceID(value.workspace_id),
    active_devices: safeInteger(value.active_devices, "invalid_account_quota"),
    max_devices: safeInteger(value.max_devices, "invalid_account_quota"),
    used_device_issuances: safeInteger(
      value.used_device_issuances,
      "invalid_account_quota",
    ),
    max_device_issuances: safeInteger(
      value.max_device_issuances,
      "invalid_account_quota",
    ),
  };
  return snapshot;
}

export function assertFreshAccountQuota(snapshot: AccountQuotaSnapshot): void {
  if (
    snapshot.active_devices !== 0 ||
    snapshot.used_device_issuances !== 0 ||
    snapshot.max_devices !== 2 ||
    snapshot.max_device_issuances !== 10
  ) fail("acceptance_identity_not_fresh");
}

export function parseFreshAccountQuota(value: unknown): AccountQuotaSnapshot {
  const snapshot = parseAccountQuota(value);
  assertFreshAccountQuota(snapshot);
  return snapshot;
}

export function assertR2ObjectMissing(result: {
  code: number;
  stdout: string;
  stderr: string;
}): void {
  if (result.code === 0) fail("r2_object_present");
  const lines = result.stderr
    .replaceAll(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("🪵 Logs were written to"));
  if (
    result.stdout !== "" ||
    lines.length !== 1 ||
    !/^(?:✘\s*)?(?:\[ERROR\]\s*)?The specified key does not exist\.$/.test(lines[0])
  ) fail("r2_absence_unproven");
}

export interface CLIReport {
  mode: "preview" | "sync";
  high_watermark: number;
  cursor: number;
  accepted_events: number;
  batches_sent: number;
  up_to_date: boolean;
  first_upload: boolean;
  workspace_bound: boolean;
  local_capture_unaffected: boolean;
  preview_events: number;
}

export function parseCLIReport(value: unknown): CLIReport {
  if (!isRecord(value) || (value.mode !== "preview" && value.mode !== "sync")) {
    fail("invalid_cli_report");
  }
  if (!isRecord(value.preview)) fail("invalid_cli_report");
  const booleanFields = [
    "up_to_date",
    "first_upload",
    "workspace_bound",
    "local_capture_unaffected",
  ] as const;
  for (const field of booleanFields) {
    if (typeof value[field] !== "boolean") fail("invalid_cli_report");
  }
  return {
    mode: value.mode,
    high_watermark: safeInteger(value.high_watermark, "invalid_cli_report"),
    cursor: safeInteger(value.cursor, "invalid_cli_report"),
    accepted_events: safeInteger(value.accepted_events, "invalid_cli_report"),
    batches_sent: safeInteger(value.batches_sent, "invalid_cli_report"),
    up_to_date: booleanValue(value.up_to_date, "invalid_cli_report"),
    first_upload: booleanValue(value.first_upload, "invalid_cli_report"),
    workspace_bound: booleanValue(value.workspace_bound, "invalid_cli_report"),
    local_capture_unaffected: booleanValue(
      value.local_capture_unaffected,
      "invalid_cli_report",
    ),
    preview_events: safeInteger(value.preview.events, "invalid_cli_report"),
  };
}

export function assertCLISequence(
  preview: CLIReport,
  firstSync: CLIReport,
  repeatSync: CLIReport,
): void {
  if (
    preview.mode !== "preview" ||
    preview.preview_events < 1 ||
    preview.accepted_events !== 0 ||
    preview.batches_sent !== 0 ||
    preview.cursor !== 0 ||
    !preview.first_upload ||
    preview.workspace_bound ||
    !preview.local_capture_unaffected
  ) fail("cli_preview_contract_failed");
  if (
    firstSync.mode !== "sync" ||
    !firstSync.first_upload ||
    !firstSync.workspace_bound ||
    !firstSync.local_capture_unaffected ||
    !firstSync.up_to_date ||
    firstSync.high_watermark !== preview.high_watermark ||
    firstSync.accepted_events !== preview.preview_events ||
    firstSync.batches_sent < 1 ||
    firstSync.cursor !== preview.high_watermark
  ) fail("cli_first_sync_contract_failed");
  if (
    repeatSync.mode !== "sync" ||
    !repeatSync.up_to_date ||
    !repeatSync.workspace_bound ||
    repeatSync.first_upload ||
    !repeatSync.local_capture_unaffected ||
    repeatSync.high_watermark !== firstSync.high_watermark ||
    repeatSync.accepted_events !== 0 ||
    repeatSync.batches_sent !== 0 ||
    repeatSync.cursor !== firstSync.cursor
  ) fail("cli_repeat_sync_contract_failed");
}

export interface WorkstreamPage {
  workstreamIDs: string[];
  nextCursor: string | null;
}

export function parseWorkstreamPage(value: unknown): WorkstreamPage {
  if (!isRecord(value) || !Array.isArray(value.workstreams)) {
    fail("invalid_workstream_response");
  }
  const workstreamIDs = value.workstreams.map((item) => {
    if (!isRecord(item)) fail("invalid_workstream_response");
    return validateWorkstreamID(item.id);
  });
  if (value.next_cursor !== null && typeof value.next_cursor !== "string") {
    fail("invalid_workstream_response");
  }
  return { workstreamIDs, nextCursor: value.next_cursor };
}

export function assertReciprocalTenantIsolation(input: {
  workspaceA: string;
  workspaceB: string;
  workstreamA: string;
  workstreamB: string;
  pageA: WorkstreamPage;
  pageB: WorkstreamPage;
  aTargetingBStatus: number;
  bTargetingAStatus: number;
}): void {
  const workspaceA = validateWorkspaceID(input.workspaceA);
  const workspaceB = validateWorkspaceID(input.workspaceB);
  const workstreamA = validateWorkstreamID(input.workstreamA);
  const workstreamB = validateWorkstreamID(input.workstreamB);
  if (workspaceA === workspaceB || workstreamA === workstreamB) {
    fail("tenant_id_collision");
  }
  if (
    !input.pageA.workstreamIDs.includes(workstreamA) ||
    input.pageA.workstreamIDs.includes(workstreamB) ||
    !input.pageB.workstreamIDs.includes(workstreamB) ||
    input.pageB.workstreamIDs.includes(workstreamA) ||
    input.aTargetingBStatus !== 404 ||
    input.bTargetingAStatus !== 404
  ) fail("cross_tenant_isolation_failed");
}

export interface DeletionTombstone {
  status: "complete";
  requested_at: number;
  workos_deleted_at: number;
  completed_at: number;
  r2_sweeps: number;
}

export function parseDeletionTombstone(value: unknown): DeletionTombstone {
  if (!isRecord(value) || value.status !== "complete") {
    fail("deletion_not_complete");
  }
  const requestedAt = safeInteger(value.requested_at, "invalid_deletion_tombstone");
  const workosDeletedAt = safeInteger(value.workos_deleted_at, "invalid_deletion_tombstone");
  const completedAt = safeInteger(value.completed_at, "invalid_deletion_tombstone");
  const r2Sweeps = safeInteger(value.r2_sweeps, "invalid_deletion_tombstone");
  if (
    workosDeletedAt < requestedAt ||
    completedAt < workosDeletedAt ||
    r2Sweeps < 2
  ) {
    fail("invalid_deletion_tombstone");
  }
  return {
    status: "complete",
    requested_at: requestedAt,
    workos_deleted_at: workosDeletedAt,
    completed_at: completedAt,
    r2_sweeps: r2Sweeps,
  };
}

export interface PurgeCountRow {
  table_name: string;
  row_count: number;
}

export function assertPurgeCounts(value: unknown): number {
  if (!Array.isArray(value)) fail("invalid_purge_counts");
  const expected = new Set<string>([
    ...WORKSPACE_PURGE_TABLES,
    "users",
    "workspaces",
    "provider_identities",
    "workspace_deletion_kv_keys",
  ]);
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.table_name !== "string") {
      fail("invalid_purge_counts");
    }
    const count = safeInteger(item.row_count, "invalid_purge_counts");
    if (!expected.has(item.table_name) || seen.has(item.table_name) || count !== 0) {
      fail("tenant_rows_remain");
    }
    seen.add(item.table_name);
  }
  if (seen.size !== expected.size) fail("purge_count_coverage_incomplete");
  return seen.size;
}

export function parseDeletionLedger(value: unknown, workspaceId: string): {
  schema_version: typeof DELETION_LEDGER_SCHEMA;
  workspace_id: string;
  requested_at: number;
} {
  const expectedWorkspace = validateWorkspaceID(workspaceId);
  if (!isRecord(value)) fail("invalid_deletion_ledger");
  const keys = Object.keys(value).sort();
  if (keys.join("\n") !== [
    "requested_at",
    "requested_by_user_hash",
    "schema_version",
    "workspace_id",
  ].join("\n")) fail("invalid_deletion_ledger");
  if (
    value.schema_version !== DELETION_LEDGER_SCHEMA ||
    value.workspace_id !== expectedWorkspace ||
    typeof value.requested_by_user_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.requested_by_user_hash)
  ) fail("invalid_deletion_ledger");
  return {
    schema_version: DELETION_LEDGER_SCHEMA,
    workspace_id: expectedWorkspace,
    requested_at: safeInteger(value.requested_at, "invalid_deletion_ledger"),
  };
}

export function validateWorkOSUserID(value: unknown): string {
  if (typeof value !== "string" || !WORKOS_USER_ID.test(value)) {
    fail("invalid_workos_identity");
  }
  return value;
}

export function assertWorkOSIdentityReadable(input: {
  status: number;
  body: unknown;
  providerSubject: string;
}): void {
  const expected = validateWorkOSUserID(input.providerSubject);
  if (
    input.status !== 200 ||
    !isRecord(input.body) ||
    input.body.id !== expected
  ) fail("workos_identity_not_readable");
}

export function assertWorkOSIdentityDeleted(status: number): void {
  if (status !== 404) fail("workos_identity_survived_deletion");
}

export function acceptanceSentinelKeys(workspaceId: string, sourceSHA: string): string[] {
  const suffix = `hfg-acceptance-${validateSourceSHA(sourceSHA).slice(0, 12)}.txt`;
  return workspaceObjectPrefixes(validateWorkspaceID(workspaceId)).map(
    (prefix) => `${prefix}${suffix}`,
  );
}

export function acceptanceObjectPrefixes(workspaceId: string): string[] {
  return [...workspaceObjectPrefixes(validateWorkspaceID(workspaceId))];
}

export function acceptanceDeletionLedgerKey(workspaceId: string): string {
  return deletionLedgerKey(validateWorkspaceID(workspaceId));
}

export function deletionConfirmation(workspaceId: string): string {
  return `DELETE ${validateWorkspaceID(workspaceId)}`;
}

export function assertDeletionConfirmation(input: {
  workspaceId: string;
  typed: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): void {
  if (!input.stdinIsTTY || !input.stdoutIsTTY) fail("deletion_requires_tty");
  if (input.typed !== deletionConfirmation(input.workspaceId)) {
    fail("deletion_confirmation_mismatch");
  }
}

export function credentialEnvironment(
  base: Record<string, string | undefined>,
  deviceCredential: string,
): Record<string, string | undefined> {
  if (!DEVICE_TOKEN.test(deviceCredential)) fail("invalid_device_credential");
  return { ...base, HFG_DEVICE_TOKEN: deviceCredential };
}

export function assertCredentialAbsentFromArguments(
  args: readonly string[],
  credentials: readonly string[],
): void {
  for (const credential of credentials) {
    if (credential !== "" && args.some((arg) => arg.includes(credential))) {
      fail("credential_present_in_arguments");
    }
  }
}

export interface AcceptanceCheck {
  id: string;
  outcome: "pass";
  status?: number;
  count?: number;
}

export function acceptanceEvidenceCheckContract(
  phase: AcceptancePhase,
  environment: AcceptanceEnvironment = "staging",
): AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [
    { id: "deployment.health", outcome: "pass", status: 200 },
    { id: "anonymous.root_redirect", outcome: "pass", status: 303 },
    { id: "anonymous.account", outcome: "pass", status: 200 },
    { id: "anonymous.me_denied", outcome: "pass", status: 401 },
    { id: "anonymous.plans", outcome: "pass", status: 200 },
    { id: "anonymous.ingest_denied", outcome: "pass", status: 401 },
    { id: "anonymous.devices_denied", outcome: "pass", status: 401 },
    { id: "anonymous.devices_create_denied", outcome: "pass", status: 401 },
    { id: "anonymous.workstreams_denied", outcome: "pass", status: 401 },
    { id: "anonymous.signout_denied", outcome: "pass", status: 401 },
    { id: "anonymous.delete_denied", outcome: "pass", status: 401 },
    { id: "hosted_basic.advanced_hidden", outcome: "pass", status: 404 },
  ];
  if (environment === "production") {
    checks.push({ id: "anonymous.apex_landing", outcome: "pass", status: 200 });
  }
  if (phase !== "preflight") {
    checks.push(
      { id: "browser.two_isolated_accounts", outcome: "pass", count: 2 },
      { id: "auth.signup_completed", outcome: "pass", count: 1 },
      { id: "browser.app_turnstile_marker_observed", outcome: "pass", count: 3 },
      { id: "device.fresh_quota_baseline", outcome: "pass", count: 2 },
      { id: "device.one_time_credential", outcome: "pass", count: 2 },
      { id: "device.active_quota", outcome: "pass", status: 429 },
      { id: "cli.published_release_provenance", outcome: "pass", count: 1 },
      { id: "cli.preview_write_free", outcome: "pass", count: 2 },
      { id: "cli.sync_and_idempotent_repeat", outcome: "pass", count: 2 },
      { id: "tenant.reciprocal_isolation", outcome: "pass", status: 404 },
      { id: "auth.logout_browser_only", outcome: "pass", status: 401 },
      { id: "auth.device_survives_logout", outcome: "pass", status: 200 },
      { id: "auth.workos_logout_traversed", outcome: "pass", count: 1 },
      { id: "device.primary_cleanup", outcome: "pass", count: phase === "deletion" ? 1 : 2 },
    );
  }
  if (phase === "deletion") {
    checks.push(
      { id: "deletion.immediate_auth_denial", outcome: "pass", status: 401 },
      { id: "deletion.workos_absent", outcome: "pass", status: 404 },
      { id: "deletion.d1_purge_complete", outcome: "pass", count: WORKSPACE_PURGE_TABLES.length + 4 },
      { id: "deletion.r2_sentinels_absent", outcome: "pass", count: 4 },
      { id: "deletion.r2_prefixes_empty", outcome: "pass", count: 4 },
      { id: "deletion.foreign_keys_clean", outcome: "pass", count: 0 },
      { id: "device.lifetime_quota", outcome: "pass", count: 10 },
      { id: "deletion.permanent_ledger_present", outcome: "pass", count: 1 },
    );
  }
  return checks;
}

export interface AccountEvidence {
  lane: AccountLane;
  workspace_id: string;
  workstream_id: string;
  preview_events: number;
  accepted_events: number;
  repeat_up_to_date: true;
  device_terminal_status: "revoked" | "deleted";
}

export interface HostedAcceptanceEvidence {
  schema_version: typeof ACCEPTANCE_SCHEMA;
  recorded_at: string;
  phase: AcceptancePhase;
  outcome: "pass";
  target: {
    environment: AcceptanceEnvironment;
    origin: string;
    source_sha: string;
    worker_version_id: string;
    worker_version_tag: string;
  };
  cli?: {
    version: string;
    binary_sha256: string;
    archive_name: string;
    archive_sha256: string;
  };
  accounts?: AccountEvidence[];
  checks: AcceptanceCheck[];
  deletion?: {
    workspace_id: string;
    status: "complete";
    workos_absent: true;
    r2_sweeps: number;
    purged_table_count: number;
    absent_sentinel_count: number;
    empty_prefix_count: number;
    foreign_key_violations: 0;
    lifetime_device_issuance_limit: 10;
    permanent_ledger_present: true;
  };
}

function assertEvidenceValue(value: unknown): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("evidence_not_finite");
    return;
  }
  if (typeof value === "string") {
    if (FORBIDDEN_EVIDENCE_VALUE.test(value)) fail("evidence_contains_credential");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertEvidenceValue(item));
    return;
  }
  if (!isRecord(value)) fail("evidence_not_json");
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[^A-Za-z0-9]/g, "");
    if (FORBIDDEN_EVIDENCE_KEY.test(normalizedKey)) {
      fail("evidence_contains_forbidden_key");
    }
    assertEvidenceValue(item);
  }
}

export function assertSanitizedEvidence(value: HostedAcceptanceEvidence): void {
  if (!isRecord(value)) fail("invalid_evidence_envelope");
  const phase = parsePhase(value.phase as string);
  const envelopeKeys = [
    "schema_version",
    "recorded_at",
    "phase",
    "outcome",
    "target",
    "checks",
    ...(phase === "preflight" ? [] : ["cli", "accounts"]),
    ...(phase === "deletion" ? ["deletion"] : []),
  ];
  exactKeys(value, envelopeKeys, "invalid_evidence_envelope");
  if (value.schema_version !== ACCEPTANCE_SCHEMA || value.outcome !== "pass") {
    fail("invalid_evidence_envelope");
  }
  if (!isRecord(value.target)) fail("invalid_evidence_target");
  exactKeys(value.target, [
    "environment",
    "origin",
    "source_sha",
    "worker_version_id",
    "worker_version_tag",
  ], "invalid_evidence_target");
  const environment = parseEnvironment(value.target.environment as string);
  if (typeof value.target.origin !== "string") fail("invalid_evidence_target");
  validateTargetOrigin(value.target.origin, environment);
  if (typeof value.target.source_sha !== "string") fail("invalid_evidence_target");
  const sourceSHA = validateSourceSHA(value.target.source_sha);
  if (
    typeof value.target.worker_version_id !== "string" ||
    !WORKER_VERSION_ID.test(value.target.worker_version_id)
  ) {
    fail("invalid_evidence_worker_version");
  }
  if (value.target.worker_version_tag !== expectedWorkerTag(sourceSHA)) {
    fail("invalid_evidence_worker_tag");
  }
  if (
    typeof value.recorded_at !== "string" ||
    !Number.isFinite(Date.parse(value.recorded_at)) ||
    new Date(value.recorded_at).toISOString() !== value.recorded_at
  ) fail("invalid_evidence_time");
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    fail("invalid_evidence_check");
  }
  const checkIDs = new Set<string>();
  for (const check of value.checks) {
    if (!isRecord(check)) fail("invalid_evidence_check");
    const hasStatus = Object.hasOwn(check, "status");
    const hasCount = Object.hasOwn(check, "count");
    exactKeys(
      check,
      ["id", "outcome", ...(hasStatus ? ["status"] : []), ...(hasCount ? ["count"] : [])],
      "invalid_evidence_check",
    );
    if (
      typeof check.id !== "string" ||
      !SAFE_CHECK_ID.test(check.id) ||
      checkIDs.has(check.id) ||
      check.outcome !== "pass" ||
      hasStatus === hasCount
    ) {
      fail("invalid_evidence_check");
    }
    checkIDs.add(check.id);
    if (hasStatus) {
      const status = safeInteger(check.status, "invalid_evidence_check");
      if (status < 100 || status > 599) fail("invalid_evidence_check");
    } else {
      safeInteger(check.count, "invalid_evidence_check");
    }
  }
  const expectedChecks = acceptanceEvidenceCheckContract(phase, environment);
  if (value.checks.length !== expectedChecks.length) fail("incomplete_evidence_checks");
  for (const expected of expectedChecks) {
    const actual = value.checks.find((check) => check.id === expected.id);
    if (
      actual === undefined ||
      actual.outcome !== expected.outcome ||
      actual.status !== expected.status ||
      actual.count !== expected.count
    ) fail("invalid_evidence_check_result");
  }
  if (phase !== "preflight") {
    if (!isRecord(value.cli)) fail("invalid_evidence_cli");
    exactKeys(value.cli, [
      "version",
      "binary_sha256",
      "archive_name",
      "archive_sha256",
    ], "invalid_evidence_cli");
    if (
      typeof value.cli.version !== "string" ||
      typeof value.cli.binary_sha256 !== "string" ||
      typeof value.cli.archive_name !== "string" ||
      typeof value.cli.archive_sha256 !== "string" ||
      !RELEASE_ASSET.test(value.cli.archive_name)
    ) fail("invalid_evidence_cli");
    validateExpectedCLIVersion(value.cli.version);
    if (!value.cli.archive_name.startsWith(`handoffgraph_${value.cli.version.slice(1)}_`)) {
      fail("invalid_evidence_cli");
    }
    validateSHA256(value.cli.binary_sha256, "invalid_evidence_cli");
    validateSHA256(value.cli.archive_sha256, "invalid_evidence_cli");
  }
  if (phase !== "preflight" && (!Array.isArray(value.accounts) || value.accounts.length !== 2)) {
    fail("invalid_evidence_account");
  }
  const accountLanes = new Set<AccountLane>();
  for (const account of value.accounts ?? []) {
    if (!isRecord(account)) fail("invalid_evidence_account");
    exactKeys(account, [
      "lane",
      "workspace_id",
      "workstream_id",
      "preview_events",
      "accepted_events",
      "repeat_up_to_date",
      "device_terminal_status",
    ], "invalid_evidence_account");
    if (
      (account.lane !== "a" && account.lane !== "b") ||
      accountLanes.has(account.lane) ||
      account.repeat_up_to_date !== true ||
      (account.device_terminal_status !== "revoked" &&
        account.device_terminal_status !== "deleted")
    ) fail("invalid_evidence_account");
    accountLanes.add(account.lane);
    validateWorkspaceID(account.workspace_id);
    validateWorkstreamID(account.workstream_id);
    const previewEvents = safeInteger(account.preview_events, "invalid_evidence_account");
    const acceptedEvents = safeInteger(account.accepted_events, "invalid_evidence_account");
    if (previewEvents < 1 || acceptedEvents !== previewEvents) {
      fail("invalid_evidence_account");
    }
  }
  const accountA = (value.accounts ?? []).find((account) => account.lane === "a");
  const accountB = (value.accounts ?? []).find((account) => account.lane === "b");
  if (
    phase !== "preflight" &&
    (accountA?.workspace_id === accountB?.workspace_id ||
      accountA?.workstream_id === accountB?.workstream_id)
  ) fail("invalid_evidence_account");
  if (phase === "lifecycle" && (
    accountA?.device_terminal_status !== "revoked" ||
    accountB?.device_terminal_status !== "revoked"
  )) fail("invalid_evidence_account");
  if (phase === "deletion") {
    if (!isRecord(value.deletion)) fail("invalid_evidence_deletion");
    exactKeys(value.deletion, [
      "workspace_id",
      "status",
      "workos_absent",
      "r2_sweeps",
      "purged_table_count",
      "absent_sentinel_count",
      "empty_prefix_count",
      "foreign_key_violations",
      "lifetime_device_issuance_limit",
      "permanent_ledger_present",
    ], "invalid_evidence_deletion");
    if (
      value.deletion.status !== "complete" ||
      value.deletion.workos_absent !== true ||
      value.deletion.permanent_ledger_present !== true ||
      value.deletion.foreign_key_violations !== 0 ||
      value.deletion.lifetime_device_issuance_limit !== 10 ||
      value.deletion.absent_sentinel_count !== 4 ||
      value.deletion.empty_prefix_count !== 4 ||
      value.deletion.purged_table_count !== WORKSPACE_PURGE_TABLES.length + 4 ||
      safeInteger(value.deletion.r2_sweeps, "invalid_evidence_deletion") < 2
    ) fail("invalid_evidence_deletion");
    const deletedWorkspace = validateWorkspaceID(value.deletion.workspace_id);
    if (
      accountA?.workspace_id !== deletedWorkspace ||
      accountA.device_terminal_status !== "deleted" ||
      accountB?.device_terminal_status !== "revoked"
    ) fail("invalid_evidence_deletion");
  }
  assertEvidenceValue(value);
}

export function serializeSanitizedEvidence(value: HostedAcceptanceEvidence): string {
  assertSanitizedEvidence(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const acceptancePurgeTables = WORKSPACE_PURGE_TABLES;
