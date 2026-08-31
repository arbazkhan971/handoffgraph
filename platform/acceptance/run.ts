import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { x as extractTar } from "tar";
import {
  authenticateInteractiveAccount,
  verifyApexLanding,
  browserAccountStatus,
  createPrimaryDevice,
  deleteInteractiveAccount,
  exerciseDeviceQuota,
  exerciseLifetimeDeviceIssuanceQuota,
  launchAcceptanceBrowser,
  reauthenticateInteractiveAccount,
  revokeAllActiveDevices,
  revokePrimaryDevice,
  signOutInteractiveAccount,
  type AuthIntent,
  type InteractiveAccount,
} from "./browser";
import {
  ACCEPTANCE_ORIGINS,
  ACCEPTANCE_LANDING_ORIGIN,
  ACCEPTANCE_RESOURCES,
  ACCEPTANCE_SCHEMA,
  ACCEPTANCE_GITHUB_REPOSITORY,
  ACCEPTANCE_FIXTURE_RELATIVE_PATH,
  ACCEPTANCE_FIXTURE_SHA256,
  AcceptanceContractError,
  DELETION_ONE_SHOT_NOTICE,
  acceptanceDeletionLedgerKey,
  acceptanceObjectPrefixes,
  acceptancePurgeTables,
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
  deletionConfirmation,
  expectedReleaseAssetName,
  parsePublishedGitHubAnnotatedTag,
  parsePublishedGitHubRelease,
  parsePublishedGitHubTagReference,
  parseChecksumManifest,
  parseCLIReport,
  parseDeletionLedger,
  parseDeletionTombstone,
  parseEnvironment,
  parsePhase,
  mayCleanupDeletionSentinels,
  parseWorkstreamPage,
  serializeSanitizedEvidence,
  validateSourceSHA,
  validateExpectedCLIVersion,
  validateSHA256,
  validateTargetOrigin,
  validateWorkOSUserID,
  validateWorkstreamID,
  validateWorkspaceID,
  type AcceptanceCheck,
  type AcceptanceEnvironment,
  type AcceptancePhase,
  type AccountEvidence,
  type AccountLane,
  type CLIReport,
  type DeploymentIdentity,
  type DeviceCredential,
  type DeletionDispatchState,
  type HostedAcceptanceEvidence,
} from "./contracts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = resolve(HERE, "..");
const REPOSITORY_DIR = resolve(PLATFORM_DIR, "..");
const EVIDENCE_ROOT = resolve(PLATFORM_DIR, ".acceptance");
const WRANGLER = resolve(PLATFORM_DIR, "node_modules/.bin/wrangler");
const WRANGLER_CONFIG = resolve(PLATFORM_DIR, "wrangler.toml");
const MAX_CAPTURE_BYTES = 1_048_576;
const CHILD_TIMEOUT_MS = 120_000;
const SENTINEL_BODY = "hfg.hosted-acceptance-sentinel.v1\n";
const PINNED_FIXTURE_PATH = resolve(REPOSITORY_DIR, ACCEPTANCE_FIXTURE_RELATIVE_PATH);

interface RunnerConfig {
  environment: AcceptanceEnvironment;
  phase: AcceptancePhase;
  origin: string;
  sourceSHA: string;
  cliArchivePath: string | null;
  checksumsPath: string | null;
  expectedCLIVersion: string | null;
  evidencePath: string;
  authIntentA: AuthIntent;
  authIntentB: AuthIntent;
  authTimeoutMs: number;
  deletionTimeoutMs: number;
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

type ChildEnvironment = Record<string, string | undefined>;

interface CLIAccountResult {
  workstreamId: string;
  preview: CLIReport;
  firstSync: CLIReport;
  repeatSync: CLIReport;
}

interface LifecycleResult {
  checks: AcceptanceCheck[];
  accounts: AccountEvidence[];
  accountA: InteractiveAccount;
  credentialA: DeviceCredential;
  providerBrowser: Awaited<ReturnType<typeof launchAcceptanceBrowser>>;
  cli: NonNullable<HostedAcceptanceEvidence["cli"]>;
}

interface PreparedCLI {
  executablePath: string;
  temporaryRoot: string;
  evidence: NonNullable<HostedAcceptanceEvidence["cli"]>;
}

interface DeletionIdentity {
  userId: string;
  providerSubject: string;
}

function runFail(code: string): never {
  throw new AcceptanceContractError(code);
}

function inheritedEnvironment(names: readonly string[]): ChildEnvironment {
  const selected: ChildEnvironment = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

function baseChildEnvironment(): ChildEnvironment {
  return inheritedEnvironment([
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ]);
}

function browserChildEnvironment(): Record<string, string> {
  const environment = {
    ...baseChildEnvironment(),
    ...inheritedEnvironment([
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XAUTHORITY",
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_RUNTIME_DIR",
    ]),
  };
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"),
  );
}

function usage(): string {
  return `Usage: npm run acceptance:hosted -- [options]

Options:
  --phase preflight|lifecycle|deletion
  --environment staging|production
  --origin <exact configured origin>
  --expected-source-sha <40 lowercase hex>
  --cli-archive <path to published platform tar.gz>
  --checksums <path to published checksums.txt>
  --expected-cli-version <exact vX.Y.Z prerelease>
  --evidence <path below platform/.acceptance>
  --auth-intent-a signin|signup
  --auth-intent-b signin|signup
  Lifecycle/deletion runs require at least one --auth-intent-* signup flow.
  --auth-timeout-seconds <60-1800>
  --deletion-timeout-seconds <900-3600>
`;
}

function flagValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) runFail("missing_flag_value");
  return value;
}

function boundedSeconds(raw: string, min: number, max: number, code: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) runFail(code);
  return value * 1_000;
}

function parseAuthIntent(value: string): AuthIntent {
  if (value !== "signin" && value !== "signup") runFail("invalid_auth_intent");
  return value;
}

function evidenceDestination(raw: string | null, config: {
  environment: AcceptanceEnvironment;
  phase: AcceptancePhase;
  sourceSHA: string;
}): string {
  const defaultName = `${config.environment}-${config.phase}-${config.sourceSHA.slice(0, 12)}.json`;
  const candidate = raw === null
    ? resolve(EVIDENCE_ROOT, defaultName)
    : resolve(PLATFORM_DIR, raw);
  const location = relative(EVIDENCE_ROOT, candidate);
  if (
    location === "" || location.startsWith("..") || isAbsolute(location) ||
    dirname(location) !== "."
  ) {
    runFail("unsafe_evidence_path");
  }
  return candidate;
}

function parseArguments(argv: string[]): RunnerConfig | "help" {
  let environment: AcceptanceEnvironment = "staging";
  let phase: AcceptancePhase = "preflight";
  let origin: string | null = null;
  let sourceSHA: string | null = null;
  let cliArchivePath: string | null = null;
  let checksumsPath: string | null = null;
  let expectedCLIVersion: string | null = null;
  let evidencePath: string | null = null;
  let authIntentA: AuthIntent = "signin";
  let authIntentB: AuthIntent = "signin";
  let authTimeoutMs = 10 * 60 * 1_000;
  let deletionTimeoutMs = 30 * 60 * 1_000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return "help";
    switch (arg) {
      case "--environment":
        environment = parseEnvironment(flagValue(argv, index));
        index += 1;
        break;
      case "--phase":
        phase = parsePhase(flagValue(argv, index));
        index += 1;
        break;
      case "--origin":
        origin = flagValue(argv, index);
        index += 1;
        break;
      case "--expected-source-sha":
        sourceSHA = flagValue(argv, index);
        index += 1;
        break;
      case "--cli-archive":
        cliArchivePath = resolve(process.cwd(), flagValue(argv, index));
        index += 1;
        break;
      case "--checksums":
        checksumsPath = resolve(process.cwd(), flagValue(argv, index));
        index += 1;
        break;
      case "--expected-cli-version":
        expectedCLIVersion = validateExpectedCLIVersion(flagValue(argv, index));
        index += 1;
        break;
      case "--evidence":
        evidencePath = flagValue(argv, index);
        index += 1;
        break;
      case "--auth-intent-a":
        authIntentA = parseAuthIntent(flagValue(argv, index));
        index += 1;
        break;
      case "--auth-intent-b":
        authIntentB = parseAuthIntent(flagValue(argv, index));
        index += 1;
        break;
      case "--auth-timeout-seconds":
        authTimeoutMs = boundedSeconds(
          flagValue(argv, index),
          60,
          1_800,
          "invalid_auth_timeout",
        );
        index += 1;
        break;
      case "--deletion-timeout-seconds":
        deletionTimeoutMs = boundedSeconds(
          flagValue(argv, index),
          900,
          3_600,
          "invalid_deletion_timeout",
        );
        index += 1;
        break;
      default:
        runFail("unknown_argument");
    }
  }

  if (sourceSHA === null) runFail("source_sha_required");
  const normalizedSHA = validateSourceSHA(sourceSHA);
  const targetOrigin = validateTargetOrigin(origin ?? ACCEPTANCE_ORIGINS[environment], environment);
  if (
    phase !== "preflight" &&
    (cliArchivePath === null || checksumsPath === null || expectedCLIVersion === null)
  ) {
    runFail("lifecycle_inputs_required");
  }
  return {
    environment,
    phase,
    origin: targetOrigin,
    sourceSHA: normalizedSHA,
    cliArchivePath,
    checksumsPath,
    expectedCLIVersion,
    evidencePath: evidenceDestination(evidencePath, {
      environment,
      phase,
      sourceSHA: normalizedSHA,
    }),
    authIntentA,
    authIntentB,
    authTimeoutMs,
    deletionTimeoutMs,
  };
}

async function boundedResponseText(response: Response, code: string): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_CAPTURE_BYTES) runFail(code);
  return new TextDecoder().decode(bytes);
}

function parseJSON(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    runFail(code);
  }
}

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    runFail("network_request_failed");
  }
}

async function runPreflight(config: RunnerConfig): Promise<{
  identity: DeploymentIdentity;
  checks: AcceptanceCheck[];
}> {
  const health = await request(new URL("/healthz", config.origin), { redirect: "manual" });
  const healthBody = parseJSON(
    await boundedResponseText(health, "health_response_too_large"),
    "invalid_health_json",
  );
  const identity = assertHealthyDeployment({
    status: health.status,
    headers: health.headers,
    body: healthBody,
    sourceSHA: config.sourceSHA,
  });

  const root = await request(new URL("/", config.origin), { redirect: "manual" });
  const expectedRootLocation = config.environment === "staging"
    ? "/account"
    : "https://handoffgraph.dev/";
  if (root.status !== 303 || root.headers.get("location") !== expectedRootLocation) {
    runFail("root_redirect_mismatch");
  }

  const account = await request(new URL("/account", config.origin), { redirect: "manual" });
  const accountHTML = await boundedResponseText(account, "account_response_too_large");
  const csp = account.headers.get("content-security-policy") ?? "";
  if (
    account.status !== 200 ||
    account.headers.get("cache-control") !== "no-store" ||
    !csp.includes("default-src 'none'") ||
    csp.includes("unsafe-inline") ||
    !accountHTML.includes("Sign in")
  ) runFail("signed_out_account_contract_failed");

  const me = await request(new URL("/v1/me", config.origin), { redirect: "manual" });
  if (me.status !== 401 || me.headers.get("cache-control") !== "no-store") {
    runFail("anonymous_account_boundary_failed");
  }
  const plans = await request(new URL("/v1/plans", config.origin), { redirect: "manual" });
  if (plans.status !== 200) runFail("plans_boundary_failed");
  const ingest = await request(new URL("/v1/event-batches", config.origin), {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: config.origin,
    },
    body: "{}",
  });
  if (ingest.status !== 401 || ingest.headers.get("cache-control") !== "no-store") {
    runFail("anonymous_ingest_boundary_failed");
  }
  const devices = await request(new URL("/v1/devices", config.origin), {
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (devices.status !== 401 || devices.headers.get("cache-control") !== "no-store") {
    runFail("anonymous_devices_boundary_failed");
  }
  const deviceCreate = await request(new URL("/v1/devices", config.origin), {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: config.origin,
    },
    body: JSON.stringify({ label: "anonymous-probe" }),
  });
  if (
    deviceCreate.status !== 401 ||
    deviceCreate.headers.get("cache-control") !== "no-store"
  ) runFail("anonymous_device_create_boundary_failed");
  const workstreams = await request(new URL("/v1/workstreams", config.origin), {
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (workstreams.status !== 401 || workstreams.headers.get("cache-control") !== "no-store") {
    runFail("anonymous_workstreams_boundary_failed");
  }
  const signout = await request(new URL("/v1/auth/signout", config.origin), {
    method: "POST",
    redirect: "manual",
    headers: { accept: "application/json", origin: config.origin },
  });
  if (signout.status !== 401 || signout.headers.get("cache-control") !== "no-store") {
    runFail("anonymous_signout_boundary_failed");
  }
  const deletion = await request(new URL("/v1/account", config.origin), {
    method: "DELETE",
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: config.origin,
    },
    body: JSON.stringify({ confirmation: "anonymous-probe" }),
  });
  if (deletion.status !== 401 || deletion.headers.get("cache-control") !== "no-store") {
    runFail("anonymous_delete_boundary_failed");
  }
  const advanced = await request(new URL("/v1/analytics/summary", config.origin), {
    redirect: "manual",
  });
  if (advanced.status !== 404) runFail("hosted_basic_surface_failed");

  if (config.environment === "production") {
    // The public landing page is the user entry point for production. Exercise
    // its rendered link into the production account surface, including the
    // browser navigation, rather than treating the API's redirect as sufficient.
    const landingBrowser = await launchAcceptanceBrowser(browserChildEnvironment());
    try {
      await verifyApexLanding({
        browser: landingBrowser,
        landingOrigin: ACCEPTANCE_LANDING_ORIGIN,
        apiOrigin: ACCEPTANCE_ORIGINS.production,
        timeoutMs: 30_000,
      });
    } finally {
      await landingBrowser.close();
    }
  }

  return {
    identity,
    checks: [
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
      ...(config.environment === "production"
        ? [{ id: "anonymous.apex_landing", outcome: "pass" as const, status: 200 }]
        : []),
    ],
  };
}

async function runChild(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: ChildEnvironment;
    input?: string;
    timeoutMs?: number;
  },
): Promise<ChildResult> {
  assertCredentialAbsentFromArguments(args, [
    options.env.HFG_DEVICE_TOKEN ?? "",
    options.env.CLOUDFLARE_API_TOKEN ?? "",
    options.env.WORKOS_API_KEY ?? "",
  ]);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const settleFailure = (code: string) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(new AcceptanceContractError(code));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CAPTURE_BYTES) return settleFailure("child_stdout_too_large");
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_CAPTURE_BYTES) return settleFailure("child_stderr_too_large");
      stderr.push(chunk);
    });
    child.on("error", () => settleFailure("child_process_failed"));
    const timeout = setTimeout(
      () => settleFailure("child_process_timeout"),
      options.timeoutMs ?? CHILD_TIMEOUT_MS,
    );
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolvePromise({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

async function mustRunChild(
  executable: string,
  args: string[],
  options: Parameters<typeof runChild>[2],
  code: string,
): Promise<ChildResult> {
  const result = await runChild(executable, args, options);
  if (result.code !== 0) runFail(code);
  return result;
}

async function binarySHA256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => rejectPromise(new AcceptanceContractError("cli_hash_failed")));
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function bytesSHA256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "handoffgraph-hosted-acceptance",
    "x-github-api-version": "2026-03-10",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubJSON(pathname: string, code: string): Promise<unknown> {
  const response = await request(
    new URL(pathname, "https://api.github.com"),
    { redirect: "manual", headers: githubHeaders() },
  );
  if (response.status !== 200) runFail(code);
  return parseJSON(
    await boundedResponseText(response, "github_response_too_large"),
    code,
  );
}

async function verifyPublishedRelease(input: {
  config: RunnerConfig;
  archiveName: string;
  archiveSHA256: string;
  checksumsText: string;
}): Promise<void> {
  if (input.config.expectedCLIVersion === null) runFail("lifecycle_inputs_required");
  const version = input.config.expectedCLIVersion;
  const repositoryPath = `/repos/${ACCEPTANCE_GITHUB_REPOSITORY}`;
  const releaseValue = await githubJSON(
    `${repositoryPath}/releases/tags/${encodeURIComponent(version)}`,
    "published_release_lookup_failed",
  );
  const release = parsePublishedGitHubRelease({
    value: releaseValue,
    version,
    archiveName: input.archiveName,
  });
  if (release.archive_sha256 !== input.archiveSHA256) {
    runFail("published_archive_digest_mismatch");
  }
  const localChecksumsSHA = bytesSHA256(input.checksumsText);
  if (release.checksums_sha256 !== localChecksumsSHA) {
    runFail("published_checksums_digest_mismatch");
  }

  const tagValue = await githubJSON(
    `${repositoryPath}/git/ref/tags/${encodeURIComponent(version)}`,
    "published_tag_lookup_failed",
  );
  const tag = parsePublishedGitHubTagReference(tagValue, version);
  const sourceSHA = tag.object_type === "commit"
    ? tag.object_sha
    : parsePublishedGitHubAnnotatedTag({
      value: await githubJSON(
        `${repositoryPath}/git/tags/${tag.object_sha}`,
        "published_annotated_tag_lookup_failed",
      ),
      version,
      tagObjectSHA: tag.object_sha,
    });
  if (sourceSHA !== input.config.sourceSHA) runFail("published_tag_source_mismatch");

  const publishedChecksums = await request(release.checksums_url, {
    redirect: "follow",
    headers: { accept: "application/octet-stream" },
  });
  if (publishedChecksums.status !== 200) runFail("published_checksums_download_failed");
  const publishedText = await boundedResponseText(
    publishedChecksums,
    "published_checksums_too_large",
  );
  if (publishedText !== input.checksumsText) {
    runFail("local_checksums_not_published_asset");
  }
}

function releaseAssetName(version: string): string {
  const expectedVersion = validateExpectedCLIVersion(version).slice(1);
  const operatingSystem = process.platform === "darwin"
    ? "darwin"
    : process.platform === "linux"
      ? "linux"
      : null;
  const architecture = process.arch === "arm64"
    ? "arm64"
    : process.arch === "x64"
      ? "amd64"
      : null;
  if (operatingSystem === null || architecture === null) {
    runFail("unsupported_acceptance_platform");
  }
  return expectedReleaseAssetName(`v${expectedVersion}`, operatingSystem, architecture);
}

async function regularFile(path: string, code: string): Promise<void> {
  const file = await lstat(path).catch(() => null);
  if (file === null || !file.isFile() || file.isSymbolicLink()) runFail(code);
}

async function prepareCLI(config: RunnerConfig): Promise<PreparedCLI> {
  if (
    config.cliArchivePath === null ||
    config.checksumsPath === null ||
    config.expectedCLIVersion === null
  ) runFail("lifecycle_inputs_required");
  await regularFile(config.cliArchivePath, "cli_archive_missing");
  await regularFile(config.checksumsPath, "checksum_manifest_missing");
  if (basename(config.checksumsPath) !== "checksums.txt") {
    runFail("checksum_manifest_name_mismatch");
  }
  const expectedName = releaseAssetName(config.expectedCLIVersion);
  if (basename(config.cliArchivePath) !== expectedName) {
    runFail("cli_archive_target_mismatch");
  }
  const manifestFile = await stat(config.checksumsPath);
  if (manifestFile.size > MAX_CAPTURE_BYTES) runFail("checksum_manifest_too_large");
  const manifest = await readFile(config.checksumsPath, "utf8");
  const expectedArchiveSHA = parseChecksumManifest(manifest, expectedName);
  const archiveSHA = validateSHA256(
    await binarySHA256(config.cliArchivePath),
    "cli_archive_hash_failed",
  );
  if (archiveSHA !== expectedArchiveSHA) runFail("cli_archive_checksum_mismatch");
  await verifyPublishedRelease({
    config,
    archiveName: expectedName,
    archiveSHA256: archiveSHA,
    checksumsText: manifest,
  });

  const temporaryRoot = await mkdtemp(join(tmpdir(), "hfg-release-acceptance-"));
  await chmod(temporaryRoot, 0o700);
  try {
    await extractTar({
      cwd: temporaryRoot,
      file: config.cliArchivePath,
      strict: true,
      preservePaths: false,
      filter: (entryPath) => entryPath === "handoffgraph",
    });
    const executablePath = resolve(temporaryRoot, "handoffgraph");
    await regularFile(executablePath, "cli_binary_missing_from_archive");
    const executableRealPath = await realpath(executablePath);
    if (relative(temporaryRoot, executableRealPath).startsWith("..")) {
      runFail("cli_archive_path_escape");
    }
    await access(executablePath, fsConstants.X_OK).catch(() => runFail("cli_binary_not_executable"));
    const result = await mustRunChild(executablePath, ["version"], {
      cwd: temporaryRoot,
      env: baseChildEnvironment(),
    }, "cli_version_failed");
    const expectedOutput = `handoffgraph ${config.expectedCLIVersion}`;
    if (result.stdout.trim() !== expectedOutput || result.stderr !== "") {
      runFail("cli_version_mismatch");
    }
    return {
      executablePath,
      temporaryRoot,
      evidence: {
        version: config.expectedCLIVersion,
        binary_sha256: validateSHA256(
          await binarySHA256(executablePath),
          "cli_binary_hash_failed",
        ),
        archive_name: expectedName,
        archive_sha256: archiveSHA,
      },
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function verifyPinnedFixture(): Promise<void> {
  await regularFile(PINNED_FIXTURE_PATH, "pinned_fixture_missing");
  if (await realpath(PINNED_FIXTURE_PATH) !== PINNED_FIXTURE_PATH) {
    runFail("pinned_fixture_path_mismatch");
  }
  if (await binarySHA256(PINNED_FIXTURE_PATH) !== ACCEPTANCE_FIXTURE_SHA256) {
    runFail("pinned_fixture_hash_mismatch");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoRepositoryConfig(start: string): Promise<void> {
  let current = resolve(start);
  for (;;) {
    if (await pathExists(join(current, ".handoffgraph.toml"))) {
      runFail("cli_repository_config_present");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertConfinedPath(dataDir: string, candidate: string): Promise<void> {
  const [root, target] = await Promise.all([realpath(dataDir), realpath(candidate)]);
  const location = relative(root, target);
  if (location === "" || location.startsWith("..") || isAbsolute(location)) {
    runFail("cli_store_path_escape");
  }
}

async function assertConfinedDirectory(dataDir: string, candidate: string): Promise<void> {
  const directory = await lstat(candidate).catch(() => null);
  if (directory === null || !directory.isDirectory() || directory.isSymbolicLink()) {
    runFail("cli_store_path_escape");
  }
  await assertConfinedPath(dataDir, candidate);
}

async function runCLIAccount(input: {
  lane: AccountLane;
  config: RunnerConfig;
  credential: DeviceCredential;
  executablePath: string;
}): Promise<CLIAccountResult> {
  const dataDir = await mkdtemp(join(tmpdir(), "hfg-hosted-acceptance-"));
  await chmod(dataDir, 0o700);
  const workingDir = join(dataDir, "cwd");
  await mkdir(workingDir, { mode: 0o700 });
  await assertNoRepositoryConfig(workingDir);
  if (await pathExists(join(dataDir, "config.toml"))) {
    runFail("cli_user_config_present");
  }
  const env = credentialEnvironment({
    ...baseChildEnvironment(),
    HFG_DATA_DIR: dataDir,
    HFG_HOSTED_API_URL: input.config.origin,
  }, input.credential.token);
  try {
    const title = `Hosted acceptance ${input.lane.toUpperCase()} ${input.config.sourceSHA.slice(0, 12)}`;
    const workstream = await mustRunChild(input.executablePath, ["workstream", "new", title], {
      cwd: workingDir,
      env,
    }, "cli_workstream_create_failed");
    const workstreamId = validateWorkstreamID(workstream.stdout.trim());
    await mustRunChild(input.executablePath, [
      "codex",
      "normalize",
      PINNED_FIXTURE_PATH,
      "--workstream",
      workstreamId,
      "--import",
    ], { cwd: workingDir, env }, "cli_fixture_import_failed");
    const databasePath = join(dataDir, "handoffgraph.db");
    await assertConfinedPath(dataDir, databasePath).catch(() => runFail("cli_store_path_escape"));
    for (const directory of ["objects", "logs", "cache"]) {
      await assertConfinedDirectory(dataDir, join(dataDir, directory));
    }

    const previewResult = await mustRunChild(
      input.executablePath,
      ["sync", "--preview", "--json"],
      { cwd: workingDir, env },
      "cli_preview_failed",
    );
    const preview = parseCLIReport(parseJSON(previewResult.stdout, "invalid_cli_preview_json"));
    if (await pathExists(join(dataDir, "hosted-sync-state.json"))) {
      runFail("cli_preview_wrote_state");
    }
    const firstResult = await mustRunChild(
      input.executablePath,
      ["sync", "--accept-redaction", "--json"],
      { cwd: workingDir, env },
      "cli_first_sync_failed",
    );
    const firstSync = parseCLIReport(parseJSON(firstResult.stdout, "invalid_cli_first_sync_json"));
    await assertConfinedPath(dataDir, join(dataDir, "hosted-sync-state.json"));
    const repeatResult = await mustRunChild(
      input.executablePath,
      ["sync", "--json"],
      { cwd: workingDir, env },
      "cli_repeat_sync_failed",
    );
    const repeatSync = parseCLIReport(parseJSON(repeatResult.stdout, "invalid_cli_repeat_sync_json"));
    assertCLISequence(preview, firstSync, repeatSync);
    return { workstreamId, preview, firstSync, repeatSync };
  } finally {
    // dataDir comes only from mkdtemp with the fixed acceptance prefix.
    if (!dataDir.startsWith(join(tmpdir(), "hfg-hosted-acceptance-"))) {
      runFail("unsafe_temporary_directory");
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function bearerWorkstreams(origin: string, credential: string): Promise<{
  status: number;
  body: unknown;
}> {
  const response = await request(new URL("/v1/workstreams?limit=100", origin), {
    redirect: "manual",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential}`,
    },
  });
  return {
    status: response.status,
    body: parseJSON(
      await boundedResponseText(response, "workstream_response_too_large"),
      "invalid_workstream_json",
    ),
  };
}

async function foreignWorkspaceStatus(input: {
  origin: string;
  credential: string;
  foreignWorkspaceId: string;
  lane: AccountLane;
  sourceSHA: string;
}): Promise<number> {
  const response = await request(new URL("/v1/event-batches", input.origin), {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.credential}`,
      "content-type": "application/json",
      "idempotency-key": `acceptance-${input.sourceSHA.slice(0, 12)}-${input.lane}-foreign`,
    },
    body: JSON.stringify({
      schema_version: "hfg.event-batch.v1",
      workspace_id: input.foreignWorkspaceId,
      events: [],
    }),
  });
  return response.status;
}

async function runLifecycle(config: RunnerConfig): Promise<LifecycleResult> {
  await verifyPinnedFixture();
  const preparedCLI = await prepareCLI(config);
  const providerBrowser = await launchAcceptanceBrowser(browserChildEnvironment()).catch(async (error) => {
    await rm(preparedCLI.temporaryRoot, { recursive: true, force: true });
    throw error;
  });
  let accountA: InteractiveAccount | null = null;
  let accountB: InteractiveAccount | null = null;
  let credentialA: DeviceCredential | null = null;
  let credentialB: DeviceCredential | null = null;
  try {
    if (config.authIntentA !== "signup" && config.authIntentB !== "signup") {
      runFail("signup_journey_required");
    }
    const announce = (lane: AccountLane, intent: AuthIntent) => {
      process.stdout.write(
        `Complete real AuthKit and Turnstile ${intent} for isolated account ${lane.toUpperCase()} in the opened browser.\n`,
      );
    };
    accountA = await authenticateInteractiveAccount({
      browser: providerBrowser,
      lane: "a",
      origin: config.origin,
      intent: config.authIntentA,
      timeoutMs: config.authTimeoutMs,
      announce,
    });
    accountB = await authenticateInteractiveAccount({
      browser: providerBrowser,
      lane: "b",
      origin: config.origin,
      intent: config.authIntentB,
      timeoutMs: config.authTimeoutMs,
      announce,
    });
    if (accountA.workspaceId === accountB.workspaceId) runFail("tenant_id_collision");

    const labelPrefix = `hfg-acceptance-${config.sourceSHA.slice(0, 12)}`;
    credentialA = await createPrimaryDevice({
      account: accountA,
      label: `${labelPrefix}-a`,
    });
    credentialB = await createPrimaryDevice({
      account: accountB,
      label: `${labelPrefix}-b`,
    });
    await exerciseDeviceQuota(accountA, `${labelPrefix}-a`);

    const [cliA, cliB] = await Promise.all([
      runCLIAccount({
        lane: "a",
        config,
        credential: credentialA,
        executablePath: preparedCLI.executablePath,
      }),
      runCLIAccount({
        lane: "b",
        config,
        credential: credentialB,
        executablePath: preparedCLI.executablePath,
      }),
    ]);
    const [workstreamsA, workstreamsB, aTargetingBStatus, bTargetingAStatus] =
      await Promise.all([
        bearerWorkstreams(config.origin, credentialA.token),
        bearerWorkstreams(config.origin, credentialB.token),
        foreignWorkspaceStatus({
          origin: config.origin,
          credential: credentialA.token,
          foreignWorkspaceId: accountB.workspaceId,
          lane: "a",
          sourceSHA: config.sourceSHA,
        }),
        foreignWorkspaceStatus({
          origin: config.origin,
          credential: credentialB.token,
          foreignWorkspaceId: accountA.workspaceId,
          lane: "b",
          sourceSHA: config.sourceSHA,
        }),
      ]);
    if (workstreamsA.status !== 200 || workstreamsB.status !== 200) {
      runFail("device_read_failed");
    }
    const pageA = parseWorkstreamPage(workstreamsA.body);
    const pageB = parseWorkstreamPage(workstreamsB.body);
    assertReciprocalTenantIsolation({
      workspaceA: accountA.workspaceId,
      workspaceB: accountB.workspaceId,
      workstreamA: cliA.workstreamId,
      workstreamB: cliB.workstreamId,
      pageA,
      pageB,
      aTargetingBStatus,
      bTargetingAStatus,
    });

    await signOutInteractiveAccount({
      account: accountB,
      origin: config.origin,
      timeoutMs: config.authTimeoutMs,
    });
    const deviceAfterSignout = await bearerWorkstreams(config.origin, credentialB.token);
    if (deviceAfterSignout.status !== 200 || await browserAccountStatus(accountB.page) !== 401) {
      runFail("browser_device_auth_separation_failed");
    }
    await reauthenticateInteractiveAccount({
      account: accountB,
      origin: config.origin,
      timeoutMs: config.authTimeoutMs,
      announce,
    });
    await revokePrimaryDevice({ account: accountB, deviceId: credentialB.id });
    if ((await bearerWorkstreams(config.origin, credentialB.token)).status !== 401) {
      runFail("revoked_device_credential_survived");
    }
    if (config.phase !== "deletion") {
      await revokePrimaryDevice({ account: accountA, deviceId: credentialA.id });
      if ((await bearerWorkstreams(config.origin, credentialA.token)).status !== 401) {
        runFail("revoked_device_credential_survived");
      }
    }

    const accounts: AccountEvidence[] = [
      {
        lane: "a",
        workspace_id: accountA.workspaceId,
        workstream_id: cliA.workstreamId,
        preview_events: cliA.preview.preview_events,
        accepted_events: cliA.firstSync.accepted_events,
        repeat_up_to_date: true,
        device_terminal_status: config.phase === "deletion" ? "deleted" : "revoked",
      },
      {
        lane: "b",
        workspace_id: accountB.workspaceId,
        workstream_id: cliB.workstreamId,
        preview_events: cliB.preview.preview_events,
        accepted_events: cliB.firstSync.accepted_events,
        repeat_up_to_date: true,
        device_terminal_status: "revoked",
      },
    ];
    return {
      checks: [
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
        {
          id: "device.primary_cleanup",
          outcome: "pass",
          count: config.phase === "deletion" ? 1 : 2,
        },
      ],
      accounts,
      accountA,
      credentialA,
      providerBrowser,
      cli: preparedCLI.evidence,
    };
  } catch (error) {
    let cleanupFailed = false;
    for (const account of [accountA, accountB]) {
      if (account === null) continue;
      try {
        if (await browserAccountStatus(account.page) !== 200) {
          cleanupFailed = true;
          continue;
        }
        await revokeAllActiveDevices(account);
      } catch {
        cleanupFailed = true;
      }
    }
    await accountA?.context.close().catch(() => undefined);
    await accountB?.context.close().catch(() => undefined);
    await providerBrowser.close().catch(() => undefined);
    if (cleanupFailed) runFail("active_device_cleanup_failed");
    throw error;
  } finally {
    await rm(preparedCLI.temporaryRoot, { recursive: true, force: true });
  }
}

function wranglerEnvironmentArgs(environment: AcceptanceEnvironment): string[] {
  const selected = ACCEPTANCE_RESOURCES[environment].wranglerEnvironment;
  return selected === null ? [] : ["--env", selected];
}

async function runWrangler(
  config: RunnerConfig,
  args: string[],
  input?: string,
): Promise<ChildResult> {
  const allArgs = [
    ...args,
    "--config",
    WRANGLER_CONFIG,
    ...wranglerEnvironmentArgs(config.environment),
  ];
  return runChild(WRANGLER, allArgs, {
    cwd: PLATFORM_DIR,
    env: {
      ...baseChildEnvironment(),
      CLOUDFLARE_ACCOUNT_ID: cloudflareAccountID(),
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    },
    input,
    timeoutMs: CHILD_TIMEOUT_MS,
  });
}

function d1Rows(stdout: string): Record<string, unknown>[] {
  const decoded = parseJSON(stdout, "invalid_d1_json");
  const envelopes = Array.isArray(decoded) ? decoded : [decoded];
  const rows: Record<string, unknown>[] = [];
  for (const envelope of envelopes) {
    if (typeof envelope !== "object" || envelope === null || !("results" in envelope)) {
      runFail("invalid_d1_json");
    }
    const results = (envelope as { results?: unknown }).results;
    if (!Array.isArray(results)) runFail("invalid_d1_json");
    for (const row of results) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        runFail("invalid_d1_json");
      }
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

async function queryD1(config: RunnerConfig, sql: string): Promise<Record<string, unknown>[]> {
  const result = await runWrangler(config, [
    "d1",
    "execute",
    ACCEPTANCE_RESOURCES[config.environment].d1,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  if (result.code !== 0) runFail("d1_query_failed");
  return d1Rows(result.stdout);
}

function sqlString(value: string): string {
  // Every caller validates IDs before this function. Doubling quotes remains
  // defense in depth and prevents an accidental future caller from widening a
  // read-only operator query.
  return `'${value.replaceAll("'", "''")}'`;
}

async function readDeletionIdentity(
  config: RunnerConfig,
  workspaceId: string,
): Promise<DeletionIdentity> {
  const workspace = validateWorkspaceID(workspaceId);
  const rows = await queryD1(config, `
    SELECT u.id AS user_id, pi.provider_subject AS provider_subject
    FROM users AS u
    JOIN provider_identities AS pi
      ON pi.user_id = u.id AND pi.provider = 'workos'
    WHERE u.personal_workspace_id = ${sqlString(workspace)}
    LIMIT 2`);
  if (rows.length !== 1 || typeof rows[0].user_id !== "string") {
    runFail("deletion_identity_not_singular");
  }
  return {
    userId: rows[0].user_id,
    providerSubject: validateWorkOSUserID(rows[0].provider_subject),
  };
}

function r2ObjectPath(config: RunnerConfig, key: string): string {
  return `${ACCEPTANCE_RESOURCES[config.environment].r2}/${key}`;
}

async function getR2Object(config: RunnerConfig, key: string): Promise<ChildResult> {
  return runWrangler(config, [
    "r2",
    "object",
    "get",
    r2ObjectPath(config, key),
    "--remote",
    "--pipe",
  ]);
}

function cloudflareAccountID(): string {
  const value = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (value === undefined || !/^[0-9a-f]{32}$/.test(value)) {
    runFail("cloudflare_account_id_required");
  }
  return value;
}

async function assertR2PrefixEmpty(
  config: RunnerConfig,
  prefix: string,
): Promise<void> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (apiToken === undefined || apiToken === "") runFail("cloudflare_api_token_required");
  const url = new URL(
    `/client/v4/accounts/${cloudflareAccountID()}/r2/buckets/${encodeURIComponent(ACCEPTANCE_RESOURCES[config.environment].r2)}/objects`,
    "https://api.cloudflare.com",
  );
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("per_page", "1");
  const response = await request(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiToken}`,
    },
  });
  if (response.status !== 200) runFail("r2_prefix_list_failed");
  const value = parseJSON(
    await boundedResponseText(response, "r2_prefix_list_response_too_large"),
    "invalid_r2_prefix_list_json",
  );
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("success" in value) || value.success !== true ||
    !("result" in value) || !Array.isArray(value.result) || value.result.length !== 0 ||
    !("result_info" in value) || typeof value.result_info !== "object" ||
    value.result_info === null || Array.isArray(value.result_info) ||
    ("is_truncated" in value.result_info && value.result_info.is_truncated !== false) ||
    ("cursor" in value.result_info && value.result_info.cursor !== "")
  ) runFail("r2_prefix_not_empty");
}

async function seedDeletionSentinels(
  config: RunnerConfig,
  workspaceId: string,
): Promise<string[]> {
  const keys = acceptanceSentinelKeys(workspaceId, config.sourceSHA);
  const created: string[] = [];
  try {
    for (const key of keys) {
      const existing = await getR2Object(config, key);
      try {
        assertR2ObjectMissing(existing);
      } catch (error) {
        if (error instanceof AcceptanceContractError && error.code === "r2_object_present") {
          runFail("r2_sentinel_already_exists");
        }
        throw error;
      }
      const put = await runWrangler(config, [
        "r2",
        "object",
        "put",
        r2ObjectPath(config, key),
        "--remote",
        "--pipe",
        "--content-type",
        "text/plain; charset=utf-8",
        "--force",
      ], SENTINEL_BODY);
      if (put.code !== 0) runFail("r2_sentinel_put_failed");
      created.push(key);
      const readBack = await getR2Object(config, key);
      if (readBack.code !== 0 || readBack.stdout !== SENTINEL_BODY) {
        runFail("r2_sentinel_readback_failed");
      }
    }
    return keys;
  } catch (error) {
    await cleanupUnacceptedSentinels(config, created);
    throw error;
  }
}

async function cleanupUnacceptedSentinels(config: RunnerConfig, keys: string[]): Promise<void> {
  for (const key of keys) {
    const deleted = await runWrangler(config, [
      "r2",
      "object",
      "delete",
      r2ObjectPath(config, key),
      "--remote",
      "--force",
    ]);
    if (deleted.code !== 0) runFail("r2_sentinel_cleanup_failed");
    assertR2ObjectMissing(await getR2Object(config, key));
  }
}

async function waitForDeletionTombstone(
  config: RunnerConfig,
  workspaceId: string,
): Promise<ReturnType<typeof parseDeletionTombstone>> {
  const workspace = validateWorkspaceID(workspaceId);
  const deadline = Date.now() + config.deletionTimeoutMs;
  while (Date.now() < deadline) {
    const rows = await queryD1(config, `
      SELECT status, requested_at, workos_deleted_at, completed_at, r2_sweeps
      FROM workspace_deletions
      WHERE workspace_id = ${sqlString(workspace)}`);
    if (rows.length === 1 && rows[0].status === "complete") {
      return parseDeletionTombstone(rows[0]);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30_000));
  }
  runFail("deletion_terminal_timeout");
}

async function queryPurgeCounts(input: {
  config: RunnerConfig;
  workspaceId: string;
  userId: string;
}): Promise<Record<string, unknown>[]> {
  const workspace = validateWorkspaceID(input.workspaceId);
  if (!/^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(input.userId)) {
    runFail("invalid_deletion_user_id");
  }
  const workspaceValue = sqlString(workspace);
  const userValue = sqlString(input.userId);
  const selects = acceptancePurgeTables.map((table) =>
    `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM "${table}" WHERE workspace_id = ${workspaceValue}`);
  selects.push(
    `SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users WHERE id = ${userValue} OR personal_workspace_id = ${workspaceValue}`,
    `SELECT 'workspaces' AS table_name, COUNT(*) AS row_count FROM workspaces WHERE id = ${workspaceValue} OR workspace_id = ${workspaceValue}`,
    `SELECT 'provider_identities' AS table_name, COUNT(*) AS row_count FROM provider_identities WHERE user_id = ${userValue}`,
    `SELECT 'workspace_deletion_kv_keys' AS table_name, COUNT(*) AS row_count FROM workspace_deletion_kv_keys WHERE workspace_id = ${workspaceValue}`,
  );
  return queryD1(input.config, selects.join(" UNION ALL "));
}

async function assertDatabaseForeignKeys(config: RunnerConfig): Promise<void> {
  const violations = await queryD1(config, "PRAGMA foreign_key_check");
  if (violations.length !== 0) runFail("database_foreign_key_violation");
}

async function proveR2Deletion(input: {
  config: RunnerConfig;
  workspaceId: string;
  sentinelKeys: string[];
  requestedAt: number;
}): Promise<number> {
  for (const key of input.sentinelKeys) {
    const first = await getR2Object(input.config, key);
    try {
      assertR2ObjectMissing(first);
    } catch (error) {
      if (error instanceof AcceptanceContractError && error.code === "r2_object_present") {
        runFail("r2_sentinel_survived_deletion");
      }
      throw error;
    }
    const second = await getR2Object(input.config, key);
    try {
      assertR2ObjectMissing(second);
    } catch (error) {
      if (error instanceof AcceptanceContractError && error.code === "r2_object_present") {
        runFail("r2_sentinel_survived_deletion");
      }
      throw error;
    }
  }
  const prefixes = acceptanceObjectPrefixes(input.workspaceId);
  for (const prefix of prefixes) {
    await assertR2PrefixEmpty(input.config, prefix);
  }
  const ledger = await getR2Object(
    input.config,
    acceptanceDeletionLedgerKey(input.workspaceId),
  );
  if (ledger.code !== 0) runFail("deletion_ledger_missing");
  const parsedLedger = parseDeletionLedger(
    parseJSON(ledger.stdout, "invalid_deletion_ledger_json"),
    input.workspaceId,
  );
  if (parsedLedger.requested_at !== input.requestedAt) {
    runFail("deletion_ledger_tombstone_mismatch");
  }
  return prefixes.length;
}

function workOSAPIKey(): string {
  const value = process.env.WORKOS_API_KEY;
  if (value === undefined || value === "") runFail("workos_api_key_required");
  return value;
}

async function requestWorkOSIdentity(
  providerSubject: string,
  apiKey: string,
): Promise<Response> {
  return request(
    `https://api.workos.com/user_management/users/${encodeURIComponent(providerSubject)}`,
    {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    },
  );
}

async function proveWorkOSIdentityReadable(
  providerSubject: string,
  apiKey: string,
): Promise<void> {
  const response = await requestWorkOSIdentity(providerSubject, apiKey);
  assertWorkOSIdentityReadable({
    status: response.status,
    body: parseJSON(
      await boundedResponseText(response, "workos_identity_response_too_large"),
      "invalid_workos_identity_response",
    ),
    providerSubject,
  });
}

async function proveWorkOSDeletion(
  providerSubject: string,
  apiKey: string,
): Promise<void> {
  const response = await requestWorkOSIdentity(providerSubject, apiKey);
  assertWorkOSIdentityDeleted(response.status);
}

async function promptForDeletion(workspaceId: string): Promise<string> {
  const phrase = deletionConfirmation(workspaceId);
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    assertDeletionConfirmation({
      workspaceId,
      typed: "",
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(
      `${DELETION_ONE_SHOT_NOTICE}\nType ${phrase} to run the live hosted deletion proof: `,
    );
  } finally {
    terminal.close();
  }
}

async function runDeletion(input: {
  config: RunnerConfig;
  lifecycle: LifecycleResult;
}): Promise<NonNullable<HostedAcceptanceEvidence["deletion"]>> {
  if (!process.env.CLOUDFLARE_API_TOKEN) runFail("cloudflare_api_token_required");
  if (!process.env.WORKOS_API_KEY) runFail("workos_api_key_required");
  const workspaceId = input.lifecycle.accountA.workspaceId;
  let sentinelKeys: string[] = [];
  let dispatchState: DeletionDispatchState = "not_dispatched";
  try {
    // Keep every fallible operator-side lookup inside the cleanup boundary.
    // The lifecycle deliberately leaves account A's primary device active for
    // the deletion proof, so an early D1/API failure must still revoke it.
    const identity = await readDeletionIdentity(input.config, workspaceId);
    const workOSKey = workOSAPIKey();
    // Bind this exact key to the exact target identity before the irreversible
    // TTY boundary; a key for another WorkOS environment commonly returns 404.
    await proveWorkOSIdentityReadable(identity.providerSubject, workOSKey);
    const typed = await promptForDeletion(workspaceId);
    assertDeletionConfirmation({
      workspaceId,
      typed,
      stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
    });
    const lifetimeDeviceIssuanceLimit = await exerciseLifetimeDeviceIssuanceQuota(
      input.lifecycle.accountA,
      `hfg-acceptance-${input.config.sourceSHA.slice(0, 12)}-a`,
    );
    sentinelKeys = await seedDeletionSentinels(input.config, workspaceId);
    await deleteInteractiveAccount({
      account: input.lifecycle.accountA,
      confirmation: deletionConfirmation(workspaceId),
      origin: input.config.origin,
      timeoutMs: input.config.authTimeoutMs,
      onDispatched: () => {
        dispatchState = "uncertain";
      },
      onRejected: () => {
        dispatchState = "rejected";
      },
      onAccepted: () => {
        dispatchState = "accepted";
      },
    });
    const denied = await bearerWorkstreams(
      input.config.origin,
      input.lifecycle.credentialA.token,
    );
    if (denied.status !== 401) runFail("device_credential_survived_deletion");

    const tombstone = await waitForDeletionTombstone(input.config, workspaceId);
    const purgeRows = await queryPurgeCounts({
      config: input.config,
      workspaceId,
      userId: identity.userId,
    });
    const purgedTableCount = assertPurgeCounts(purgeRows);
    await assertDatabaseForeignKeys(input.config);
    const emptyPrefixCount = await proveR2Deletion({
      config: input.config,
      workspaceId,
      sentinelKeys,
      requestedAt: tombstone.requested_at,
    });
    await proveWorkOSDeletion(identity.providerSubject, workOSKey);
    return {
      workspace_id: workspaceId,
      status: "complete",
      workos_absent: true,
      r2_sweeps: tombstone.r2_sweeps,
      purged_table_count: purgedTableCount,
      absent_sentinel_count: sentinelKeys.length,
      empty_prefix_count: emptyPrefixCount,
      foreign_key_violations: 0,
      lifetime_device_issuance_limit: lifetimeDeviceIssuanceLimit,
      permanent_ledger_present: true,
    };
  } finally {
    // Clean only before dispatch or after an observed non-202 response. A
    // request with no observed response may already belong to the saga.
    if (mayCleanupDeletionSentinels(dispatchState)) {
      try {
        if (sentinelKeys.length > 0) {
          await cleanupUnacceptedSentinels(input.config, sentinelKeys);
        }
      } finally {
        const revoked = await revokeAllActiveDevices(input.lifecycle.accountA);
        if (revoked < 1) runFail("active_device_cleanup_failed");
      }
    }
  }
}

async function writeEvidence(path: string, evidence: HostedAcceptanceEvidence): Promise<void> {
  const serialized = serializeSanitizedEvidence(evidence);
  const existingRoot = await lstat(EVIDENCE_ROOT).catch(() => null);
  if (
    existingRoot !== null &&
    (!existingRoot.isDirectory() || existingRoot.isSymbolicLink())
  ) runFail("unsafe_evidence_root");
  await mkdir(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  await chmod(EVIDENCE_ROOT, 0o700);
  if (await pathExists(path)) runFail("evidence_already_exists");
  const temporary = `${path}.tmp-${process.pid}`;
  if (await pathExists(temporary)) runFail("evidence_temporary_exists");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    try {
      await link(temporary, path);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        runFail("evidence_already_exists");
      }
      throw error;
    }
    await rm(temporary, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(usage());
    return;
  }
  const config = parsed;
  if (config.phase === "deletion") {
    if (!process.env.CLOUDFLARE_API_TOKEN) runFail("cloudflare_api_token_required");
    cloudflareAccountID();
    workOSAPIKey();
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      runFail("deletion_requires_tty");
    }
  }
  const preflight = await runPreflight(config);
  const checks = [...preflight.checks];
  let accounts: AccountEvidence[] | undefined;
  let cli: HostedAcceptanceEvidence["cli"];
  let deletion: HostedAcceptanceEvidence["deletion"];
  let lifecycle: LifecycleResult | null = null;
  try {
    if (config.phase !== "preflight") {
      lifecycle = await runLifecycle(config);
      checks.push(...lifecycle.checks);
      accounts = lifecycle.accounts;
      cli = lifecycle.cli;
      if (config.phase === "deletion") {
        const deletionProof = await runDeletion({ config, lifecycle });
        deletion = deletionProof;
        checks.push(
          { id: "deletion.immediate_auth_denial", outcome: "pass", status: 401 },
          { id: "deletion.workos_absent", outcome: "pass", status: 404 },
          { id: "deletion.d1_purge_complete", outcome: "pass", count: deletionProof.purged_table_count },
          { id: "deletion.r2_sentinels_absent", outcome: "pass", count: deletionProof.absent_sentinel_count },
          { id: "deletion.r2_prefixes_empty", outcome: "pass", count: deletionProof.empty_prefix_count },
          { id: "deletion.foreign_keys_clean", outcome: "pass", count: deletionProof.foreign_key_violations },
          { id: "device.lifetime_quota", outcome: "pass", count: deletionProof.lifetime_device_issuance_limit },
          { id: "deletion.permanent_ledger_present", outcome: "pass", count: 1 },
        );
      }
    }
    const evidence: HostedAcceptanceEvidence = {
      schema_version: ACCEPTANCE_SCHEMA,
      recorded_at: new Date().toISOString(),
      phase: config.phase,
      outcome: "pass",
      target: {
        environment: config.environment,
        origin: config.origin,
        source_sha: config.sourceSHA,
        worker_version_id: preflight.identity.worker_version_id,
        worker_version_tag: preflight.identity.worker_version_tag,
      },
      ...(cli === undefined ? {} : { cli }),
      ...(accounts === undefined ? {} : { accounts }),
      checks,
      ...(deletion === undefined ? {} : { deletion }),
    };
    await writeEvidence(config.evidencePath, evidence);
    process.stdout.write(`Hosted acceptance passed. Sanitized evidence: ${relative(REPOSITORY_DIR, config.evidencePath)}\n`);
  } finally {
    await lifecycle?.providerBrowser.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof AcceptanceContractError ? error.code : "internal_error";
  process.stderr.write(`Hosted acceptance failed: ${code}\n`);
  process.exitCode = 1;
});
