// Framework-free hosted account page.
//
// The document is intentionally self-contained so the platform Worker can
// return it without a frontend build. Dynamic values are rendered only after
// HTML escaping; the static style and script blocks are pinned by CSP hashes.
// The eventual HTTP handler should mirror the meta policy in its response
// header and add `frame-ancestors 'none'`, which CSP does not enforce from a
// meta element.

export interface UsageMeterView {
  label?: string;
  used?: number;
  limit?: number;
  unit?: string;
}

export interface AccountDeviceView {
  id?: string;
  label?: string;
  status?: string;
}

export interface SetupItemView {
  label?: string;
  detail?: string;
  complete?: boolean;
}

export interface AccountMemberView {
  userId?: string;
  email?: string;
  displayName?: string;
  role?: string;
}

export interface AccountInviteView {
  id?: string;
  email?: string;
  role?: string;
}

export interface AccountWorkspaceView {
  workspaceId?: string;
  name?: string;
  role?: string;
  memberCount?: number;
}

export interface AccountPageData {
  hostedBasic?: boolean;
  displayName?: string;
  email?: string;
  workspaceName?: string;
  workspaceId?: string;
  planName?: string;
  planStatus?: string;
  planPeriod?: string;
  usage?: UsageMeterView[];
  devices?: AccountDeviceView[];
  setup?: SetupItemView[];
  members?: AccountMemberView[];
  invites?: AccountInviteView[];
  workspaces?: AccountWorkspaceView[];
}

export interface SignedOutPageData {
  message?: string;
  authAvailable?: boolean;
  signupAvailable?: boolean;
}

const ACCOUNT_STYLES = `
:root {
  color-scheme: light;
  --paper: #f4f1e7;
  --paper-strong: #fffdf6;
  --ink: #0a0c0f;
  --muted: #5d625f;
  --line: #b8b7ae;
  --violet: #7657ff;
  --violet-dark: #33246f;
  --acid: #c9ff2f;
  --blue: #2d68d8;
  --danger: #a42b25;
  --shadow: 8px 8px 0 var(--ink);
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

* { box-sizing: border-box; }

html { background: var(--paper); color: var(--ink); }

body {
  margin: 0;
  min-width: 0;
  min-height: 100vh;
  font-family: var(--sans);
  line-height: 1.5;
  background:
    linear-gradient(rgba(10, 12, 15, .055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(10, 12, 15, .055) 1px, transparent 1px),
    var(--paper);
  background-size: 32px 32px;
}

button, input { font: inherit; }

button, a { -webkit-tap-highlight-color: transparent; }

a { color: inherit; }

.skip-link {
  position: fixed;
  z-index: 20;
  top: 10px;
  left: 10px;
  padding: .7rem 1rem;
  border: 2px solid var(--ink);
  background: var(--acid);
  font-weight: 800;
  transform: translateY(-150%);
}

.skip-link:focus { transform: translateY(0); }

.shell { width: min(calc(100% - 32px), 1220px); margin-inline: auto; }

.site-header { padding: 18px 0; }

.nav-shell {
  display: flex;
  align-items: center;
  gap: 1rem;
  min-height: 58px;
  padding: .7rem .85rem;
  border: 1px solid var(--ink);
  border-radius: 14px;
  background: rgba(255, 253, 246, .94);
  box-shadow: 4px 4px 0 var(--ink);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: .7rem;
  text-decoration: none;
  font-weight: 850;
  letter-spacing: -.03em;
}

.brand-mark {
  display: grid;
  grid-template-columns: repeat(3, 6px);
  gap: 3px;
  align-items: end;
  width: 25px;
  height: 25px;
  padding: 4px;
  border: 1px solid var(--ink);
  background: var(--violet);
}

.brand-mark i { display: block; background: var(--acid); }
.brand-mark i:nth-child(1) { height: 7px; }
.brand-mark i:nth-child(2) { height: 14px; }
.brand-mark i:nth-child(3) { height: 10px; }

.nav-label {
  margin-left: auto;
  color: var(--muted);
  font: 750 .67rem/1 var(--mono);
  letter-spacing: .05em;
  text-transform: uppercase;
}

.button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: .45rem;
  padding: .72rem 1rem;
  border: 1px solid var(--ink);
  border-radius: 7px;
  background: var(--paper-strong);
  color: var(--ink);
  font-weight: 820;
  text-decoration: none;
  cursor: pointer;
  box-shadow: 3px 3px 0 var(--ink);
}

.button:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 var(--ink); }
.button:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--ink); }
.button.primary { background: var(--acid); }
.button.dark { background: var(--ink); color: #fff; }
.button.danger { background: var(--danger); color: #fff; }
.button:disabled { cursor: wait; opacity: .6; transform: none; }
.button.disabled { cursor: not-allowed; opacity: .68; box-shadow: none; transform: none; }

:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(260px, .85fr);
  gap: clamp(1.5rem, 5vw, 5rem);
  align-items: end;
  padding: clamp(3.5rem, 8vw, 7rem) 0 3rem;
}

.eyebrow, .kicker {
  margin: 0 0 1rem;
  font: 800 .68rem/1.2 var(--mono);
  letter-spacing: .08em;
  text-transform: uppercase;
}

.eyebrow {
  display: inline-flex;
  padding: .55rem .7rem;
  border: 1px solid var(--ink);
  border-radius: 999px;
  background: var(--acid);
}

h1, h2, h3, p { overflow-wrap: anywhere; }

h1 {
  max-width: 780px;
  margin: 0;
  font-size: clamp(3.2rem, 8vw, 7.5rem);
  line-height: .84;
  letter-spacing: -.075em;
}

h1 span { display: block; color: var(--violet); }

.hero-copy > p:last-child {
  max-width: 670px;
  margin: 1.5rem 0 0;
  color: #3d423f;
  font-size: clamp(1rem, 2vw, 1.2rem);
}

.identity-card {
  position: relative;
  padding: 1.35rem;
  border: 1px solid var(--ink);
  border-radius: 14px;
  background: var(--ink);
  color: #fff;
  box-shadow: 8px 8px 0 var(--violet);
}

.identity-card::before {
  content: "ACCOUNT";
  position: absolute;
  top: -11px;
  right: 14px;
  padding: .35rem .55rem;
  border: 1px solid var(--ink);
  background: var(--violet);
  color: #fff;
  font: 800 .61rem/1 var(--mono);
  letter-spacing: .08em;
}

.identity-card h2 { margin: .2rem 0 .25rem; font-size: 1.45rem; letter-spacing: -.035em; }
.identity-card p { margin: 0; color: #bdc1c8; }

.identity-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .8rem;
  margin: 1.3rem 0 0;
}

.identity-grid div { min-width: 0; padding-top: .8rem; border-top: 1px solid #353a42; }

dt {
  color: #9da3ac;
  font: 750 .6rem/1.2 var(--mono);
  letter-spacing: .06em;
  text-transform: uppercase;
}

dd { margin: .35rem 0 0; font-weight: 760; }

.section { padding: 2.5rem 0; }

.section-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 1.25rem;
}

.section-head h2 { margin: 0; font-size: clamp(2rem, 5vw, 4rem); line-height: .92; letter-spacing: -.06em; }
.section-head p { max-width: 490px; margin: 0; color: var(--muted); }

.grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 1rem; }

.card {
  min-width: 0;
  padding: 1.25rem;
  border: 1px solid var(--ink);
  border-radius: 12px;
  background: var(--paper-strong);
  box-shadow: 5px 5px 0 var(--ink);
}

.card h3 { margin: 0; font-size: 1.15rem; letter-spacing: -.025em; }
.card > p { color: var(--muted); }

.plan-card { grid-column: span 4; }
.usage-card { grid-column: span 8; }
.devices-card { grid-column: span 7; }
.setup-card { grid-column: span 5; }
.members-card { grid-column: span 7; }
.invites-card { grid-column: span 5; }
.workspaces-card { grid-column: 1 / -1; }
.danger-card { grid-column: 1 / -1; border-color: var(--danger); box-shadow: 5px 5px 0 var(--danger); }
.danger-card > p { max-width: 850px; }
.danger-card code { font: 750 .72rem/1.5 var(--mono); overflow-wrap: anywhere; }
.danger-list { margin: 1rem 0; padding-left: 1.2rem; color: var(--muted); }
.danger-form { max-width: 760px; }

.plan-top { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 27px;
  padding: .32rem .5rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  color: var(--violet-dark);
  background: #e7e0ff;
  font: 800 .58rem/1 var(--mono);
  letter-spacing: .05em;
  text-transform: uppercase;
  white-space: nowrap;
}

.plan-name { margin: 1.4rem 0 .2rem; font-size: 2rem; font-weight: 880; letter-spacing: -.06em; }
.plan-period { margin: 0; color: var(--muted); font: 700 .68rem/1.5 var(--mono); }

.usage-list { display: grid; gap: 1.1rem; margin-top: 1.2rem; }
.usage-row { min-width: 0; }
.usage-copy { display: flex; justify-content: space-between; gap: 1rem; margin-bottom: .4rem; }
.usage-copy strong { font-size: .9rem; }
.usage-copy span { color: var(--muted); font: 700 .68rem/1.4 var(--mono); text-align: right; }

progress {
  display: block;
  width: 100%;
  height: 13px;
  overflow: hidden;
  border: 1px solid var(--ink);
  border-radius: 999px;
  background: #dfddd5;
}

progress::-webkit-progress-bar { background: #dfddd5; }
progress::-webkit-progress-value { background: var(--violet); }
progress::-moz-progress-bar { background: var(--violet); }

.device-list { display: grid; gap: .65rem; margin: 1rem 0 1.25rem; padding: 0; list-style: none; }

.device-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: .8rem;
  align-items: center;
  padding: .9rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8f6ef;
}

.device-item strong, .device-item code { display: block; min-width: 0; }
.device-item code { margin-top: .2rem; color: var(--muted); font: 650 .64rem/1.4 var(--mono); overflow-wrap: anywhere; }
.device-meta { color: var(--muted); font: 700 .61rem/1.4 var(--mono); text-align: right; }
.device-actions { display: flex; align-items: center; justify-content: flex-end; gap: .65rem; }
.device-revoke { min-height: 38px; padding: .55rem .7rem; }
.device-empty { padding: 1rem; border: 1px dashed var(--line); color: var(--muted); }

.device-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: .7rem;
  align-items: end;
  padding-top: 1.1rem;
  border-top: 1px solid var(--line);
}

.invite-form { grid-template-columns: minmax(0, 1fr) auto auto; }

.role-pill {
  display: inline-flex;
  align-items: center;
  min-height: 27px;
  padding: .3rem .55rem;
  border: 1px solid var(--ink);
  border-radius: 999px;
  background: #e7e0ff;
  font: 800 .58rem/1 var(--mono);
  letter-spacing: .05em;
  text-transform: uppercase;
  white-space: nowrap;
}

.role-pill[data-role="owner"] { background: var(--acid); }
.role-pill[data-role="viewer"] { background: #e4e2da; }

.field select {
  width: 100%;
  min-height: 44px;
  padding: .68rem .75rem;
  border: 1px solid var(--ink);
  border-radius: 7px;
  background: #fff;
  color: var(--ink);
}

.field { min-width: 0; }
.field label { display: block; margin-bottom: .35rem; font: 800 .62rem/1.2 var(--mono); text-transform: uppercase; }
.field input {
  width: 100%;
  min-height: 44px;
  padding: .68rem .75rem;
  border: 1px solid var(--ink);
  border-radius: 7px;
  background: #fff;
  color: var(--ink);
}

.form-hint, .status { grid-column: 1 / -1; margin: 0; font-size: .78rem; color: var(--muted); }
.status[data-tone="error"] { color: var(--danger); }
.status[data-tone="success"] { color: #315800; }

.token-result {
  grid-column: 1 / -1;
  padding: .85rem;
  border: 1px solid var(--ink);
  border-radius: 7px;
  background: #15191e;
  color: #fff;
}

.token-result p { margin: 0 0 .45rem; color: #c9ced5; font-size: .77rem; }
.token-result code { display: block; color: var(--acid); font: 700 .72rem/1.5 var(--mono); overflow-wrap: anywhere; }

[hidden] { display: none !important; }

.checklist { display: grid; gap: .75rem; margin: 1rem 0 0; padding: 0; list-style: none; counter-reset: setup; }
.checklist li { position: relative; min-height: 52px; padding: .8rem .8rem .8rem 3.2rem; border-top: 1px solid var(--line); counter-increment: setup; }
.checklist li::before {
  content: counter(setup, decimal-leading-zero);
  position: absolute;
  top: .8rem;
  left: 0;
  width: 2.4rem;
  color: var(--muted);
  font: 800 .72rem/1.5 var(--mono);
}
.checklist li[data-complete="true"]::before { content: "DONE"; color: #315800; font-size: .6rem; }
.checklist strong { display: block; }
.checklist span { display: block; margin-top: .2rem; color: var(--muted); font-size: .78rem; }

.tier-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.tier-preview { position: relative; overflow: hidden; }
.tier-preview::after {
  content: "PREVIEW";
  position: absolute;
  top: 20px;
  right: -35px;
  width: 130px;
  padding: .35rem;
  transform: rotate(35deg);
  background: var(--violet);
  color: #fff;
  text-align: center;
  font: 800 .58rem/1 var(--mono);
  letter-spacing: .08em;
}
.tier-preview ul { padding-left: 1.15rem; color: var(--muted); }
.preview-control {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  padding: .65rem .8rem;
  border: 1px dashed var(--line);
  border-radius: 7px;
  color: var(--muted);
  font: 800 .62rem/1 var(--mono);
  text-transform: uppercase;
}

.account-footer {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 3rem;
  padding: 1.5rem 0 2.5rem;
  border-top: 1px solid var(--ink);
  color: var(--muted);
  font: 650 .63rem/1.5 var(--mono);
}

.signed-out-wrap { display: grid; min-height: calc(100vh - 120px); place-items: center; padding: 3rem 0 6rem; }
.signed-out-card { width: min(100%, 760px); padding: clamp(1.5rem, 6vw, 4rem); border: 1px solid var(--ink); background: var(--violet); color: #fff; box-shadow: var(--shadow); }
.signed-out-card h1 { max-width: 650px; font-size: clamp(3rem, 9vw, 6.7rem); }
.signed-out-card h1 span { color: var(--acid); }
.signed-out-card > p { max-width: 580px; color: #eeeaff; font-size: 1.05rem; }
.signed-out-actions { display: flex; flex-wrap: wrap; gap: .8rem; margin-top: 1.6rem; }

@media (max-width: 860px) {
  .hero { grid-template-columns: 1fr; }
  .plan-card, .usage-card, .devices-card, .setup-card,
  .members-card, .invites-card { grid-column: 1 / -1; }
  .section-head { display: grid; }
}

@media (max-width: 580px) {
  .shell { width: min(calc(100% - 22px), 1220px); }
  .site-header { padding-top: 11px; }
  .nav-shell { border-radius: 10px; }
  .nav-label { display: none; }
  .hero { padding-top: 2.6rem; }
  h1 { font-size: clamp(3rem, 18vw, 4.5rem); }
  .identity-grid, .tier-grid { grid-template-columns: 1fr; }
  .device-form, .invite-form { grid-template-columns: 1fr; }
  .device-item { grid-template-columns: 1fr; }
  .device-meta { text-align: left; }
  .device-actions { justify-content: space-between; }
  .account-footer { flex-direction: column; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
`;

const ACCOUNT_SCRIPT = `
(function () {
  "use strict";

  var csrfCookieName = "__Host-hfg_csrf";
  var hostedBasic = document.body.dataset.hostedSurface === "basic";

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(";") : [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      var separator = part.indexOf("=");
      if (separator < 0) continue;
      var key = part.slice(0, separator);
      try { key = decodeURIComponent(key); } catch (_) {}
      if (key !== name) continue;
      var value = part.slice(separator + 1);
      try { return decodeURIComponent(value); } catch (_) { return value; }
    }
    return "";
  }

  async function apiFetch(path, init) {
    var options = init || {};
    var headers = new Headers(options.headers || {});
    headers.set("accept", "application/json");
    var csrf = readCookie(csrfCookieName);
    if (csrf) headers.set("x-csrf-token", csrf);
    var response = await fetch(path, {
      method: options.method || "GET",
      body: options.body,
      headers: headers,
      credentials: "same-origin",
      redirect: "error"
    });
    if (!response.ok) {
      var detail = "Request failed (" + response.status + ")";
      try {
        var errorBody = await response.json();
        if (errorBody && typeof errorBody.error === "string") detail = errorBody.error;
      } catch (_) {}
      throw new Error(detail);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i += 1) {
      if (typeof arguments[i] === "string" && arguments[i].trim()) return arguments[i];
    }
    return null;
  }

  function setText(id, value) {
    if (value === null || value === undefined) return;
    var node = document.getElementById(id);
    if (node) node.textContent = String(value);
  }

  function normalizeDevices(body) {
    if (Array.isArray(body)) return body;
    return body && Array.isArray(body.devices) ? body.devices : [];
  }

  function safeMeterNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
  }

  function formatMeterValue(value, kind) {
    if (kind !== "bytes") return String(value);
    var mebibytes = value / (1024 * 1024);
    return (Number.isInteger(mebibytes) ? String(mebibytes) : mebibytes.toFixed(1)) + " MiB";
  }

  function renderUsage(entitlement) {
    var list = document.getElementById("usage-list");
    if (!list || !entitlement || typeof entitlement !== "object") return;
    var definitions = [
      ["monthly_events", "Monthly synced events", "events"],
      ["lifetime_events", "Lifetime synced events", "events"],
      ["monthly_bytes", "Monthly uploaded", "bytes"],
      ["lifetime_bytes", "Uploaded lifetime", "bytes"],
      ["devices", "Active devices", "devices"],
      ["device_issuances", "Device-token issuances", "issued"]
    ];
    var meters = definitions.filter(function (definition) {
      var meter = entitlement[definition[0]];
      return meter && typeof meter === "object" &&
        typeof meter.used === "number" && Number.isFinite(meter.used) &&
        typeof meter.limit === "number" && Number.isFinite(meter.limit);
    });
    if (!meters.length) return;
    list.replaceChildren();
    meters.forEach(function (definition, index) {
      var meter = entitlement[definition[0]];
      var used = safeMeterNumber(meter.used, 0);
      var limit = Math.max(1, safeMeterNumber(meter.limit, 1));
      var descriptionID = "live-usage-" + String(index + 1);
      var row = document.createElement("div");
      row.className = "usage-row";
      var copy = document.createElement("div");
      copy.className = "usage-copy";
      copy.id = descriptionID;
      var label = document.createElement("strong");
      label.textContent = definition[1];
      var amount = document.createElement("span");
      amount.textContent = formatMeterValue(used, definition[2]) + " / " +
        formatMeterValue(limit, definition[2]) + (definition[2] === "bytes" ? "" : " " + definition[2]);
      copy.append(label, amount);
      var progress = document.createElement("progress");
      progress.max = limit;
      progress.value = Math.min(used, limit);
      progress.setAttribute("aria-describedby", descriptionID);
      progress.textContent = String(progress.value) + " of " + String(limit);
      row.append(copy, progress);
      list.appendChild(row);
    });
  }

  function renderDevices(devices) {
    var list = document.getElementById("device-list");
    if (!list) return;
    list.replaceChildren();
    if (!devices.length) {
      var empty = document.createElement("li");
      empty.className = "device-empty";
      empty.textContent = "No hosted devices yet. Create one below; its token is shown once.";
      list.appendChild(empty);
      return;
    }
    devices.forEach(function (device) {
      var item = document.createElement("li");
      item.className = "device-item";
      var identity = document.createElement("div");
      var label = document.createElement("strong");
      var labelText = firstText(device.label, "Unnamed device");
      label.textContent = labelText;
      var id = document.createElement("code");
      var deviceID = firstText(device.id, device.device_id);
      id.textContent = firstText(deviceID, "ID pending");
      identity.append(label, id);
      var revoked = device.revoked_at !== null && device.revoked_at !== undefined;
      var statusText = firstText(device.status, revoked ? "revoked" : "active");
      var actions = document.createElement("div");
      actions.className = "device-actions";
      var meta = document.createElement("span");
      meta.className = "device-meta";
      meta.textContent = statusText;
      actions.appendChild(meta);
      if (deviceID && statusText.trim().toLowerCase() === "active") {
        var revoke = document.createElement("button");
        revoke.className = "button device-revoke";
        revoke.type = "button";
        revoke.dataset.deviceId = deviceID;
        revoke.dataset.deviceLabel = labelText;
        revoke.setAttribute("aria-label", "Revoke " + labelText);
        revoke.textContent = "Revoke";
        actions.appendChild(revoke);
      }
      item.append(identity, actions);
      list.appendChild(item);
    });
  }

  async function refreshAccount() {
    var body = await apiFetch("/v1/me");
    if (!body) return;
    var user = body.user || body.account || {};
    var workspace = body.workspace || {};
    var plan = body.plan || body.entitlement || {};
    setText("account-name", firstText(user.display_name, user.name, body.display_name));
    setText("account-email", firstText(user.email, body.email));
    setText("workspace-name", firstText(workspace.name, body.workspace_name));
    setText("workspace-id", firstText(workspace.id, workspace.workspace_id, body.workspace_id));
    setText("plan-name", firstText(plan.name, plan.plan_name, plan.code, plan.plan_id));
    setText("plan-status", firstText(plan.status));
    setText("plan-period", firstText(plan.period, plan.period_label, plan.period_end));
    renderUsage(plan);
  }

  async function refreshDevices() {
    var body = await apiFetch("/v1/devices");
    renderDevices(normalizeDevices(body));
  }

  function setStatus(message, tone) {
    var status = document.getElementById("device-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone || "";
  }

  function setTeamStatus(message, tone) {
    var status = document.getElementById("team-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone || "";
  }

  function setDeletionStatus(message, tone) {
    var status = document.getElementById("deletion-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone || "";
  }

  function itemsOf(body) {
    return body && Array.isArray(body.items) ? body.items : [];
  }

  function roleOf(value) {
    return typeof value === "string" && value ? value : "member";
  }

  function rolePill(role) {
    var pill = document.createElement("span");
    pill.className = "role-pill";
    pill.textContent = roleOf(role);
    pill.dataset.role = roleOf(role);
    return pill;
  }

  function emptyRow(message) {
    var empty = document.createElement("li");
    empty.className = "device-empty";
    empty.textContent = message;
    return empty;
  }

  function renderMembers(members) {
    var list = document.getElementById("member-list");
    if (!list) return;
    list.replaceChildren();
    if (!members.length) {
      list.appendChild(emptyRow("No teammates yet. Invite one below."));
      return;
    }
    members.forEach(function (entry) {
      var item = document.createElement("li");
      item.className = "device-item";
      var identity = document.createElement("div");
      var name = document.createElement("strong");
      name.textContent = firstText(entry.display_name, entry.email, "Teammate");
      var handle = document.createElement("code");
      handle.textContent = firstText(entry.email, entry.user_id, "");
      identity.append(name, handle);
      item.append(identity, rolePill(entry.role));
      list.appendChild(item);
    });
  }

  function renderInvites(invites) {
    var list = document.getElementById("invite-list");
    if (!list) return;
    list.replaceChildren();
    if (!invites.length) {
      list.appendChild(emptyRow("No invites are outstanding."));
      return;
    }
    invites.forEach(function (entry) {
      var item = document.createElement("li");
      item.className = "device-item";
      var identity = document.createElement("div");
      var name = document.createElement("strong");
      name.textContent = firstText(entry.email, "Pending invite");
      var meta = document.createElement("code");
      meta.textContent = firstText(entry.id, "");
      identity.append(name, meta);
      var actions = document.createElement("div");
      var revoke = document.createElement("button");
      revoke.className = "button";
      revoke.type = "button";
      revoke.dataset.inviteId = firstText(entry.id, "") || "";
      revoke.textContent = "Revoke";
      actions.append(rolePill(entry.role), revoke);
      item.append(identity, actions);
      list.appendChild(item);
    });
  }

  function renderWorkspaces(workspaces) {
    var list = document.getElementById("workspace-list");
    if (!list) return;
    list.replaceChildren();
    if (!workspaces.length) {
      list.appendChild(emptyRow("Only your personal workspace so far."));
      return;
    }
    workspaces.forEach(function (entry) {
      var item = document.createElement("li");
      item.className = "device-item";
      var identity = document.createElement("div");
      var name = document.createElement("strong");
      name.textContent = firstText(entry.name, entry.workspace_id, "Workspace");
      var meta = document.createElement("code");
      var count = typeof entry.member_count === "number" ? entry.member_count : 1;
      meta.textContent = String(count) + (count === 1 ? " member" : " members");
      identity.append(name, meta);
      item.append(identity, rolePill(entry.role));
      list.appendChild(item);
    });
  }

  function hideAdminControls() {
    var card = document.getElementById("invites-card");
    var form = document.getElementById("invite-form");
    if (card) card.hidden = true;
    if (form) form.hidden = true;
  }

  async function refreshTeam() {
    var results = await Promise.allSettled([
      apiFetch("/v1/workspace/members"),
      apiFetch("/v1/workspace/invites"),
      apiFetch("/v1/workspaces")
    ]);
    if (results[0].status === "fulfilled") renderMembers(itemsOf(results[0].value));
    if (results[1].status === "fulfilled") renderInvites(itemsOf(results[1].value));
    else hideAdminControls();
    if (results[2].status === "fulfilled") renderWorkspaces(itemsOf(results[2].value));
  }

  async function acceptPendingInvite() {
    var params = new URLSearchParams(window.location.search);
    var token = params.get("invite");
    if (!token) return;
    // The invite token is a bearer credential: drop it from the address bar
    // and the history entry before doing anything else with it.
    window.history.replaceState({}, "", window.location.pathname);
    setTeamStatus("Joining the workspace…", "");
    try {
      var body = await apiFetch("/v1/workspace/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token })
      });
      var workspace = (body && body.workspace) || {};
      setTeamStatus(
        "Joined " + firstText(workspace.name, "the workspace") + " as " +
          roleOf(body && body.role) + ".",
        "success"
      );
    } catch (error) {
      setTeamStatus(
        error instanceof Error ? error.message : "This invite could not be accepted.",
        "error"
      );
    }
  }

  var inviteList = document.getElementById("invite-list");
  if (inviteList) {
    inviteList.addEventListener("click", async function (event) {
      var trigger = event.target;
      if (!trigger || !trigger.dataset || !trigger.dataset.inviteId) return;
      trigger.disabled = true;
      try {
        await apiFetch("/v1/workspace/invites/revoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invite_id: trigger.dataset.inviteId })
        });
        setTeamStatus("Invite revoked.", "success");
        await refreshTeam();
      } catch (error) {
        trigger.disabled = false;
        setTeamStatus(
          error instanceof Error ? error.message : "The invite could not be revoked.",
          "error"
        );
      }
    });
  }

  var inviteForm = document.getElementById("invite-form");
  if (inviteForm) {
    inviteForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var emailField = document.getElementById("invite-email");
      var roleField = document.getElementById("invite-role");
      var submit = document.getElementById("invite-submit");
      var result = document.getElementById("invite-result");
      var output = document.getElementById("invite-link");
      var email = emailField && "value" in emailField ? emailField.value.trim() : "";
      var role = roleField && "value" in roleField ? roleField.value : "member";
      if (!email) {
        setTeamStatus("Enter the address to invite.", "error");
        if (emailField) emailField.focus();
        return;
      }
      if (submit) submit.disabled = true;
      setTeamStatus("Creating a single-use invite…", "");
      try {
        var body = await apiFetch("/v1/workspace/invites", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email, role: role })
        });
        var invite = (body && body.invite) || {};
        var link = firstText(invite.invite_url, invite.token);
        if (!link) throw new Error("The invite was created without a shareable link.");
        if (output) output.textContent = link;
        if (result) result.hidden = false;
        if (emailField && "value" in emailField) emailField.value = "";
        setTeamStatus("Invite ready. Send this link now; it is shown once.", "success");
        await refreshTeam();
      } catch (error) {
        setTeamStatus(
          error instanceof Error ? error.message : "The invite could not be created.",
          "error"
        );
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  var deviceForm = document.getElementById("device-form");
  var deviceList = document.getElementById("device-list");
  if (deviceList) {
    deviceList.addEventListener("click", async function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var trigger = target.closest("[data-device-id]");
      if (!trigger || !deviceList.contains(trigger)) return;
      var deviceID = trigger.dataset.deviceId;
      if (!deviceID) return;
      var deviceLabel = firstText(trigger.dataset.deviceLabel, "this device");
      if (!window.confirm('Revoke "' + deviceLabel + '"? Its token will stop syncing immediately.')) return;

      trigger.disabled = true;
      setStatus("Revoking " + deviceLabel + "…", "");
      try {
        await apiFetch("/v1/devices/" + encodeURIComponent(deviceID) + "/revoke", {
          method: "POST"
        });
      } catch (error) {
        trigger.disabled = false;
        setStatus(
          error instanceof Error ? error.message : "The device could not be revoked.",
          "error"
        );
        return;
      }

      trigger.textContent = "Revoked";
      delete trigger.dataset.deviceId;
      var row = trigger.closest(".device-item");
      var meta = row ? row.querySelector(".device-meta") : null;
      if (meta) meta.textContent = "revoked";
      setStatus(deviceLabel + " revoked. Its device token can no longer sync.", "success");
      var refreshed = await Promise.allSettled([refreshDevices(), refreshAccount()]);
      if (refreshed.some(function (result) { return result.status === "rejected"; })) {
        setStatus(
          deviceLabel + " was revoked, but the account state could not be refreshed. Reload this page.",
          "error"
        );
      }
    });
  }

  if (deviceForm) {
    deviceForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var input = document.getElementById("device-label");
      var submit = document.getElementById("device-submit");
      var result = document.getElementById("token-result");
      var output = document.getElementById("device-token");
      var label = input && "value" in input ? input.value.trim() : "";
      if (!label) {
        setStatus("Enter a label for this device.", "error");
        if (input) input.focus();
        return;
      }
      if (submit) submit.disabled = true;
      setStatus("Creating a scoped device token…", "");
      try {
        var body = await apiFetch("/v1/devices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: label })
        });
        var token = body && firstText(body.token, body.device_token, body.device && body.device.token);
        if (!token) throw new Error("The device was created without a displayable token.");
        if (output) output.textContent = token;
        if (result) result.hidden = false;
        if (input && "value" in input) input.value = "";
        setStatus("Device created. Save the token now; it will not be shown again.", "success");
        await refreshDevices();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Unable to create the device.", "error");
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  var deletionForm = document.getElementById("deletion-form");
  if (deletionForm) {
    var deletionInput = document.getElementById("deletion-confirmation");
    var deletionSubmit = document.getElementById("deletion-submit");
    var phraseNode = document.getElementById("deletion-confirmation-phrase");
    var deletionPhrase = phraseNode ? phraseNode.textContent || "" : "";
    var syncDeletionButton = function () {
      var value = deletionInput && "value" in deletionInput ? deletionInput.value : "";
      if (deletionSubmit) deletionSubmit.disabled = value !== deletionPhrase;
    };
    if (deletionInput) deletionInput.addEventListener("input", syncDeletionButton);
    syncDeletionButton();
    deletionForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var value = deletionInput && "value" in deletionInput ? deletionInput.value : "";
      if (value !== deletionPhrase) {
        setDeletionStatus("Type the confirmation phrase exactly.", "error");
        if (deletionInput) deletionInput.focus();
        return;
      }
      if (!window.confirm("Permanently delete this hosted account and workspace?")) return;
      if (deletionSubmit) deletionSubmit.disabled = true;
      setDeletionStatus("Revoking credentials and starting the private-data purge…", "");
      try {
        await apiFetch("/v1/account", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: value })
        });
        window.location.assign("/account?deletion=requested");
      } catch (error) {
        setDeletionStatus(
          error instanceof Error ? error.message : "Account deletion could not be started.",
          "error"
        );
        syncDeletionButton();
      }
    });
  }

  window.addEventListener("pagehide", function () {
    var output = document.getElementById("device-token");
    var result = document.getElementById("token-result");
    if (output) output.textContent = "";
    if (result) result.hidden = true;
    var inviteOutput = document.getElementById("invite-link");
    var inviteResult = document.getElementById("invite-result");
    if (inviteOutput) inviteOutput.textContent = "";
    if (inviteResult) inviteResult.hidden = true;
  });

  var signOut = document.getElementById("sign-out");
  if (signOut) {
    signOut.addEventListener("click", async function () {
      signOut.disabled = true;
      try {
        var body = await apiFetch("/v1/auth/signout", { method: "POST" });
        var logoutURL = new URL(firstText(body && body.logout_url, ""));
        if (
          logoutURL.origin !== "https://api.workos.com" ||
          logoutURL.pathname !== "/user_management/sessions/logout" ||
          logoutURL.username !== "" ||
          logoutURL.password !== "" ||
          logoutURL.hash !== ""
        ) {
          throw new Error("The sign-out destination was invalid.");
        }
        window.top.location.assign(logoutURL.toString());
      } catch (_) {
        signOut.disabled = false;
        setStatus("Sign out failed. Please try again.", "error");
      }
    });
  }

  async function refreshAll() {
    var results = await Promise.allSettled([refreshAccount(), refreshDevices()]);
    if (results[0].status === "rejected") setStatus("Account details could not be refreshed.", "error");
    if (results[1].status === "rejected") setStatus("Devices could not be refreshed.", "error");
    if (!hostedBasic) {
      await acceptPendingInvite();
      await refreshTeam();
    }
  }

  void refreshAll();
})();
`;

// Tests recompute these hashes from the exact constants above. Keep them in
// sync whenever either inline block changes.
const STYLE_CSP_HASH = "sha256-XadL2GtcwqU2wT3mVlcf+srMZMJTKCdUCFaMp2veTqY=";
const SCRIPT_CSP_HASH = "sha256-4INW7eCrv1sG5Jl/CBAi1AzoOsSZ3UxxeY1EJyT8jik=";

function escapeHTML(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function usageRows(usage: UsageMeterView[] | undefined): string {
  const source = usage && usage.length > 0
    ? usage
    : [
        { label: "Monthly synced events", used: 0, limit: 5_000, unit: "events" },
        { label: "Lifetime synced events", used: 0, limit: 25_000, unit: "events" },
        { label: "Uploaded lifetime", used: 0, limit: 64, unit: "MiB" },
        { label: "Active devices", used: 0, limit: 2, unit: "devices" },
        { label: "Device-token issuances", used: 0, limit: 10, unit: "issued lifetime" },
      ];

  return source.map((meter, index) => {
    const used = nonNegative(meter.used, 0);
    const limit = Math.max(1, nonNegative(meter.limit, 1));
    const progressValue = Math.min(used, limit);
    const label = text(meter.label, `Usage ${index + 1}`);
    const unit = text(meter.unit, "units");
    const descriptionID = `usage-${index + 1}`;
    return `<div class="usage-row">
      <div class="usage-copy" id="${descriptionID}"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(used)} / ${escapeHTML(limit)} ${escapeHTML(unit)}</span></div>
      <progress max="${escapeHTML(limit)}" value="${escapeHTML(progressValue)}" aria-describedby="${descriptionID}">${escapeHTML(progressValue)} of ${escapeHTML(limit)}</progress>
    </div>`;
  }).join("");
}

function deviceRows(devices: AccountDeviceView[] | undefined): string {
  if (!devices || devices.length === 0) {
    return '<li class="device-empty">No hosted devices yet. Create one below; its token is shown once.</li>';
  }
  return devices.map((device) => {
    const label = text(device.label, "Unnamed device");
    const id = text(device.id, "ID pending");
    const status = text(device.status, "active");
    const revoke = status.trim().toLowerCase() === "active" && device.id
      ? `<button class="button device-revoke" type="button" data-device-id="${escapeHTML(device.id)}" data-device-label="${escapeHTML(label)}" aria-label="Revoke ${escapeHTML(label)}">Revoke</button>`
      : "";
    return `<li class="device-item"><div><strong>${escapeHTML(label)}</strong><code>${escapeHTML(id)}</code></div><div class="device-actions"><span class="device-meta">${escapeHTML(status)}</span>${revoke}</div></li>`;
  }).join("");
}

function rolePill(role: unknown): string {
  const value = text(role, "member");
  return `<span class="role-pill" data-role="${escapeHTML(value)}">${escapeHTML(value)}</span>`;
}

function memberRows(members: AccountMemberView[] | undefined): string {
  if (!members || members.length === 0) {
    return '<li class="device-empty">No teammates yet. Invite one below.</li>';
  }
  return members.map((entry) => {
    const name = text(entry.displayName, text(entry.email, "Teammate"));
    const handle = text(entry.email, text(entry.userId, ""));
    return `<li class="device-item"><div><strong>${escapeHTML(name)}</strong><code>${escapeHTML(handle)}</code></div>${rolePill(entry.role)}</li>`;
  }).join("");
}

function inviteRows(invites: AccountInviteView[] | undefined): string {
  if (!invites || invites.length === 0) {
    return '<li class="device-empty">No invites are outstanding.</li>';
  }
  return invites.map((entry) => {
    const email = text(entry.email, "Pending invite");
    const id = text(entry.id, "");
    return `<li class="device-item"><div><strong>${escapeHTML(email)}</strong><code>${escapeHTML(id)}</code></div><div>${rolePill(entry.role)}<button class="button" type="button" data-invite-id="${escapeHTML(id)}">Revoke</button></div></li>`;
  }).join("");
}

function workspaceRows(workspaces: AccountWorkspaceView[] | undefined): string {
  if (!workspaces || workspaces.length === 0) {
    return '<li class="device-empty">Only your personal workspace so far.</li>';
  }
  return workspaces.map((entry) => {
    const name = text(entry.name, text(entry.workspaceId, "Workspace"));
    const count = nonNegative(entry.memberCount, 1);
    const label = `${count} ${count === 1 ? "member" : "members"}`;
    return `<li class="device-item"><div><strong>${escapeHTML(name)}</strong><code>${escapeHTML(label)}</code></div>${rolePill(entry.role)}</li>`;
  }).join("");
}

function setupRows(setup: SetupItemView[] | undefined, deviceCount: number): string {
  const source = setup && setup.length > 0
    ? setup
    : [
        { label: "Install the local CLI", detail: "Keep capture local and account-free.", complete: false },
        { label: "Create a device token", detail: "Use one scoped token per machine.", complete: deviceCount > 0 },
        { label: "Review redaction", detail: "Run handoffgraph sync --preview before any upload.", complete: false },
        { label: "Sync the first batch", detail: "Run handoffgraph sync --accept-redaction after approving the preview.", complete: false },
      ];

  return source.map((item) => `<li data-complete="${item.complete === true ? "true" : "false"}"><strong>${escapeHTML(text(item.label, "Setup step"))}</strong><span>${escapeHTML(text(item.detail, "Not completed yet."))}</span></li>`).join("");
}

export function accountPageCSP(includeScript: boolean): string {
  const script = includeScript ? `'${SCRIPT_CSP_HASH}'` : "'none'";
  return `default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'self'; img-src 'none'; font-src 'none'; media-src 'none'; worker-src 'none'; connect-src 'self'; style-src '${STYLE_CSP_HASH}'; script-src ${script}; upgrade-insecure-requests`;
}

function documentStart(title: string, includeScript: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="${accountPageCSP(includeScript)}">
  <title>${escapeHTML(title)}</title>
  <style>${ACCOUNT_STYLES}</style>
</head>`;
}

function brandHeader(account: boolean): string {
  return `<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header shell">
  <nav class="nav-shell" aria-label="Account navigation">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>HandoffGraph</span></a>
    <span class="nav-label">${account ? "Hosted account" : "Limited hosted beta"}</span>
    ${account ? '<button class="button" id="sign-out" type="button">Sign out</button>' : '<a class="button" href="/">Back to home</a>'}
  </nav>
</header>`;
}

/** Render the signed-in hosted account shell with safely escaped initial data. */
export function renderAccountPage(data: AccountPageData = {}): string {
  const hostedBasic = data.hostedBasic === true;
  const displayName = text(data.displayName, "Your account");
  const email = text(data.email, "Email unavailable");
  const workspaceName = text(data.workspaceName, "Hosted workspace");
  const workspaceId = text(data.workspaceId, "Workspace pending");
  const planName = text(data.planName, "Basic beta");
  const planStatus = text(data.planStatus, "Active");
  const planPeriod = text(data.planPeriod, "No billing enabled");
  const devices = data.devices ?? [];
  const members = data.members;
  const invites = data.invites;
  const workspaces = data.workspaces;
  const teamSection = hostedBasic ? "" : `
  <section class="section" aria-labelledby="team-title">
    <div class="section-head"><div><p class="kicker">Team</p><h2 id="team-title">Onboard people, not machines.</h2></div><p>Roles are owner, admin, member, and viewer. Invites are single-use links bound to one address, and every membership change is appended to the workspace audit trail.</p></div>
    <div class="grid">
      <article class="card members-card" aria-labelledby="members-heading">
        <h3 id="members-heading">Members</h3>
        <ul class="device-list" id="member-list">${memberRows(members)}</ul>
        <form class="device-form invite-form" id="invite-form">
          <div class="field"><label for="invite-email">Invite by email</label><input id="invite-email" name="email" type="email" maxlength="254" autocomplete="off" placeholder="teammate@example.com" required></div>
          <div class="field"><label for="invite-role">Role</label><select id="invite-role" name="role"><option value="member" selected>member</option><option value="admin">admin</option><option value="viewer">viewer</option></select></div>
          <button class="button primary" id="invite-submit" type="submit">Send invite</button>
          <p class="form-hint" id="invite-hint">Ownership is never granted by a link. The invite URL is returned once.</p>
          <p class="status" id="team-status" role="status" aria-live="polite"></p>
          <div class="token-result" id="invite-result" role="region" aria-label="New invite link" hidden><p>Send this link to the invited address now. It is not saved in this browser and disappears when you leave the page.</p><code id="invite-link"></code></div>
        </form>
      </article>
      <article class="card invites-card" id="invites-card" aria-labelledby="invites-heading">
        <h3 id="invites-heading">Pending invites</h3>
        <ul class="device-list" id="invite-list">${inviteRows(invites)}</ul>
        <p>Each link works once, for the invited address only, and expires after seven days.</p>
      </article>
      <article class="card workspaces-card" aria-labelledby="workspaces-heading">
        <h3 id="workspaces-heading">Your workspaces</h3>
        <ul class="device-list" id="workspace-list">${workspaceRows(workspaces)}</ul>
      </article>
    </div>
  </section>`;
  const relationshipWarning = hostedBasic
    ? ""
    : "<li>If another workspace still references this account, deletion stops before the purge; contact support to resolve that link.</li>";

  return `${documentStart("Account · HandoffGraph", true)}
<body data-hosted-surface="${hostedBasic ? "basic" : "advanced"}">
${brandHeader(true)}
<main id="main" class="shell">
  <section class="hero" aria-labelledby="account-title">
    <div class="hero-copy">
      <p class="eyebrow">Limited beta · local-first</p>
      <h1 id="account-title">Your proof,<span>on your terms.</span></h1>
      <p>Manage hosted sync without changing the local-first contract. Device tokens stay scoped, redaction stays fail-closed, and paid tiers remain a preview until billing is ready.</p>
    </div>
    <aside class="identity-card" aria-labelledby="identity-title">
      <p class="kicker">Signed in as</p>
      <h2 id="identity-title"><span id="account-name">${escapeHTML(displayName)}</span></h2>
      <p id="account-email">${escapeHTML(email)}</p>
      <dl class="identity-grid">
        <div><dt>Workspace</dt><dd id="workspace-name">${escapeHTML(workspaceName)}</dd></div>
        <div><dt>Workspace ID</dt><dd id="workspace-id">${escapeHTML(workspaceId)}</dd></div>
      </dl>
    </aside>
  </section>

  <section class="section" aria-labelledby="overview-title">
    <div class="section-head"><div><p class="kicker">Account overview</p><h2 id="overview-title">Bounded by design.</h2></div><p>Usage meters are product guardrails, not a reason to upload more. Local capture remains available without an account.</p></div>
    <div class="grid">
      <article class="card plan-card" aria-labelledby="plan-heading">
        <div class="plan-top"><h3 id="plan-heading">Current plan</h3><span class="badge" id="plan-status">${escapeHTML(planStatus)}</span></div>
        <p class="plan-name" id="plan-name">${escapeHTML(planName)}</p>
        <p class="plan-period" id="plan-period">${escapeHTML(planPeriod)}</p>
        <p>Hard limits are checked before hosted writes. Local capture and local export remain available if a hosted limit is reached.</p>
      </article>
      <article class="card usage-card" aria-labelledby="usage-heading">
        <h3 id="usage-heading">This period</h3>
        <div class="usage-list" id="usage-list">${usageRows(data.usage)}</div>
      </article>
    </div>
  </section>

  <section class="section" aria-labelledby="access-title">
    <div class="section-head"><div><p class="kicker">Scoped access</p><h2 id="access-title">One machine. One scoped token.</h2></div><p>Basic allows 2 active devices and 10 device-token issuances over the account lifetime. Tokens are returned once, never stored in this browser, and should be revoked when a machine is retired.</p></div>
    <div class="grid">
      <article class="card devices-card" aria-labelledby="devices-heading">
        <h3 id="devices-heading">Devices</h3>
        <ul class="device-list" id="device-list">${deviceRows(devices)}</ul>
        <form class="device-form" id="device-form">
          <div class="field"><label for="device-label">Device label</label><input id="device-label" name="label" type="text" minlength="1" maxlength="80" autocomplete="off" placeholder="Arbaz’s MacBook" required></div>
          <button class="button primary" id="device-submit" type="submit">Create device</button>
          <p class="form-hint" id="device-hint">Use a recognizable label. The API returns the token once.</p>
          <p class="status" id="device-status" role="status" aria-live="polite"></p>
          <div class="token-result" id="token-result" role="region" aria-label="New device token" hidden><p>Copy this token into the CLI now. It is not saved to local storage and will disappear when you leave this page.</p><code id="device-token"></code></div>
        </form>
      </article>
      <article class="card setup-card" aria-labelledby="setup-heading">
        <h3 id="setup-heading">Setup checklist</h3>
        <ol class="checklist">${setupRows(data.setup, devices.length)}</ol>
      </article>
    </div>
  </section>

${teamSection}

  <section class="section" aria-labelledby="privacy-title">
    <div class="section-head"><div><p class="kicker">Privacy controls</p><h2 id="privacy-title">Delete the hosted copy.</h2></div><p>Local HandoffGraph data stays on your machines. This action affects only this hosted account and its personal workspace.</p></div>
    <div class="grid">
      <article class="card danger-card" aria-labelledby="deletion-heading">
        <h3 id="deletion-heading">Delete account and workspace</h3>
        <p>This is permanent. It revokes every browser session and device token, then removes the workspace’s D1 rows and R2 objects. It does not delete local event stores or refund the limited-beta account issuance.</p>
        <ul class="danger-list"><li>Export anything you need before continuing.</li><li>This deletes only the hosted personal workspace; local stores stay on your machines.</li>${relationshipWarning}</ul>
        <form class="device-form danger-form" id="deletion-form">
          <div class="field"><label for="deletion-confirmation">Type <code id="deletion-confirmation-phrase">DELETE ${escapeHTML(workspaceId)}</code></label><input id="deletion-confirmation" name="confirmation" type="text" autocomplete="off" spellcheck="false" required></div>
          <button class="button danger" id="deletion-submit" type="submit" disabled>Delete permanently</button>
          <p class="form-hint">A transient storage failure leaves a locked deletion job for automatic retry; it never widens the purge to another workspace.</p>
          <p class="status" id="deletion-status" role="status" aria-live="polite"></p>
        </form>
      </article>
    </div>
  </section>

  <section class="section" aria-labelledby="tiers-title">
    <div class="section-head"><div><p class="kicker">Coming later</p><h2 id="tiers-title">Paid tiers, preview only.</h2></div><p>No checkout is active in this build. Limits and pricing stay provisional until hosted-beta cost data is measured.</p></div>
    <div class="tier-grid">
      <article class="card tier-preview"><span class="badge">Paid preview</span><h3>Solo Cloud</h3><p>For one developer who wants a larger private sync envelope.</p><ul><li>Higher event and storage limits</li><li>Longer hosted history</li><li>Priority beta feedback</li></ul><span class="preview-control" aria-disabled="true">Not available yet</span></article>
      <article class="card tier-preview"><span class="badge">Paid preview</span><h3>Team</h3><p>For shared review after cross-tenant and collaboration gates pass.</p><ul><li>Shared workspaces</li><li>Role-based device management</li><li>Review and acknowledgement</li></ul><span class="preview-control" aria-disabled="true">Not available yet</span></article>
    </div>
  </section>
</main>
<footer class="account-footer shell"><span>Apache-2.0 local core · hosted beta is separate</span><span>Evidence: OBSERVED / DECLARED / INFERRED</span></footer>
<script>${ACCOUNT_SCRIPT}</script>
</body>
</html>`;
}

/** Render the public signed-out state without loading or executing JavaScript. */
export function renderSignedOutPage(data: SignedOutPageData = {}): string {
  const message = text(
    data.message,
    "Sign in to manage hosted sync, scoped device tokens, and beta usage. The local CLI remains account-free.",
  );
  const authAvailable = data.authAvailable ?? true;
  const signupAvailable = authAvailable && (data.signupAvailable ?? true);
  const signupAction = signupAvailable
    ? '<a class="button primary" href="/v1/auth/start?intent=signup&amp;return_to=%2Faccount">Create hosted account</a>'
    : '<span class="button disabled" aria-disabled="true">New accounts closed</span>';
  const signinAction = authAvailable
    ? '<a class="button dark" href="/v1/auth/start?intent=signin&amp;return_to=%2Faccount">Sign in</a>'
    : '<span class="button disabled" aria-disabled="true">Hosted identity unavailable</span>';
  const accessNote = !authAvailable
    ? "Hosted identity is not configured on this environment yet."
    : signupAvailable
      ? "Paid tiers are preview-only. Signing in does not start a subscription."
      : "New-account access is closed. Existing beta accounts can still sign in.";
  return `${documentStart("Sign in · HandoffGraph", false)}
<body>
${brandHeader(false)}
<main id="main" class="signed-out-wrap shell">
  <section class="signed-out-card" aria-labelledby="signed-out-title">
    <p class="kicker">Hosted beta</p>
    <h1 id="signed-out-title">Keep the thread.<span>Control the cloud.</span></h1>
    <p>${escapeHTML(message)}</p>
    <div class="signed-out-actions">${signupAction}${signinAction}<a class="button dark" href="/">Use HandoffGraph locally</a></div>
    <p><small>${escapeHTML(accessNote)}</small></p>
  </section>
</main>
</body>
</html>`;
}
