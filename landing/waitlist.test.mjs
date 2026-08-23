import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BODY_BYTES,
  WAITLIST_RETENTION_SECONDS,
  handleWaitlist,
  readRequestBody,
  validateWaitlist,
} from "./waitlist.mjs";

function request(body, headers = { "content-type": "application/json" }) {
  return new Request("https://handoffgraph.dev/api/waitlist", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function respond(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

const VALID = { name: " Ada ", email: "ada@example.com" };

test("validates and normalizes a waitlist payload", () => {
  assert.deepEqual(validateWaitlist(VALID), {
    ok: true,
    value: { name: "Ada", email: "ada@example.com" },
  });
});

test("fails closed when WAITLIST storage is not bound", async () => {
  const response = await handleWaitlist(request(VALID), {}, respond);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "waitlist storage is not configured; use the email fallback",
  });
});

test("acknowledges only after KV persistence succeeds and stores allowlisted fields", async () => {
  const writes = [];
  const response = await handleWaitlist(
    request({ ...VALID, agents_used: " Claude → Codex ", received_at: "spoofed", source_ip: "spoofed", admin: true }, {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
    }),
    { WAITLIST: { put: async (key, value, options) => writes.push({ key, value, options }) } },
    respond,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(writes.length, 1);
  assert.match(writes[0].key, /^email:[a-f0-9]{64}$/);
  assert.deepEqual(writes[0].options, { expirationTtl: WAITLIST_RETENTION_SECONDS });
  const persisted = JSON.parse(writes[0].value);
  assert.equal(persisted.email, "ada@example.com");
  assert.equal(persisted.agents_used, "Claude → Codex");
  assert.notEqual(persisted.received_at, "spoofed");
  assert.equal("source_ip" in persisted, false);
  assert.equal("admin" in persisted, false);
});

test("fails closed when KV rejects the write", async () => {
  const response = await handleWaitlist(
    request(VALID),
    { WAITLIST: { put: async () => { throw new Error("unavailable"); } } },
    respond,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "storage unavailable, try again later",
  });
});

test("stream reader enforces the byte limit before buffering the full body", async () => {
  const response = await readRequestBody(request("x".repeat(MAX_BODY_BYTES + 1)), MAX_BODY_BYTES);
  assert.deepEqual(response, { ok: false, status: 413, error: "body too large" });
});
