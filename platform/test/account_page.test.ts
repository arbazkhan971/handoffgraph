import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountPageCSP, renderAccountPage, renderSignedOutPage } from "../src/account_page";

function inlineBlock(html: string, tag: "style" | "script"): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html);
  if (match === null) throw new Error(`missing inline ${tag} block`);
  return match[1];
}

function csp(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  if (match === null) throw new Error("missing CSP meta policy");
  return match[1];
}

function sha256Source(source: string): string {
  return `sha256-${createHash("sha256").update(source).digest("base64")}`;
}

describe("renderAccountPage", () => {
  it("renders an accessible account dashboard with the requested controls", () => {
    const html = renderAccountPage();

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<a class="skip-link" href="#main">Skip to main content</a>');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('aria-labelledby="account-title"');
    expect(html).toContain('aria-labelledby="usage-heading"');
    expect(html).toContain('aria-labelledby="devices-heading"');
    expect(html).toContain('aria-labelledby="setup-heading"');
    expect(html).toContain('<progress max="5000" value="0"');
    expect(html).toContain('<progress max="25000" value="0"');
    expect(html).toContain('<progress max="64" value="0"');
    expect(html).toContain('<progress max="2" value="0"');
    expect(html).toContain('<progress max="10" value="0"');
    expect(html).toContain("Monthly synced events");
    expect(html).toContain("Lifetime synced events");
    expect(html).toContain("Uploaded lifetime");
    expect(html).toContain("Device-token issuances");
    expect(html).toContain("10 device-token issuances over the account lifetime");
    expect(html).toContain("handoffgraph sync --preview");
    expect(html).toContain("handoffgraph sync --accept-redaction");
    expect(html).not.toMatch(/repositor/i);
    expect(html).toContain('<form class="device-form" id="device-form">');
    expect(html).toContain('<label for="device-label">Device label</label>');
    expect(html).toContain('id="device-status" role="status" aria-live="polite"');
    expect(html).toContain('id="sign-out" type="button"');
    expect(html).toContain('aria-labelledby="deletion-heading"');
    expect(html).toContain('<form class="device-form danger-form" id="deletion-form">');
    expect(html).toContain('id="deletion-status" role="status" aria-live="polite"');
    expect(html).toContain("or refund the limited-beta account issuance");
    expect(html).toContain('<body data-hosted-surface="advanced">');
  });

  it("omits advanced team controls and guards team requests in Hosted Basic mode", () => {
    const html = renderAccountPage({
      hostedBasic: true,
      workspaceId: "wsp_basic",
      members: [{ userId: "usr_hidden", email: "hidden@example.test", role: "owner" }],
      invites: [{ id: "inv_hidden", email: "invite@example.test", role: "member" }],
      workspaces: [{ workspaceId: "wsp_hidden", name: "Hidden team" }],
    });
    const script = inlineBlock(html, "script");

    expect(html).toContain('<body data-hosted-surface="basic">');
    expect(html).not.toContain('id="team-title"');
    expect(html).not.toContain('id="member-list"');
    expect(html).not.toContain('id="invite-form"');
    expect(html).not.toContain('id="invite-list"');
    expect(html).not.toContain('id="workspace-list"');
    expect(html).not.toContain("hidden@example.test");
    expect(html).not.toContain("invite@example.test");
    expect(html).not.toContain("Hidden team");
    expect(script).toContain('var hostedBasic = document.body.dataset.hostedSurface === "basic"');
    expect(script).toContain("if (!hostedBasic) {");
  });

  it("escapes every server-rendered account, usage, device, and checklist value", () => {
    const attack = `"><img src=x onerror=alert(1)>'&`;
    const html = renderAccountPage({
      displayName: `<script>alert("name")</script>`,
      email: attack,
      workspaceName: attack,
      workspaceId: attack,
      planName: attack,
      planStatus: attack,
      planPeriod: attack,
      usage: [{ label: attack, used: 4, limit: 9, unit: attack }],
      devices: [{ id: attack, label: attack, status: attack }],
      setup: [{ label: attack, detail: attack, complete: true }],
    });

    expect(html).toContain("&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;");
    expect(html).not.toContain(`<script>alert("name")</script>`);
    expect(html).not.toContain(attack);
    expect(html).toContain('data-complete="true"');
  });

  it("pins the exact inline style and script bytes in a strict CSP", () => {
    const html = renderAccountPage();
    const policy = csp(html);
    const styleHash = sha256Source(inlineBlock(html, "style"));
    const scriptHash = sha256Source(inlineBlock(html, "script"));

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain(`style-src '${styleHash}'`);
    expect(policy).toContain(`script-src '${scriptHash}'`);
    expect(policy).toBe(accountPageCSP(true));
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("uses only same-origin session cookies and the CSRF header for API calls", () => {
    const html = renderAccountPage();
    const script = inlineBlock(html, "script");

    expect(script).toContain('"__Host-hfg_csrf"');
    expect(script).toContain('headers.set("x-csrf-token", csrf)');
    expect(script).toContain('credentials: "same-origin"');
    expect(script).toContain('apiFetch("/v1/me")');
    expect(script).toContain('apiFetch("/v1/devices")');
    expect(script).toContain('apiFetch("/v1/devices/" + encodeURIComponent(deviceID) + "/revoke"');
    expect(script).toContain('deviceList.addEventListener("click"');
    expect(script).toContain("trigger.dataset.deviceId");
    expect(script).toContain('window.confirm(\'Revoke "\' + deviceLabel');
    expect(script).toContain('Promise.allSettled([refreshDevices(), refreshAccount()])');
    expect(script).toContain('apiFetch("/v1/auth/signout", { method: "POST" })');
    expect(script).toContain('logoutURL.origin !== "https://api.workos.com"');
    expect(script).toContain('logoutURL.pathname !== "/user_management/sessions/logout"');
    expect(script).toContain("window.top.location.assign(logoutURL.toString())");
    expect(script).toContain('apiFetch("/v1/account"');
    expect(script).toContain('method: "DELETE"');
    expect(script).toContain('window.confirm("Permanently delete this hosted account and workspace?")');
    expect(script).toContain('window.location.assign("/account?deletion=requested")');
    expect(script).not.toContain('window.location.assign("/account")');
    expect(script).toContain("body.device && body.device.token");
    expect(script).toContain('window.addEventListener("pagehide"');
    expect(script).toContain('output.textContent = ""');
    expect(script).toContain("plan.plan_id");
    expect(script).toContain('renderUsage(plan)');
    for (const field of [
      "devices",
      "device_issuances",
      "monthly_events",
      "monthly_bytes",
      "lifetime_events",
      "lifetime_bytes",
    ]) {
      expect(script).toContain(`"${field}"`);
    }
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("innerHTML");
    expect(script).not.toMatch(/authorization/i);
  });

  it("drives the team surface over the same CSRF-guarded API", () => {
    const html = renderAccountPage();
    const script = inlineBlock(html, "script");

    expect(script).toContain('apiFetch("/v1/workspace/members")');
    expect(script).toContain('apiFetch("/v1/workspace/invites")');
    expect(script).toContain('apiFetch("/v1/workspaces")');
    expect(script).toContain('apiFetch("/v1/workspace/invites/accept"');
    expect(script).toContain('apiFetch("/v1/workspace/invites/revoke"');
    // A pending invite token arrives in the URL and must not survive there.
    expect(script).toContain('params.get("invite")');
    expect(script).toContain("window.history.replaceState");
    expect(script).toContain("hideAdminControls");
    expect(script).not.toContain("document.cookie = ");
  });

  it("renders devices without embedding tokens and clamps unsafe meter numbers", () => {
    const html = renderAccountPage({
      usage: [
        { label: "Requests", used: -10, limit: -2, unit: "calls" },
        { label: "Events", used: 12, limit: 5, unit: "events" },
      ],
      devices: [
        { id: "dev_01", label: "Laptop", status: "active" },
        { id: "dev_02", label: "Retired workstation", status: "revoked" },
      ],
    });

    expect(html).toContain('<progress max="1" value="0"');
    expect(html).toContain('<progress max="5" value="5"');
    expect(html).toContain("dev_01");
    expect(html).toContain("Laptop");
    expect(html).toContain('data-device-id="dev_01"');
    expect(html).toContain('data-device-label="Laptop"');
    expect(html).toContain('aria-label="Revoke Laptop"');
    expect(html).toContain("dev_02");
    expect(html).toContain("Retired workstation");
    expect(html.match(/data-device-id=/g)).toHaveLength(1);
    expect(html.match(/>Revoke<\/button>/g)).toHaveLength(1);
    expect(html).toContain('<code id="device-token"></code>');
    expect(html).not.toContain('value="dev_');
  });

  it("renders the members section with roles, invites, and a workspace list", () => {
    const html = renderAccountPage({
      members: [
        { userId: "usr_1", email: "owner@example.com", displayName: "Ada", role: "owner" },
        { userId: "usr_2", email: "viewer@example.com", role: "viewer" },
      ],
      invites: [{ id: "inv_1", email: "pending@example.com", role: "member" }],
      workspaces: [{ workspaceId: "wsp_1", name: "Team", role: "admin", memberCount: 3 }],
    });

    expect(html).toContain('aria-labelledby="members-heading"');
    expect(html).toContain('aria-labelledby="invites-heading"');
    expect(html).toContain('<ul class="device-list" id="member-list">');
    expect(html).toContain('<ul class="device-list" id="invite-list">');
    expect(html).toContain('<ul class="device-list" id="workspace-list">');
    // The workspace list stays visible for a member whose admin card is hidden.
    expect(html).toContain('aria-labelledby="workspaces-heading"');
    expect(html).toContain('<form class="device-form invite-form" id="invite-form">');
    expect(html).toContain('<label for="invite-email">Invite by email</label>');
    expect(html).toContain('<label for="invite-role">Role</label>');
    expect(html).toContain('id="team-status" role="status" aria-live="polite"');
    expect(html).toContain('data-role="owner"');
    expect(html).toContain('data-invite-id="inv_1"');
    expect(html).toContain("3 members");
    // Ownership is never offered as an invitable role in the UI.
    expect(html).not.toContain('<option value="owner"');
    expect(html).toContain('<code id="invite-link"></code>');
  });

  it("escapes every server-rendered member, invite, and workspace value", () => {
    const attack = `"><img src=x onerror=alert(1)>'&`;
    const html = renderAccountPage({
      members: [{ userId: attack, email: attack, displayName: attack, role: attack }],
      invites: [{ id: attack, email: attack, role: attack }],
      workspaces: [{ workspaceId: attack, name: attack, role: attack, memberCount: -4 }],
    });

    expect(html).not.toContain(attack);
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;");
    expect(html).toContain("0 members");
  });

  it("keeps paid tiers visibly preview-only without a billing action", () => {
    const html = renderAccountPage();

    expect(html).toContain("Paid tiers, preview only.");
    expect(html.match(/Not available yet/g)).toHaveLength(2);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("/v1/billing");
    expect(html).not.toContain("/checkout");
  });

  it("contains no external resource, inline event handler, or style attribute", () => {
    const html = renderAccountPage();

    expect(html).not.toMatch(/<(?:script|img|link)[^>]+(?:src|href)="https?:/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(inlineBlock(html, "style")).not.toContain("url(");
    expect(() => new Function(inlineBlock(html, "script"))).not.toThrow();
  });
});

describe("renderSignedOutPage", () => {
  it("renders an accessible, no-JavaScript sign-in state", () => {
    const html = renderSignedOutPage();

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<main id="main"');
    expect(html).toContain('href="/v1/auth/start?intent=signup&amp;return_to=%2Faccount"');
    expect(html).toContain('href="/v1/auth/start?intent=signin&amp;return_to=%2Faccount"');
    expect(html).toContain("Paid tiers are preview-only");
    expect(html).not.toContain("<script>");
    expect(csp(html)).toContain("script-src 'none'");
    expect(csp(html)).toBe(accountPageCSP(false));
    expect(csp(html)).not.toContain("unsafe-inline");
  });

  it("escapes a caller-provided signed-out message", () => {
    const html = renderSignedOutPage({ message: `<img src=x onerror="alert(1)">&'` });

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
  });

  it("renders only actions the effective hosted switches can serve", () => {
    const unavailable = renderSignedOutPage({ authAvailable: false, signupAvailable: false });
    expect(unavailable).not.toContain("intent=signup");
    expect(unavailable).not.toContain("intent=signin");
    expect(unavailable).toContain("New accounts closed");
    expect(unavailable).toContain("Hosted identity unavailable");
    expect(unavailable).toContain("Hosted identity is not configured on this environment yet.");

    const signinOnly = renderSignedOutPage({ authAvailable: true, signupAvailable: false });
    expect(signinOnly).not.toContain("intent=signup");
    expect(signinOnly).toContain("intent=signin");
    expect(signinOnly).toContain("Existing beta accounts can still sign in.");
  });

  it("renders app-owned Turnstile widgets as form-integrated auth actions", () => {
    const html = renderSignedOutPage({
      authAvailable: true,
      signupAvailable: true,
      turnstileSiteKey: "0x4AAAAAAATESTKEY",
    });

    expect(html).toContain('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>');
    expect(html).toContain('data-hfg-auth-intent="signup"');
    expect(html).toContain('data-hfg-turnstile-action="auth-signup"');
    expect(html).toContain('data-action="auth-signup"');
    expect(html).toContain('data-sitekey="0x4AAAAAAATESTKEY"');
    expect(html).toContain('method="post" action="/v1/auth/start?intent=signup&amp;return_to=%2Faccount"');
    expect(html).toContain('data-hfg-turnstile-action="auth-signin"');
    expect(html).not.toContain('href="/v1/auth/start?intent=signup&amp;return_to=%2Faccount"');
    expect(csp(html)).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp(html)).toContain("connect-src 'self' https://challenges.cloudflare.com");
    expect(csp(html)).toContain("script-src https://challenges.cloudflare.com");
    expect(csp(html)).not.toContain("unsafe-inline");
  });

  it("escapes a caller-provided Turnstile site key", () => {
    const html = renderSignedOutPage({
      turnstileSiteKey: '" onfocus="alert(1)',
    });

    expect(html).not.toContain('data-sitekey="" onfocus=');
    expect(html).toContain("&quot; onfocus=&quot;alert(1)");
  });

  it("pins its inline style and has no external dependencies", () => {
    const html = renderSignedOutPage();
    const styleHash = sha256Source(inlineBlock(html, "style"));

    expect(csp(html)).toContain(`style-src '${styleHash}'`);
    expect(html).not.toMatch(/<(?:script|img|link)[^>]+(?:src|href)="https?:/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});
