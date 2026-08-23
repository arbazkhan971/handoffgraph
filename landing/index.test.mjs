import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const favicon = await readFile(new URL("./favicon.png", import.meta.url));
const ogImage = await readFile(new URL("./og.png", import.meta.url));
const worker = await readFile(new URL("./worker.js", import.meta.url), "utf8");

function planMarkup(name) {
  const match = html.match(new RegExp(`<article[^>]+data-plan="${name}"[\\s\\S]*?<\\/article>`));
  assert.ok(match, `missing ${name} pricing card`);
  return match[0];
}

test("landing page ships the product-led handoff story and honest links", () => {
  assert.match(html, /<h1[^>]*>Hand off the work\./);
  assert.match(html, /data-demo-stage="interrupted"/);
  assert.match(html, /data-demo-stage="checkpointed"/);
  assert.match(html, /data-demo-stage="acknowledged"/);
  assert.match(html, /Printed invocation · not auto-run/);
  assert.match(html, /github\.com\/arbazkhan971\/handoffgraph/);
  assert.doesNotMatch(html, /github\.com\/handoffgraph\/handoffgraph/);
  assert.doesNotMatch(html, /<svg\b/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.match(html, /<meta property="og:image" content="https:\/\/handoffgraph\.dev\/og\.png">/);
  assert.match(html, /<link rel="icon" href="\/favicon\.png" type="image\/png" sizes="64x64">/);
});

test("waitlist markup preserves the API contract and a safe no-JS floor", () => {
  for (const name of [
    "name",
    "email",
    "agents_used",
    "weekly_sessions",
    "team_size",
    "context_loss_incident",
  ]) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /fetch\('\/api\/waitlist'/);
  assert.match(html, /response\.status===202&&body\.ok===true/);
  assert.match(html, /\.no-js \.waitlist-form>:not\(noscript\)/);
  assert.match(html, /mailto:hello@handoffgraph\.dev/);
});

test("pricing keeps Local Core free and Hosted Basic explicitly bounded", () => {
  const local = planMarkup("local-core");
  assert.match(local, /<h3>Local Core<\/h3>/);
  assert.match(local, /<strong>\$0<\/strong><span>forever<\/span>/);
  assert.match(local, /without an account/);
  assert.match(local, /unlimited local data on your own disk/);

  const basic = planMarkup("hosted-basic");
  assert.match(basic, /Free · hosted beta/);
  assert.match(basic, /1 personal workspace, 2 active devices/);
  assert.match(basic, /10 device-token issuances lifetime/);
  assert.doesNotMatch(basic, /repositor/i);
  assert.match(basic, /5,000 synced events per month/);
  assert.match(basic, /25,000 synced events lifetime/);
  assert.match(basic, /64 MiB uploaded lifetime/);
  assert.match(basic, /Bounded, validated event sync/);
  assert.match(basic, /Redaction failures are rejected/);
  assert.match(basic, /local capture never stops/);
  assert.doesNotMatch(basic, /Checkpoint and metadata only/);
  assert.doesNotMatch(html, /metadata-only/i);
});

test("public signup stays on the beta list while existing-account sign-in is reachable", () => {
  assert.match(html, /href="https:\/\/api\.handoffgraph\.dev\/v1\/auth\/start\?intent=signin">Sign in<\/a>/);
  assert.match(html, /href="#waitlist">Request hosted access<\/a>/);
  const basic = planMarkup("hosted-basic");
  assert.match(basic, /href="#waitlist">Request Hosted Basic access<\/a>/);
  assert.match(basic, /href="https:\/\/api\.handoffgraph\.dev\/v1\/auth\/start\?intent=signin"/);
  assert.doesNotMatch(basic, /intent=signup/);
});

test("Solo and Team are visibly non-purchasable previews", () => {
  const solo = planMarkup("solo");
  assert.match(solo, /Preview · not purchasable/);
  assert.match(solo, /<strong>\$12<\/strong><span>per month<\/span>/);
  assert.match(solo, /No checkout is connected/);
  assert.doesNotMatch(solo, /href=|subscribe|buy now/i);

  const team = planMarkup("team");
  assert.match(team, /Planned · not purchasable/);
  assert.match(team, /Roadmap preview only/);
  assert.match(team, /href="#waitlist"/);
  assert.doesNotMatch(team, /\/v1\/auth\/start|checkout|subscribe|buy now/i);
});

test("debugger mock does not present CLI detections as an in-window feature", () => {
  const match = html.match(/<section class="section shell" id="debugger">[\s\S]*?<\/section>/);
  assert.ok(match, "missing debugger section");
  assert.doesNotMatch(match[0], /class="detection"|DETECTION · failed_test/);
  assert.doesNotMatch(html, /\.detection\{/);
});

test("inline scripts are syntactically valid", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 2);
  for (const [, source] of scripts) {
    assert.doesNotThrow(() => new Function(source));
    const hash = `sha256-${createHash("sha256").update(source).digest("base64")}`;
    assert.ok(html.includes(`'${hash}'`), `meta CSP is missing ${hash}`);
    assert.ok(worker.includes(`'${hash}'`), `Worker CSP is missing ${hash}`);
  }
  assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
});

test("primary landmarks and form controls have accessible names", () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /class="skip" href="#main"/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /aria-label="Primary navigation"/);
  for (const id of ["f-name", "f-email", "f-agents", "f-weekly", "f-team", "f-incident"]) {
    assert.match(html, new RegExp(`<label for="${id}">`));
  }
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
});

test("social preview is a valid 1200 by 630 PNG", () => {
  assert.deepEqual([...ogImage.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(ogImage.readUInt32BE(16), 1200);
  assert.equal(ogImage.readUInt32BE(20), 630);
});

test("favicon is a valid 64 by 64 PNG", () => {
  assert.deepEqual([...favicon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(favicon.readUInt32BE(16), 64);
  assert.equal(favicon.readUInt32BE(20), 64);
});
