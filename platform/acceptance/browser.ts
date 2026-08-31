import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  AcceptanceContractError,
  isCertainlyRejectedDeletionStatus,
  parseAccountQuota,
  parseDeviceCredential,
  parseFreshAccountQuota,
  validateWorkspaceID,
  type AccountQuotaSnapshot,
  type AccountLane,
  type DeviceCredential,
} from "./contracts";

// This file is typechecked against the Worker/Node library set so importing
// account deletion contracts does not introduce conflicting DOM crypto types.
// The only browser global used directly inside page.evaluate is this narrow
// cookie view; Playwright executes it in the page, never in Node.
declare const document: { cookie: string };

export type AuthIntent = "signin" | "signup";

export type HandoffGraphTurnstileAction = `auth-${AuthIntent}`;

export interface InteractiveAccount {
  lane: AccountLane;
  context: BrowserContext;
  page: Page;
  workspaceId: string;
  initialQuota: AccountQuotaSnapshot;
}

function browserFail(code: string): never {
  throw new AcceptanceContractError(code);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let turnstileBindingSequence = 0;

export function isTurnstileChallengeURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "challenges.cloudflare.com" &&
      (url.pathname.startsWith("/turnstile/") ||
        url.pathname.startsWith("/cdn-cgi/challenge-platform/"));
  } catch {
    return false;
  }
}

function isExactAccountPage(value: string, expectedOrigin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === expectedOrigin &&
      url.pathname === "/account" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}

export function isHandoffGraphTurnstileChallenge(input: {
  responseURL: string;
  topLevelPageURL: string;
  expectedOrigin: string;
}): boolean {
  return isExactAccountPage(input.topLevelPageURL, input.expectedOrigin) &&
    isTurnstileChallengeURL(input.responseURL);
}

export function isHandoffGraphTurnstileCompletion(input: {
  frameURL: string;
  expectedOrigin: string;
  expectedAction: HandoffGraphTurnstileAction;
  payload: unknown;
}): boolean {
  if (!isExactAccountPage(input.frameURL, input.expectedOrigin)) return false;
  if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) {
    return false;
  }
  const payload = input.payload as Record<string, unknown>;
  return Object.keys(payload).length === 2 &&
    payload.action === input.expectedAction &&
    payload.sitekey_present === true;
}

async function observeTurnstile(input: {
  page: Page;
  origin: string;
  action: HandoffGraphTurnstileAction;
  timeoutMs: number;
}): Promise<{
  assertObserved: () => Promise<void>;
  dispose: () => void;
}> {
  const { page } = input;
  let challengeObserved = false;
  let completionObserved = false;
  const bindingName = `__hfgAcceptanceTurnstile${turnstileBindingSequence += 1}`;
  const responseListener = (response: { url(): string; status(): number }) => {
    if (
      response.status() >= 200 && response.status() < 400 &&
      isHandoffGraphTurnstileChallenge({
        responseURL: response.url(),
        topLevelPageURL: page.url(),
        expectedOrigin: input.origin,
      })
    ) {
      challengeObserved = true;
    }
  };
  page.on("response", responseListener);
  await page.exposeBinding(bindingName, (source, payload: unknown) => {
    if (
      source.frame === page.mainFrame() &&
      isHandoffGraphTurnstileCompletion({
        frameURL: source.frame.url(),
        expectedOrigin: input.origin,
        expectedAction: input.action,
        payload,
      })
    ) completionObserved = true;
  });
  await page.addInitScript({
    content: `(() => {
      const report = () => {
        const action = ${JSON.stringify(input.action)};
        const selector = '[data-hfg-turnstile-action="' + action + '"]' +
          '[data-action="' + action + '"][data-sitekey]';
        const markers = document.querySelectorAll(selector);
        for (const marker of markers) {
          const sitekey = marker.getAttribute('data-sitekey');
          const tokenInput = marker.querySelector('input[name="cf-turnstile-response"]');
          if (tokenInput && typeof tokenInput.value === "string" && tokenInput.value.length > 0) {
            void globalThis[${JSON.stringify(bindingName)}]({
              action,
              sitekey_present: typeof sitekey === 'string' && sitekey.length > 0,
            });
            return;
          }
        }
      };
      report();
      globalThis.setInterval(report, 200);
    })();`,
  });
  return {
    assertObserved: async () => {
      const deadline = Date.now() + input.timeoutMs;
      while ((!challengeObserved || !completionObserved) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      if (!challengeObserved) browserFail("turnstile_challenge_not_observed");
      if (!completionObserved) browserFail("turnstile_completion_not_observed");
    },
    dispose: () => page.off("response", responseListener),
  };
}

async function accountQuotaFromPage(page: Page): Promise<AccountQuotaSnapshot> {
  const snapshot = await page.evaluate(async () => {
    const response = await fetch("/v1/me", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = await response.json() as {
      workspace?: { id?: unknown };
      entitlement?: {
        devices?: { used?: unknown; limit?: unknown };
        device_issuances?: { used?: unknown; limit?: unknown };
      };
    };
    return {
      workspace_id: body.workspace?.id,
      active_devices: body.entitlement?.devices?.used,
      max_devices: body.entitlement?.devices?.limit,
      used_device_issuances: body.entitlement?.device_issuances?.used,
      max_device_issuances: body.entitlement?.device_issuances?.limit,
    };
  });
  return parseAccountQuota(snapshot);
}

export async function launchAcceptanceBrowser(
  environment: Record<string, string>,
): Promise<Browser> {
  return chromium.launch({
    headless: false,
    env: environment,
    // Acceptance state is intentionally memory-only. Do not add a persistent
    // userDataDir, storageState, video, trace, or HAR recorder here.
  });
}

/**
 * Prove the production entry journey from the public landing page through
 * the rendered account surface. This intentionally uses a fresh in-memory
 * context and never follows an external identity-provider redirect.
 */
export async function verifyApexLanding(input: {
  browser: Browser;
  landingOrigin: string;
  apiOrigin: string;
  timeoutMs: number;
}): Promise<void> {
  const context = await input.browser.newContext({
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  try {
    await page.goto(`${input.landingOrigin}/`, {
      waitUntil: "domcontentloaded",
      timeout: input.timeoutMs,
    });
    const landingURL = new URL(page.url());
    if (
      landingURL.origin !== input.landingOrigin ||
      landingURL.pathname !== "/" ||
      landingURL.search !== "" ||
      landingURL.hash !== ""
    ) browserFail("landing_origin_mismatch");
    const accountHref = `${input.apiOrigin}/account`;
    const accountLink = page.locator(`a[href="${accountHref}"]`).first();
    await accountLink.waitFor({ state: "visible", timeout: input.timeoutMs });
    if ((await accountLink.textContent())?.trim() === "") browserFail("landing_account_link_empty");
    await accountLink.click({ timeout: input.timeoutMs });
    await page.waitForURL(accountHref, {
      timeout: input.timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.locator("main#main").waitFor({ state: "visible", timeout: input.timeoutMs });
    await page.locator('a[href*="intent=signin"]').waitFor({
      state: "visible",
      timeout: input.timeoutMs,
    });
  } finally {
    await context.close();
  }
}

export async function authenticateInteractiveAccount(input: {
  browser: Browser;
  lane: AccountLane;
  origin: string;
  intent: AuthIntent;
  timeoutMs: number;
  announce: (lane: AccountLane, intent: AuthIntent) => void;
}): Promise<InteractiveAccount> {
  const context = await input.browser.newContext({
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const turnstile = await observeTurnstile({
    page,
    origin: input.origin,
    action: `auth-${input.intent}`,
    timeoutMs: input.timeoutMs,
  });
  input.announce(input.lane, input.intent);
  try {
    await page.goto(new URL("/account", input.origin).toString(), {
      waitUntil: "domcontentloaded",
    });
    const authAction = page.locator(`a[href*="intent=${input.intent}"]`);
    await authAction.waitFor({ state: "visible", timeout: 30_000 });
    // Prove the challenge while HandoffGraph's exact /account page still owns
    // the top-level document. A provider-side challenge after redirect cannot
    // satisfy this product control.
    await turnstile.assertObserved();
    await authAction.click({ timeout: input.timeoutMs });

    const accountURL = new RegExp(`^${escapeRegExp(input.origin)}/account(?:[?#].*)?$`);
    await page.waitForURL(accountURL, {
      timeout: input.timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.locator("#workspace-id").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("#device-form").waitFor({ state: "visible", timeout: 30_000 });
    const quota = parseFreshAccountQuota(await accountQuotaFromPage(page));
    return {
      lane: input.lane,
      context,
      page,
      workspaceId: validateWorkspaceID(quota.workspace_id),
      initialQuota: quota,
    };
  } finally {
    turnstile.dispose();
  }
}

export async function reauthenticateInteractiveAccount(input: {
  account: InteractiveAccount;
  origin: string;
  timeoutMs: number;
  announce: (lane: AccountLane, intent: AuthIntent) => void;
}): Promise<void> {
  const page = input.account.page;
  const turnstile = await observeTurnstile({
    page,
    origin: input.origin,
    action: "auth-signin",
    timeoutMs: input.timeoutMs,
  });
  input.announce(input.account.lane, "signin");
  try {
    await page.goto(new URL("/account", input.origin).toString(), {
      waitUntil: "domcontentloaded",
    });
    const authAction = page.locator('a[href*="intent=signin"]');
    await authAction.waitFor({ state: "visible", timeout: 30_000 });
    await turnstile.assertObserved();
    await authAction.click({ timeout: input.timeoutMs });
    await page.waitForURL(
      new RegExp(`^${escapeRegExp(input.origin)}/account(?:[?#].*)?$`),
      { timeout: input.timeoutMs, waitUntil: "domcontentloaded" },
    );
    await page.locator("#device-form").waitFor({ state: "visible", timeout: 30_000 });
    const quota = await accountQuotaFromPage(page);
    if (quota.workspace_id !== input.account.workspaceId) {
      browserFail("reauthenticated_workspace_changed");
    }
  } finally {
    turnstile.dispose();
  }
}

export async function createPrimaryDevice(input: {
  account: InteractiveAccount;
  label: string;
}): Promise<DeviceCredential> {
  const page = input.account.page;
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/v1/devices" && response.request().method() === "POST";
  });
  await page.locator("#device-label").fill(input.label);
  await page.locator("#device-submit").click();
  const response = await responsePromise;
  if (response.status() !== 201) browserFail("primary_device_creation_failed");
  const credential = parseDeviceCredential(await response.json());

  const token = page.locator("#device-token");
  await token.waitFor({ state: "visible", timeout: 30_000 });
  if ((await token.textContent())?.trim() !== credential.token) {
    browserFail("one_time_device_credential_mismatch");
  }
  return credential;
}

interface QuotaProbeResult {
  secondDeviceId: string;
  deniedStatus: number;
  deniedResource: string | null;
  revokeStatus: number;
}

export async function exerciseDeviceQuota(
  account: InteractiveAccount,
  labelPrefix: string,
): Promise<QuotaProbeResult> {
  const result = await account.page.evaluate(async ({ prefix }) => {
    const csrfName = "__Host-hfg_csrf";
    const csrf = document.cookie.split(";").map((part) => part.trim()).map((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return ["", ""];
      return [decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))];
    }).find(([name]) => name === csrfName)?.[1] ?? "";
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrf,
    };
    const create = async (label: string) => {
      const response = await fetch("/v1/devices", {
        method: "POST",
        headers,
        body: JSON.stringify({ label }),
      });
      const body = await response.json() as {
        device?: { id?: unknown };
        resource?: unknown;
      };
      // Deliberately return no token: the second one-time credential is
      // discarded inside the page and never crosses the browser boundary.
      return {
        status: response.status,
        deviceId: typeof body.device?.id === "string" ? body.device.id : null,
        resource: typeof body.resource === "string" ? body.resource : null,
      };
    };

    const second = await create(`${prefix}-quota-slot`);
    const denied = await create(`${prefix}-quota-denied`);
    let revokeStatus = 0;
    if (second.deviceId !== null) {
      const response = await fetch(`/v1/devices/${encodeURIComponent(second.deviceId)}/revoke`, {
        method: "POST",
        headers,
      });
      revokeStatus = response.status;
    }
    return {
      secondStatus: second.status,
      secondDeviceId: second.deviceId,
      deniedStatus: denied.status,
      deniedResource: denied.resource,
      revokeStatus,
    };
  }, { prefix: labelPrefix });

  if (
    result.secondStatus !== 201 ||
    typeof result.secondDeviceId !== "string" ||
    result.deniedStatus !== 429 ||
    result.deniedResource !== "devices" ||
    result.revokeStatus !== 200
  ) browserFail("device_quota_contract_failed");
  return {
    secondDeviceId: result.secondDeviceId,
    deniedStatus: result.deniedStatus,
    deniedResource: result.deniedResource,
    revokeStatus: result.revokeStatus,
  };
}

export async function revokePrimaryDevice(input: {
  account: InteractiveAccount;
  deviceId: string;
}): Promise<void> {
  const page = input.account.page;
  // The launch proof must traverse the same rendered control a user sees.
  // Cleanup helpers may use direct requests, but this primary revocation is a
  // product journey assertion and therefore must exercise the confirmation
  // dialog, CSRF path, response, and refreshed DOM state.
  const button = page.locator(
    `button.device-revoke[data-device-id="${input.deviceId}"]`,
  );
  await button.waitFor({ state: "visible", timeout: 30_000 });
  const row = page.locator("li.device-item").filter({ hasText: input.deviceId }).first();
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/v1/devices/${input.deviceId}/revoke` &&
      response.request().method() === "POST";
  });
  const clickPromise = button.click({ timeout: 30_000 });
  const dialog = await page.waitForEvent("dialog", { timeout: 30_000 });
  if (dialog.type() !== "confirm") {
    await dialog.dismiss();
    await clickPromise.catch(() => undefined);
    browserFail("primary_device_confirmation_missing");
  }
  await dialog.accept();
  await clickPromise;
  const response = await responsePromise;
  if (response.status() !== 200) browserFail("primary_device_revocation_failed");
  await row.locator(".device-meta").filter({ hasText: /^revoked$/i }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

export async function revokeAllActiveDevices(account: InteractiveAccount): Promise<number> {
  const result = await account.page.evaluate(async () => {
    const csrfName = "__Host-hfg_csrf";
    const csrf = document.cookie.split(";").map((part) => part.trim()).map((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return ["", ""];
      return [decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))];
    }).find(([name]) => name === csrfName)?.[1] ?? "";
    const listed = await fetch("/v1/devices", { headers: { accept: "application/json" } });
    const body = await listed.json() as { devices?: Array<{ id?: unknown }> };
    if (listed.status !== 200 || !Array.isArray(body.devices)) {
      return { ok: false, count: 0 };
    }
    let count = 0;
    for (const device of body.devices) {
      if (typeof device.id !== "string" || !/^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(device.id)) {
        return { ok: false, count };
      }
      const revoked = await fetch(`/v1/devices/${encodeURIComponent(device.id)}/revoke`, {
        method: "POST",
        headers: { accept: "application/json", "x-csrf-token": csrf },
      });
      if (revoked.status !== 200) return { ok: false, count };
      count += 1;
    }
    return { ok: true, count };
  });
  if (!result.ok) browserFail("active_device_cleanup_failed");
  return result.count;
}

export async function exerciseLifetimeDeviceIssuanceQuota(
  account: InteractiveAccount,
  labelPrefix: string,
): Promise<10> {
  const result = await account.page.evaluate(async ({ prefix }) => {
    const csrfName = "__Host-hfg_csrf";
    const csrf = document.cookie.split(";").map((part) => part.trim()).map((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return ["", ""];
      return [decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))];
    }).find(([name]) => name === csrfName)?.[1] ?? "";
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrf,
    };
    const quota = async () => {
      const response = await fetch("/v1/me", { headers: { accept: "application/json" } });
      const body = await response.json() as {
        entitlement?: {
          devices?: { used?: unknown; limit?: unknown };
          device_issuances?: { used?: unknown; limit?: unknown };
        };
      };
      return {
        status: response.status,
        active: body.entitlement?.devices?.used,
        activeLimit: body.entitlement?.devices?.limit,
        used: body.entitlement?.device_issuances?.used,
        limit: body.entitlement?.device_issuances?.limit,
      };
    };
    const create = async (label: string) => {
      const response = await fetch("/v1/devices", {
        method: "POST",
        headers,
        body: JSON.stringify({ label }),
      });
      const body = await response.json() as {
        device?: { id?: unknown };
        resource?: unknown;
        limit?: unknown;
      };
      return {
        status: response.status,
        id: typeof body.device?.id === "string" ? body.device.id : null,
        resource: typeof body.resource === "string" ? body.resource : null,
        limit: typeof body.limit === "number" ? body.limit : null,
      };
    };
    const initial = await quota();
    if (
      initial.status !== 200 || initial.active !== 1 || initial.activeLimit !== 2 ||
      initial.used !== 2 || initial.limit !== 10
    ) return { ok: false, limit: 0 };
    for (let issuance = initial.used; issuance < initial.limit; issuance += 1) {
      const created = await create(`${prefix}-lifetime-${issuance + 1}`);
      if (created.status !== 201 || created.id === null) return { ok: false, limit: 0 };
      const revoked = await fetch(`/v1/devices/${encodeURIComponent(created.id)}/revoke`, {
        method: "POST",
        headers,
      });
      if (revoked.status !== 200) return { ok: false, limit: 0 };
    }
    const denied = await create(`${prefix}-lifetime-denied`);
    const terminal = await quota();
    return {
      ok: denied.status === 429 && denied.resource === "device_issuances" &&
        denied.limit === 10 && terminal.status === 200 && terminal.active === 1 &&
        terminal.used === 10 && terminal.limit === 10,
      limit: 10,
    };
  }, { prefix: labelPrefix });
  if (!result.ok || result.limit !== 10) {
    browserFail("device_lifetime_quota_contract_failed");
  }
  return 10;
}

export async function browserAccountStatus(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/v1/me", {
      headers: { accept: "application/json" },
    });
    return response.status;
  });
}

export async function signOutInteractiveAccount(input: {
  account: InteractiveAccount;
  origin: string;
  timeoutMs: number;
}): Promise<void> {
  const page = input.account.page;
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/v1/auth/signout" && response.request().method() === "POST";
  });
  const workosRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === "GET" &&
      url.origin === "https://api.workos.com" &&
      url.pathname === "/user_management/sessions/logout";
  }, { timeout: input.timeoutMs });
  const workosResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === "https://api.workos.com" &&
      url.pathname === "/user_management/sessions/logout";
  }, { timeout: input.timeoutMs });
  await page.locator("#sign-out").click();
  const response = await responsePromise;
  if (response.status() !== 200) browserFail("browser_signout_failed");
  const workosRequest = await workosRequestPromise;
  const workosURL = new URL(workosRequest.url());
  if (
    workosURL.username !== "" ||
    workosURL.password !== "" ||
    workosURL.hash !== "" ||
    workosURL.searchParams.get("return_to") !== new URL("/account", input.origin).toString() ||
    !/^session_[A-Za-z0-9_-]{1,120}$/.test(workosURL.searchParams.get("session_id") ?? "")
  ) browserFail("workos_logout_destination_invalid");
  const workosResponse = await workosResponsePromise;
  if (workosResponse.status() < 200 || workosResponse.status() >= 400) {
    browserFail("workos_logout_traversal_failed");
  }
  await page.waitForURL(
    new RegExp(`^${escapeRegExp(input.origin)}/account(?:[?#].*)?$`),
    { timeout: input.timeoutMs, waitUntil: "domcontentloaded" },
  );
  if (await browserAccountStatus(page) !== 401) {
    browserFail("browser_session_survived_signout");
  }
}

export async function deleteInteractiveAccount(input: {
  account: InteractiveAccount;
  confirmation: string;
  origin: string;
  timeoutMs: number;
  onDispatched: () => void;
  onRejected: () => void;
  onAccepted: () => void;
}): Promise<void> {
  const page = input.account.page;
  let acceptedDialog = false;
  page.once("dialog", async (dialog) => {
    if (
      dialog.type() !== "confirm" ||
      dialog.message() !== "Permanently delete this hosted account and workspace?"
    ) {
      await dialog.dismiss();
      return;
    }
    acceptedDialog = true;
    await dialog.accept();
  });
  await page.locator("#deletion-confirmation").fill(input.confirmation);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/v1/account" && response.request().method() === "DELETE";
  });
  const destinationPromise = page.waitForURL(
    new RegExp(`^${escapeRegExp(input.origin)}/account\\?deletion=requested(?:&.*)?$`),
    { timeout: input.timeoutMs, waitUntil: "domcontentloaded" },
  );
  // Once the action is triggered, absence of a response is ambiguous: the
  // request may already be owned by the server-side deletion saga.
  input.onDispatched();
  await page.locator("#deletion-submit").click();
  const response = await responsePromise;
  if (response.status() !== 202) {
    if (isCertainlyRejectedDeletionStatus(response.status())) {
      input.onRejected();
    }
    browserFail("account_deletion_request_failed");
  }
  input.onAccepted();
  if (!acceptedDialog) browserFail("account_deletion_request_failed");
  await destinationPromise;
  if (await browserAccountStatus(page) !== 401) {
    browserFail("browser_session_survived_deletion");
  }
}
