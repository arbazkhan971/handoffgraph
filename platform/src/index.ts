// HandoffGraph platform API Worker foundation.
//
// Endpoints:
//   GET  /healthz           liveness (no auth)
//   POST /v1/event-batches  authenticated, idempotent event ingestion
//   GET  /v1/workstreams    cursor-paginated, workspace-scoped listing
//   (see observations.ts for /v1/sessions, /v1/observations, /v1/fingerprints
//    and POST /v1/admin/reindex; alerts.ts for /v1/alerts)
//   (see dashboards.ts for /v1/dashboards and the one unauthenticated route
//    on this Worker, GET /v1/shared/dashboards/{token}, which serves a
//    dashboard config document and no workspace data — docs/dashboards.md)
//    and POST /v1/admin/reindex; apikeys.ts for /v1/api-keys*, the public
//    read API under /api/v1/*, and /api/v1/openapi.json; mcp.ts for the
//    hosted MCP endpoint at POST /v1/mcp; evals.ts for /v1/evals*)
//    hosted MCP endpoint at POST /v1/mcp; playground.ts for
//    /v1/playground/*, POST /v1/prompts/{name}/labels and
//    POST /v1/prompt-optimizer/suggest)
//    hosted MCP endpoint at POST /v1/mcp; attachments.ts for
//    POST/GET /v1/attachments and GET /v1/attachments/{sha256})
//
// Invariants (see docs/architecture.md and platform/README.md):
//   - workspace identity comes only from the device token binding;
//   - events are append-only (INSERT OR IGNORE, keyed on event_id);
//   - receipts are deterministic, so replays return the original bytes;
//   - foreign resources 404, own-but-forbidden 403.

import {
  authenticate,
  deviceLookup,
  hasCapability,
  sha256Hex,
} from "./auth";
import {
  accountDeletionEnv,
  accountDeletionScheduled,
  authenticateAccountSession,
  handleAccountRoute,
  type AccountEnv,
  type SessionAccount,
} from "./account";
import {
  deletionLedgerBinding,
  deletionLedgerRequired,
} from "./deletion_ledger";
import {
  accountPageCSP,
  renderAccountPage,
  renderSignedOutPage,
  type AccountPageData,
} from "./account_page";
import { alertsScheduled, handleAlertsRoute } from "./alerts";
import {
  handleAnalyticsRoute,
  recordIngestDataPoints,
  type AnalyticsEngineDatasetLike,
} from "./analytics";
import { handleAnnotationsRoute } from "./annotations";
// The Durable Object class for annotation queues' live-state half (parity row
// 28) must be exported from the Worker's main module for the (currently
// commented) [[durable_objects.bindings]] binding in wrangler.toml to
// resolve it. Re-exported here rather than defined here so annotations.ts
// stays the single home of the room's logic — same convention as
// SimulationWorkflow below.
export { AnnotationQueueRoom } from "./annotations";
import { artifactsScheduled, handleArtifactsRoute, type ArtifactsEnv } from "./artifacts";
import { handleAttachmentsRoute } from "./attachments";
import { handleDashboardsRoute } from "./dashboards";
import { handleApiKeysRoute } from "./apikeys";
import { evalsScheduled, handleEvalsRoute } from "./evals";
// The Workflows entrypoint for hosted evals must be exported from the Worker's
// main module for the (currently commented) [[workflows]] binding in
// wrangler.toml to resolve it. Re-exported here rather than defined here so
// evals.ts stays the single home of the evaluation loop.
export { EvalWorkflow } from "./evals";
// The ONE seam between the OSS Worker and the Enterprise tier (parity rows 48,
// 51). Everything EE lives under platform/ee/ with its own license; this
// import and the single delegation pair below are the whole coupling. Every
// EE route is disabled unless env.EE_ENABLED === "true", and disabled means
// handleEERoute returns null — so with the flag absent (the default) those
// paths fall through to the same 404 as any unknown URL and OSS behavior is
// byte-identical. See platform/ee/src/ee.ts and docs/ee.md.
import { handleEERoute } from "../ee/src/ee";
import type {
  D1BoundStatement,
  D1DatabaseLike,
  D1Statement,
} from "./db";
export type { D1BoundStatement, D1DatabaseLike, D1Statement } from "./db";
import { handleGatewayRoute } from "./gateway";
import { convertOtlpExport, type CaptureTier } from "./otlp";
import {
  OtlpProtoError,
  decodeExportRequest,
  isProtobufMediaType,
  protobufExportResponse,
  readProtobufBody,
} from "./otlp_proto";
import {
  BATCH_SCHEMA_VERSION,
  MAX_BODY_BYTES,
  buildReceipt,
  buildWorkstreamListResponse,
  buildWorkstreamProjectionRows,
  canonicalJsonStringify,
  parsePagination,
  readRequestBody,
  scopeDenial,
  validateEventBatch,
  type WorkstreamRow,
} from "./ingest";
import { handleMcpRoute } from "./mcp";
import { buildObservationStatements, handleObservationsRoute } from "./observations";
import { PLAN_CATALOG } from "./plans";
import { handlePlaygroundRoute } from "./playground";
import { handleQualityRoute } from "./quality";
import {
  MAX_QUOTA_RETRY_AFTER_SECONDS,
  prepareQuotaReservation,
  type QuotaDenial,
} from "./quota";
import { handleSimulationsRoute } from "./simulations";
// The Workflows entrypoint for agent simulations must be exported from the
// Worker's main module for the (currently commented) [[workflows]] binding in
// wrangler.toml to resolve it. Re-exported here rather than defined here so
// simulations.ts stays the single home of the loop.
export { SimulationWorkflow } from "./simulations";
import { handleTeamsRoute } from "./teams";
import { handleWebhooksRoute, webhooksQueue, webhooksScheduled } from "./webhooks";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER_VERSION_TAG_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const WORKER_VERSION_HEADER = "x-handoffgraph-worker-version";
const WORKER_VERSION_TAG_HEADER = "x-handoffgraph-worker-tag";
const MAINTENANCE_HEADER = "x-handoffgraph-maintenance";
const MAINTENANCE_RETRY_AFTER_SECONDS = "60";

interface HostedSurfaceEnv {
  /**
   * Deployment fence for the private Hosted Basic beta. The repository also
   * contains ahead-of-gate parity modules, but they are not part of the Basic
   * contract and must not become reachable merely because they share this
   * Worker bundle.
   */
  HOSTED_SURFACE?: string;
  /**
   * Emergency quiescence fence for cutover and D1 restore operations. Missing
   * or the exact value "false" serves normally. Any other configured value
   * fails closed into maintenance so a typo cannot expose a database that an
   * operator intended to take offline.
   */
  HOSTED_MAINTENANCE?: string;
  /** Runtime-assigned by Cloudflare's version metadata binding. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

function advancedHostedSurfaceEnabled(env: HostedSurfaceEnv): boolean {
  // Configuration drift must reduce privilege. Only the explicit advanced
  // value enables ahead-of-gate routes and scheduled work; missing, misspelled,
  // or otherwise unexpected values stay on the Hosted Basic surface.
  return env.HOSTED_SURFACE === "advanced";
}

function hostedMaintenanceEnabled(env: HostedSurfaceEnv): boolean {
  return env.HOSTED_MAINTENANCE !== undefined && env.HOSTED_MAINTENANCE !== "false";
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Render a quota denial without making every 429 look retryable.
 *
 * Monthly limits carry an authoritative reset timestamp and are the only
 * unchanged requests that can succeed merely by waiting. Batch and lifetime
 * limits deliberately omit Retry-After: one needs a smaller request and the
 * other needs an entitlement change. RFC 9110 permits either a date or delay
 * seconds. An absolute date binds the HTTP policy to the structured reset
 * without depending on response-generation or transport timing.
 */
function quotaResponse(denial: QuotaDenial, nowSeconds: number): Response {
  const headers = new Headers(JSON_HEADERS);
  const detail = denial.body.detail;
  if (denial.status === 429 && detail?.retryable === true) {
    const validInputs = Number.isSafeInteger(detail.resets_at) &&
      Number.isSafeInteger(nowSeconds) && nowSeconds >= 0;
    const delaySeconds = validInputs
      ? (detail.resets_at as number) - nowSeconds
      : Number.NaN;
    // Never turn malformed entitlement state into unbounded or immediate
    // operator retry policy. The reservation has not committed at this point,
    // so a fixed 503 is the fail-closed response.
    if (
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds <= 0 ||
      delaySeconds > MAX_QUOTA_RETRY_AFTER_SECONDS
    ) {
      return jsonResponse(503, {
        error: "hosted quota is not configured safely",
        code: "quota_configuration_error",
        local_capture_unaffected: true,
        detail: { retryable: false },
      });
    }
    headers.set("retry-after", new Date((detail.resets_at as number) * 1000).toUTCString());
  }
  return new Response(JSON.stringify(denial.body), {
    status: denial.status,
    headers,
  });
}

function healthResponse(env: HostedSurfaceEnv): Response {
  const headers = new Headers(JSON_HEADERS);
  if (hostedMaintenanceEnabled(env)) {
    headers.set(MAINTENANCE_HEADER, "true");
  }
  const metadata = env.CF_VERSION_METADATA;
  // Treat metadata as an external runtime boundary: a malformed ID suppresses
  // the whole identity, and a malformed tag suppresses only the optional tag.
  // This keeps untrusted bytes out of response headers without changing the
  // stable liveness JSON contract.
  if (metadata !== undefined && WORKER_VERSION_ID_PATTERN.test(metadata.id)) {
    headers.set(WORKER_VERSION_HEADER, metadata.id);
    if (WORKER_VERSION_TAG_PATTERN.test(metadata.tag)) {
      headers.set(WORKER_VERSION_TAG_HEADER, metadata.tag);
    }
  }
  return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers });
}

function maintenanceResponse(): Response {
  const headers = new Headers(JSON_HEADERS);
  headers.set(MAINTENANCE_HEADER, "true");
  headers.set("retry-after", MAINTENANCE_RETRY_AFTER_SECONDS);
  return new Response(JSON.stringify({
    error: "service unavailable",
    code: "hosted_maintenance",
  }), { status: 503, headers });
}

function canonicalResponse(status: number, canonicalJson: string): Response {
  return new Response(canonicalJson, { status, headers: JSON_HEADERS });
}

function landingDestination(request: Request, configured: string | undefined): string {
  if (configured === undefined || configured.trim() === "") return "/account";
  try {
    const current = new URL(request.url);
    const destination = new URL(configured, current);
    // Fragments are not sent in HTTP requests, so they cannot make an
    // otherwise identical destination escape a server-side redirect loop.
    if (
      destination.origin === current.origin &&
      destination.pathname === current.pathname &&
      destination.search === current.search
    ) {
      return "/account";
    }
    return destination.toString();
  } catch {
    return "/account";
  }
}

// -- routing ----------------------------------------------------------------

export default {
  async fetch<E extends AccountEnv & HostedSurfaceEnv>(
    request: Request,
    env: E,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "GET" && pathname === "/healthz") {
        return healthResponse(env);
      }
      // The restore/cutover fence runs before every public, account, device,
      // or advanced route and before any D1/R2/WorkOS access. Liveness remains
      // available above so an operator can prove the exact maintenance Worker
      // version before touching durable state.
      if (hostedMaintenanceEnabled(env)) {
        return maintenanceResponse();
      }
      if (request.method === "GET" && pathname === "/") {
        const destination = landingDestination(request, env.LANDING_ORIGIN);
        return new Response(null, {
          status: 303,
          headers: { location: destination, "cache-control": "no-store" },
        });
      }
      if (request.method === "GET" && pathname === "/account") {
        return await handleAccountPage(request, env);
      }
      if (request.method === "GET" && pathname === "/v1/plans") {
        return jsonResponse(200, { plans: Object.values(PLAN_CATALOG) });
      }
      const accountResponse = await handleAccountRoute(request, env);
      if (accountResponse !== null) return accountResponse;
      if (advancedHostedSurfaceEnabled(env)) {
        const teamsResponse = await handleTeamsRoute(request, env);
        if (teamsResponse !== null) return teamsResponse;
        const artifactsResponse = await handleArtifactsRoute(request, env);
        if (artifactsResponse !== null) return artifactsResponse;
        const attachmentsResponse = await handleAttachmentsRoute(request, env);
        if (attachmentsResponse !== null) return attachmentsResponse;
        const webhooksResponse = await handleWebhooksRoute(request, env);
        if (webhooksResponse !== null) return webhooksResponse;
        const dashboardsResponse = await handleDashboardsRoute(request, env);
        if (dashboardsResponse !== null) return dashboardsResponse;
        const alertsResponse = await handleAlertsRoute(request, env);
        if (alertsResponse !== null) return alertsResponse;
        const gatewayResponse = await handleGatewayRoute(request, env);
        if (gatewayResponse !== null) return gatewayResponse;
        const apiKeysResponse = await handleApiKeysRoute(request, env);
        if (apiKeysResponse !== null) return apiKeysResponse;
        const mcpResponse = await handleMcpRoute(request, env);
        if (mcpResponse !== null) return mcpResponse;
        const observationsResponse = await handleObservationsRoute(request, env);
        if (observationsResponse !== null) return observationsResponse;
        const analyticsResponse = await handleAnalyticsRoute(request, env);
        if (analyticsResponse !== null) return analyticsResponse;
        const qualityResponse = await handleQualityRoute(request, env);
        if (qualityResponse !== null) return qualityResponse;
        const simulationsResponse = await handleSimulationsRoute(request, env);
        if (simulationsResponse !== null) return simulationsResponse;
        const evalsResponse = await handleEvalsRoute(request, env);
        if (evalsResponse !== null) return evalsResponse;
        const annotationsResponse = await handleAnnotationsRoute(request, env);
        if (annotationsResponse !== null) return annotationsResponse;
        // After quality.ts: that module owns GET /v1/prompts* and returns null
        // for POST, which is how POST /v1/prompts/{name}/labels reaches here.
        const playgroundResponse = await handlePlaygroundRoute(request, env);
        if (playgroundResponse !== null) return playgroundResponse;
        const eeResponse = await handleEERoute(request, env);
        if (eeResponse !== null) return eeResponse;
        if (request.method === "POST" && pathname === "/v1/otlp") {
          return await handleOtlpExport(request, env);
        }
      }
      if (request.method === "POST" && pathname === "/v1/event-batches") {
        return await handleEventBatches(request, env);
      }
      if (request.method === "GET" && pathname === "/v1/workstreams") {
        return await handleListWorkstreams(request, env);
      }
      return jsonResponse(404, { error: "not found" });
    } catch (error) {
      // Content-free structured logging: never log headers, tokens, bodies,
      // query strings, SQL binds, or captured event fields.
      console.error(JSON.stringify({
        message: "request failed",
        method: request.method,
        path: pathname,
        error_type: error instanceof Error ? error.name : "unknown",
      }));
      // Never leak internals.
      return jsonResponse(500, { error: "internal error" });
    }
  },

  // Cron dispatcher (see wrangler.toml [triggers]). Privacy deletion is the
  // only Hosted Basic sweep. Every object-producing or advanced derived-model
  // sweep stays behind the exact advanced-surface fence: deletion must never
  // race a Basic compactor that can publish tenant bytes after its final R2
  // proof. In the advanced surface, compaction copies the spine into object
  // storage, retention slims rebuildable read models, the webhook
  // sweep fans out deliveries, the alerts sweep evaluates threshold rules and
  // APPENDS alert.fired events, and the evals sweep starts due cron eval
  // configs and APPENDS score.recorded events (the two sweeps that write to the
  // spine, and both do so by INSERT alone). Each sweep runs in its own
  // try/catch with content-free logging — hosted maintenance must never affect
  // ingest or local capture, and one failing sweep must never starve the
  // others.
  async scheduled<E extends ArtifactsEnv & HostedSurfaceEnv>(
    controller: ScheduledController,
    env: E,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // A quiesced D1 must not be mutated by the deletion saga or any advanced
    // sweep while Time Travel/reconciliation is in progress.
    if (hostedMaintenanceEnabled(env)) return;
    try {
      await accountDeletionScheduled(accountDeletionEnv(env));
    } catch (error) {
      console.error(JSON.stringify({
        message: "scheduled dispatch failed",
        sweep: "account-deletions",
        cron: controller.cron,
        error_type: error instanceof Error ? error.name : "unknown",
      }));
    }
    if (!advancedHostedSurfaceEnabled(env)) return;
    try {
      await artifactsScheduled(env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "scheduled dispatch failed",
        sweep: "artifacts",
        cron: controller.cron,
        error_type: error instanceof Error ? error.name : "unknown",
      }));
    }
    try {
      await webhooksScheduled(env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "scheduled dispatch failed",
        sweep: "webhooks",
        cron: controller.cron,
        error_type: error instanceof Error ? error.name : "unknown",
      }));
    }
    try {
      await alertsScheduled(env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "scheduled dispatch failed",
        sweep: "alerts",
        cron: controller.cron,
        error_type: error instanceof Error ? error.name : "unknown",
      }));
    }
    try {
      await evalsScheduled(env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "scheduled dispatch failed",
        sweep: "evals",
        cron: controller.cron,
        error_type: error instanceof Error ? error.name : "unknown",
      }));
    }
  },

  // Queues consumer dispatch by queue name. Failures are logged content-free
  // and rethrown (never swallowed) so Cloudflare Queues applies its own
  // retry/dead-letter policy for the failing message.
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Preserve queued work for a later healthy deployment without touching
    // tenant storage during a maintenance window.
    if (hostedMaintenanceEnabled(env)) {
      batch.retryAll();
      return;
    }
    // No queue is part of Hosted Basic. Keep the code-level boundary
    // fail-closed too, so a future accidental binding cannot bypass the
    // checked-in deployment fence.
    if (!advancedHostedSurfaceEnabled(env)) return;
    try {
      if (batch.queue === "handoffgraph-webhooks") {
        await webhooksQueue(batch, env);
        return;
      }
      console.error(JSON.stringify({ message: "unrecognized queue", queue: batch.queue }));
    } catch (error) {
      console.error(JSON.stringify({
        message: "queue consumer failed",
        queue: batch.queue,
        error_type: error instanceof Error ? error.name : "unknown",
      }));
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

function accountPageData(session: SessionAccount, hostedBasic = false): AccountPageData {
  return {
    hostedBasic,
    displayName: session.displayName ?? "Your account",
    email: session.email,
    workspaceName: session.workspaceName,
    workspaceId: session.workspaceId,
    planName: session.planId === "basic" ? "Hosted Basic" : session.planId,
    planStatus: session.planStatus,
    planPeriod: `Resets ${new Date(session.periodEnd * 1_000).toISOString().slice(0, 10)}`,
    // Only the caller's own membership is known without another query; the
    // page fetches the rest of the roster over the team API on load.
    members: [
      {
        userId: session.userId,
        email: session.email,
        displayName: session.displayName ?? undefined,
        role: session.role,
      },
    ],
    usage: [
      {
        label: "Monthly events",
        used: session.usedMonthlyEvents,
        limit: session.maxMonthlyEvents,
        unit: "events",
      },
      {
        label: "Lifetime events",
        used: session.usedLifetimeEvents,
        limit: session.maxLifetimeEvents,
        unit: "events",
      },
      {
        label: "Lifetime upload",
        used: Math.ceil(session.usedLifetimeBytes / 1_048_576),
        limit: Math.ceil(session.maxLifetimeBytes / 1_048_576),
        unit: "MiB",
      },
      {
        label: "Active devices",
        used: session.activeDevices,
        limit: session.maxDevices,
        unit: "devices",
      },
      {
        label: "Device-token issuances",
        used: session.usedDeviceIssuances,
        limit: session.maxDeviceIssuances,
        unit: "issued",
      },
    ],
  };
}

async function handleAccountPage(
  request: Request,
  env: AccountEnv & HostedSurfaceEnv,
): Promise<Response> {
  const session = await authenticateAccountSession(request, env);
  const signedIn = session !== null;
  const deletionRequested = new URL(request.url).searchParams.get("deletion") === "requested";
  const authAvailable = [env.WORKOS_CLIENT_ID, env.WORKOS_API_KEY, env.WORKOS_REDIRECT_URI]
    .every((value) => typeof value === "string" && value.length > 0);
  const html = signedIn
    ? renderAccountPage(accountPageData(session, !advancedHostedSurfaceEnabled(env)))
    : renderSignedOutPage({
        ...(deletionRequested ? {
          message: "Hosted account deletion was accepted. Credentials are revoked and the private workspace purge is being finalized.",
        } : {}),
        authAvailable,
        signupAvailable: authAvailable && env.HOSTED_SIGNUP_ENABLED === "true",
      });
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `${accountPageCSP(signedIn)}; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

// -- POST /v1/otlp -------------------------------------------------------------

/**
 * OTLP trace ingest (parity row 2, hosted), both wire flavors:
 * application/json and application/x-protobuf. Converts an
 * ExportTraceServiceRequest into canonical events with the same
 * deterministic ids as the local CLI (golden-tested parity), then replays
 * the exact tested event-batch pipeline (auth, quota, idempotency,
 * projections) via a synthetic request. The hosted capture tier defaults to
 * metadata (prompt/completion bodies never leave the emitter unasked);
 * opt up with X-HFG-Capture: full.
 */
async function handleOtlpExport(request: Request, env: { DB: D1DatabaseLike }): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "OTLP export requires POST" });
  }
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.error });

  const capabilityDenial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, "ingest"),
  });
  if (capabilityDenial !== null) {
    return jsonResponse(capabilityDenial.status, { error: capabilityDenial.error });
  }

  const tierRaw = (request.headers.get("x-hfg-capture") ?? "metadata").trim().toLowerCase();
  if (tierRaw !== "full" && tierRaw !== "minimal" && tierRaw !== "metadata") {
    return jsonResponse(400, { error: "X-HFG-Capture must be full, metadata, or minimal" });
  }
  const captureTier: CaptureTier = tierRaw;

  // Wire-flavor switch. OTLP/HTTP defines both an application/json and an
  // application/x-protobuf ExportTraceServiceRequest; both decode into the
  // same body shape and reach the one deterministic converter below, so the
  // same telemetry yields byte-identical event ids either way. Anything that
  // is not a protobuf media type stays on the JSON path unchanged.
  const wantsProtobuf = isProtobufMediaType(request.headers.get("content-type") ?? "");
  let parsed: unknown;
  if (wantsProtobuf) {
    const bodyRead = await readProtobufBody(request, MAX_BODY_BYTES);
    if (!bodyRead.ok) {
      const error = bodyRead.status === 413
        ? "request body exceeds 1 MiB"
        : "request body is not readable";
      return jsonResponse(bodyRead.status, { error });
    }
    try {
      parsed = decodeExportRequest(bodyRead.bytes);
    } catch (error) {
      return jsonResponse(400, {
        error: error instanceof OtlpProtoError
          ? error.message
          : "request body is not valid OTLP/protobuf",
      });
    }
  } else {
    const bodyRead = await readRequestBody(request, MAX_BODY_BYTES);
    if (!bodyRead.ok) {
      const error = bodyRead.status === 413
        ? "request body exceeds 1 MiB"
        : "request body is not readable UTF-8";
      return jsonResponse(bodyRead.status, { error });
    }
    try {
      parsed = JSON.parse(bodyRead.text);
    } catch {
      return jsonResponse(400, { error: "request body is not valid JSON" });
    }
  }

  // Replay idempotency: observed_at is derived PER EVENT from that event's own
  // boundary instant — which is exactly its occurred_at (span end for
  // span.completed/span.failed, span start for span.started, the trace and
  // session bounds for the aggregate events). Never wall-clock receipt time,
  // and never a whole-export aggregate either: observed_at rides inside
  // raw_json, which migration 0003's events_reject_payload_conflict trigger
  // compares, so an export-wide value made one span's events change shape with
  // the COMPOSITION of the batch they arrived in. Re-sending a span alongside
  // different siblings then aborted the whole batch with a payload conflict
  // instead of deduping under INSERT OR IGNORE. Per event, the same span is
  // byte-identical in every batch that carries it.
  const converted = await convertOtlpExport(parsed, {
    workstreamID: undefined,
    captureTier,
  });
  for (const event of converted.events) {
    event["observed_at"] = event["occurred_at"];
  }
  if (converted.events.length === 0) {
    return jsonResponse(400, {
      error: "no convertible spans",
      rejected_spans: converted.rejectedSpans.length,
    });
  }

  // The converter is idempotent by construction; drop intra-batch duplicates
  // (identical spans re-sent in one export) so batch validation never trips.
  const seen = new Set<string>();
  const events = converted.events.filter((e) => {
    const id = e["event_id"] as string;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Deterministic derived idempotency key: replays of the same telemetry
  // under the same tier map to one key, so receipts are stable and quota is
  // charged once.
  const requestHash = await sha256Hex(
    `${captureTier}\n${canonicalJsonStringify(events)}`,
  );
  const synthetic = new Request(request.url, {
    method: "POST",
    headers: {
      authorization: request.headers.get("authorization") ?? "",
      "content-type": "application/json",
      "idempotency-key": `otlp-${requestHash.slice(0, 56)}`,
    },
    body: JSON.stringify({
      schema_version: BATCH_SCHEMA_VERSION,
      workspace_id: auth.device.workspaceId,
      events,
    }),
  });
  // This is a server-generated advanced-only conversion path, not the Hosted
  // Basic client-sync boundary. The external /v1/event-batches route keeps the
  // default strict requirement for an explicit successful-redaction record.
  const response = await handleEventBatches(synthetic, env, {
    requireRedactionAttestation: false,
  });
  if (response.status !== 200) return response;
  if (wantsProtobuf) {
    // The response flavor mirrors the request flavor, as OTLP/HTTP requires:
    // a protobuf export is answered with a protobuf
    // ExportTraceServiceResponse (the empty message = every span accepted).
    return protobufExportResponse(converted.rejectedSpans);
  }
  // Attach converter diagnostics without disturbing the receipt body.
  const receipt = await response.json<Record<string, unknown>>();
  receipt["otlp"] = {
    rejected_spans: converted.rejectedSpans.length,
    dropped_attribute_keys: converted.droppedAttributeKeys,
    capture_tier: captureTier,
  };
  return jsonResponse(200, receipt);
}

// -- POST /v1/event-batches ---------------------------------------------------

const IDEMPOTENCY_RECEIPT_SQL = `
  SELECT workspace_id, request_hash, receipt_json
  FROM idempotency_keys
  WHERE workspace_id = ?1 AND key = ?2`;

const INSERT_IDEMPOTENCY_SQL = `
  INSERT INTO idempotency_keys
    (key, workspace_id, device_id, request_hash, receipt_json, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)`;

const INSERT_EVENT_SQL = `
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  SELECT
    ?1,
    json_extract(input.value, '$.event_id'),
    ?2,
    json_extract(input.value, '$.occurred_at'),
    json_extract(input.value, '$.workstream_id'),
    json_extract(input.value, '$.session_id'),
    json_extract(input.value, '$.native_session_id'),
    json_extract(input.value, '$.provider'),
    json_extract(input.value, '$.kind'),
    json_extract(input.value, '$.provenance'),
    json_extract(input.value, '$.content_hash'),
    ?3,
    input.value
  FROM json_each(?4) AS input`;

const UPSERT_WORKSTREAM_SQL = `
  INSERT INTO workstreams
    (id, workspace_id, repository_id, title, status, created_at, updated_at,
     title_event_at_ms, title_event_id, status_event_at_ms, status_event_id)
  SELECT
    json_extract(input.value, '$.id'),
    json_extract(input.value, '$.workspace_id'),
    json_extract(input.value, '$.repository_id'),
    json_extract(input.value, '$.title'),
    json_extract(input.value, '$.status'),
    json_extract(input.value, '$.created_at'),
    json_extract(input.value, '$.updated_at'),
    json_extract(input.value, '$.title_event_at_ms'),
    json_extract(input.value, '$.title_event_id'),
    json_extract(input.value, '$.status_event_at_ms'),
    json_extract(input.value, '$.status_event_id')
  FROM json_each(?1) AS input
  WHERE EXISTS (
    SELECT 1
    FROM events
    JOIN json_each(?2) AS source
      ON json_extract(source.value, '$.event_id') =
         json_extract(input.value, '$.source_event_id')
    WHERE events.workspace_id = json_extract(input.value, '$.workspace_id')
      AND events.event_id = json_extract(input.value, '$.source_event_id')
      AND events.raw_json = source.value
  )
  ON CONFLICT(workspace_id, id) DO UPDATE SET
    repository_id = CASE
      WHEN workstreams.repository_id IS NULL THEN excluded.repository_id
      WHEN excluded.repository_id IS NULL THEN workstreams.repository_id
      WHEN excluded.repository_id < workstreams.repository_id THEN excluded.repository_id
      ELSE workstreams.repository_id
    END,
    title = CASE
      WHEN excluded.title_event_at_ms IS NULL THEN workstreams.title
      WHEN workstreams.title_event_at_ms IS NULL
        OR excluded.title_event_at_ms < workstreams.title_event_at_ms
        OR (excluded.title_event_at_ms = workstreams.title_event_at_ms
            AND excluded.title_event_id < workstreams.title_event_id)
        THEN excluded.title
      ELSE workstreams.title
    END,
    title_event_at_ms = CASE
      WHEN excluded.title_event_at_ms IS NULL THEN workstreams.title_event_at_ms
      WHEN workstreams.title_event_at_ms IS NULL
        OR excluded.title_event_at_ms < workstreams.title_event_at_ms
        OR (excluded.title_event_at_ms = workstreams.title_event_at_ms
            AND excluded.title_event_id < workstreams.title_event_id)
        THEN excluded.title_event_at_ms
      ELSE workstreams.title_event_at_ms
    END,
    title_event_id = CASE
      WHEN excluded.title_event_at_ms IS NULL THEN workstreams.title_event_id
      WHEN workstreams.title_event_at_ms IS NULL
        OR excluded.title_event_at_ms < workstreams.title_event_at_ms
        OR (excluded.title_event_at_ms = workstreams.title_event_at_ms
            AND excluded.title_event_id < workstreams.title_event_id)
        THEN excluded.title_event_id
      ELSE workstreams.title_event_id
    END,
    status = CASE
      WHEN workstreams.status = 'completed' THEN workstreams.status
      WHEN excluded.status = 'completed' THEN excluded.status
      WHEN excluded.status_event_at_ms IS NULL THEN workstreams.status
      WHEN workstreams.status_event_at_ms IS NULL
        OR excluded.status_event_at_ms > workstreams.status_event_at_ms
        OR (excluded.status_event_at_ms = workstreams.status_event_at_ms
            AND excluded.status_event_id > workstreams.status_event_id)
        THEN excluded.status
      ELSE workstreams.status
    END,
    status_event_at_ms = CASE
      WHEN workstreams.status = 'completed' AND excluded.status <> 'completed'
        THEN workstreams.status_event_at_ms
      WHEN excluded.status = 'completed' AND workstreams.status <> 'completed'
        THEN excluded.status_event_at_ms
      WHEN excluded.status_event_at_ms IS NULL THEN workstreams.status_event_at_ms
      WHEN workstreams.status_event_at_ms IS NULL
        OR excluded.status_event_at_ms > workstreams.status_event_at_ms
        OR (excluded.status_event_at_ms = workstreams.status_event_at_ms
            AND excluded.status_event_id > workstreams.status_event_id)
        THEN excluded.status_event_at_ms
      ELSE workstreams.status_event_at_ms
    END,
    status_event_id = CASE
      WHEN workstreams.status = 'completed' AND excluded.status <> 'completed'
        THEN workstreams.status_event_id
      WHEN excluded.status = 'completed' AND workstreams.status <> 'completed'
        THEN excluded.status_event_id
      WHEN excluded.status_event_at_ms IS NULL THEN workstreams.status_event_id
      WHEN workstreams.status_event_at_ms IS NULL
        OR excluded.status_event_at_ms > workstreams.status_event_at_ms
        OR (excluded.status_event_at_ms = workstreams.status_event_at_ms
            AND excluded.status_event_id > workstreams.status_event_id)
        THEN excluded.status_event_id
      ELSE workstreams.status_event_id
    END,
    created_at = MIN(workstreams.created_at, excluded.created_at),
    updated_at = MAX(workstreams.updated_at, excluded.updated_at)
  WHERE workstreams.workspace_id = excluded.workspace_id`;

async function handleEventBatches(
  request: Request,
  env: { DB: D1DatabaseLike; ANALYTICS?: AnalyticsEngineDatasetLike },
  options: { requireRedactionAttestation?: boolean } = {},
): Promise<Response> {
  const auth = await authenticate(
    request.headers.get("authorization"),
    deviceLookup(
      env.DB,
      deletionLedgerBinding(env),
      deletionLedgerRequired(env),
    ),
  );
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.error });
  const { device } = auth;

  const capabilityDenial = scopeDenial({
    tokenWorkspaceId: device.workspaceId,
    allowed: hasCapability(device, "ingest"),
  });
  if (capabilityDenial !== null) {
    return jsonResponse(capabilityDenial.status, { error: capabilityDenial.error });
  }

  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (idempotencyKey.trim().length === 0 || idempotencyKey.length > 256) {
    return jsonResponse(400, { error: "Idempotency-Key header is required" });
  }

  const bodyRead = await readRequestBody(request, MAX_BODY_BYTES);
  if (!bodyRead.ok) {
    const error = bodyRead.status === 413
      ? "request body exceeds 1 MiB"
      : "request body is not readable UTF-8";
    return jsonResponse(bodyRead.status, { error });
  }
  const body = bodyRead.text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResponse(400, { error: "request body is not valid JSON" });
  }

  const validation = validateEventBatch(parsed, device.workspaceId, options);
  if (!validation.ok) return jsonResponse(validation.status, { error: validation.error });
  const envelope = validation.value;
  const requestHash = await sha256Hex(canonicalJsonStringify(envelope));
  const bodyBytes = new TextEncoder().encode(body).byteLength;

  // Idempotent replay: the same key returns the original receipt bytes.
  const existing = await env.DB.prepare(IDEMPOTENCY_RECEIPT_SQL)
    .bind(device.workspaceId, idempotencyKey)
    .first<{ workspace_id: string; request_hash: string | null; receipt_json: string }>();
  if (existing !== null) {
    const denial = scopeDenial({
      resourceWorkspaceId: existing.workspace_id,
      tokenWorkspaceId: device.workspaceId,
    });
    if (denial !== null) return jsonResponse(denial.status, { error: denial.error });
    if (typeof existing.request_hash !== "string") {
      return jsonResponse(409, {
        error: "legacy Idempotency-Key cannot be verified; use a new key",
      });
    }
    if (existing.request_hash !== requestHash) {
      return jsonResponse(409, { error: "Idempotency-Key was already used for a different request" });
    }
    return canonicalResponse(200, existing.receipt_json);
  }

  const ingestedAt = Math.floor(Date.now() / 1000);
  const quota = await prepareQuotaReservation(env.DB, {
    workspaceId: device.workspaceId,
    idempotencyKey,
    requestHash,
    eventCount: envelope.events.length,
    bodyBytes,
    nowSeconds: ingestedAt,
  });
  if (!quota.ok) return quotaResponse(quota, ingestedAt);
  if (quota.duplicate) {
    // The reservation and receipt commit in the same D1 transaction. Seeing
    // an allowed reservation after the first receipt read means a concurrent
    // identical request won; re-read its receipt instead of writing without a
    // reservation statement or charging twice.
    const winner = await env.DB.prepare(IDEMPOTENCY_RECEIPT_SQL)
      .bind(device.workspaceId, idempotencyKey)
      .first<{ workspace_id: string; request_hash: string | null; receipt_json: string }>();
    if (winner === null) {
      return jsonResponse(503, {
        error: "hosted quota is temporarily unavailable",
        code: "quota_unavailable",
        local_capture_unaffected: true,
      });
    }
    if (typeof winner.request_hash !== "string") {
      return jsonResponse(409, {
        error: "legacy Idempotency-Key cannot be verified; use a new key",
      });
    }
    if (winner.request_hash !== requestHash) {
      return jsonResponse(409, { error: "Idempotency-Key was already used for a different request" });
    }
    return canonicalResponse(200, winner.receipt_json);
  }

  const receipt = await buildReceipt(idempotencyKey, device.workspaceId, envelope);
  const receiptJson = canonicalJsonStringify(receipt);
  const workstreamRows = buildWorkstreamProjectionRows(envelope, device.workspaceId);
  const eventsJson = canonicalJsonStringify(envelope.events);
  const workstreamRowsJson = canonicalJsonStringify(workstreamRows);

  // Keep the D1 statement count constant (three legacy writes, four for a
  // metered workspace) even at the event ceiling. The quota reservation is
  // in this same transaction: its trigger either charges and permits all
  // writes, or aborts and rolls back the receipt/events/projection together.
  // json_each expands bounded canonical arrays inside D1; emitting one
  // prepared statement per event would exceed per-invocation query limits.
  const statements = [
    ...("statement" in quota ? [quota.statement] : []),
    env.DB.prepare(INSERT_IDEMPOTENCY_SQL).bind(
      idempotencyKey,
      device.workspaceId,
      device.deviceId,
      requestHash,
      receiptJson,
      ingestedAt,
    ),
    env.DB.prepare(INSERT_EVENT_SQL).bind(
      device.workspaceId,
      idempotencyKey,
      ingestedAt,
      eventsJson,
    ),
    env.DB.prepare(UPSERT_WORKSTREAM_SQL).bind(workstreamRowsJson, eventsJson),
    ...(await buildObservationStatements(env.DB, device.workspaceId, envelope.events)),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    // Migration 0019 is the commit-time authorization boundary. If owner
    // revocation serialized first, its trigger aborts this whole D1 batch so
    // quota, receipt, events, and projections all roll back together. Map the
    // stable internal trigger message to the same indistinguishable response
    // as initial device authentication, before considering a cached winner.
    if (
      error instanceof Error &&
      (error.message.includes("active device required") ||
        error.message.includes("workspace deletion in progress"))
    ) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    // Lost a race against a concurrent batch with the same key: the winner's
    // receipt is authoritative.
    const winner = await env.DB.prepare(IDEMPOTENCY_RECEIPT_SQL)
      .bind(device.workspaceId, idempotencyKey)
      .first<{ workspace_id: string; request_hash: string | null; receipt_json: string }>();
    if (winner !== null && winner.workspace_id === device.workspaceId) {
      if (typeof winner.request_hash !== "string") {
        return jsonResponse(409, {
          error: "legacy Idempotency-Key cannot be verified; use a new key",
        });
      }
      if (winner.request_hash !== requestHash) {
        return jsonResponse(409, { error: "Idempotency-Key was already used for a different request" });
      }
      return canonicalResponse(200, winner.receipt_json);
    }
    if (error instanceof Error && error.message.includes("event payload conflict")) {
      return jsonResponse(409, {
        error: "event_id was already used for different evidence",
      });
    }
    // If the trigger rejected a race that crossed a hard quota after the
    // preflight read, turn it into the same structured denial. Never retry the
    // write here: the local spool remains the source of truth.
    const afterFailure = await prepareQuotaReservation(env.DB, {
      workspaceId: device.workspaceId,
      idempotencyKey,
      requestHash,
      eventCount: envelope.events.length,
      bodyBytes,
      nowSeconds: ingestedAt,
    });
    if (!afterFailure.ok) return quotaResponse(afterFailure, ingestedAt);
    return jsonResponse(500, { error: "internal error" });
  }

  // Sampled Analytics Engine mirror for dashboards, after the D1 write has
  // already committed. recordIngestDataPoints never throws (absence of the
  // binding, or a throwing one, are both handled internally) and is not a
  // D1 statement, so it cannot affect the batch above or its receipt.
  recordIngestDataPoints(env, device.workspaceId, envelope.events);

  return canonicalResponse(200, receiptJson);
}

// -- GET /v1/workstreams ------------------------------------------------------

const WORKSTREAMS_PAGE_SQL = `
  SELECT id, workspace_id, title, status, repository_id, created_at, updated_at
  FROM workstreams
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const WORKSTREAMS_PAGE_AFTER_SQL = `
  SELECT id, workspace_id, title, status, repository_id, created_at, updated_at
  FROM workstreams
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

async function handleListWorkstreams(
  request: Request,
  env: { DB: D1DatabaseLike },
): Promise<Response> {
  const auth = await authenticate(
    request.headers.get("authorization"),
    deviceLookup(
      env.DB,
      deletionLedgerBinding(env),
      deletionLedgerRequired(env),
    ),
  );
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.error });

  const denial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, "read"),
  });
  if (denial !== null) return jsonResponse(denial.status, { error: denial.error });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return jsonResponse(page.status, { error: page.error });
  const { limit, cursor } = page.value;

  const fetchLimit = limit + 1; // prefetch one row to detect the next page
  const result =
    cursor === null
      ? await env.DB.prepare(WORKSTREAMS_PAGE_SQL)
          .bind(auth.device.workspaceId, fetchLimit)
          .all<WorkstreamRow>()
      : await env.DB.prepare(WORKSTREAMS_PAGE_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<WorkstreamRow>();

  // The owner deletion prelock can commit after the initial bearer lookup
  // but while this read is paused in D1. Reauthorize immediately before any
  // tenant rows leave the Worker. If the prelock or revocation won, the active
  // workspace/device join now fails and the fetched rows are discarded.
  const finalAuth = await authenticate(
    request.headers.get("authorization"),
    deviceLookup(
      env.DB,
      deletionLedgerBinding(env),
      deletionLedgerRequired(env),
    ),
  );
  if (
    !finalAuth.ok ||
    finalAuth.device.deviceId !== auth.device.deviceId ||
    finalAuth.device.workspaceId !== auth.device.workspaceId
  ) return jsonResponse(401, { error: "unauthorized" });

  return jsonResponse(200, buildWorkstreamListResponse(result.results, limit));
}
