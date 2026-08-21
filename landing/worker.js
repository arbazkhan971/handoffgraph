// HandoffGraph landing worker — handoffgraph.dev
//
// No build step: wrangler bundles this file directly and inlines
// landing/index.html as text via the `rules` entry in wrangler.toml.
//
// Routes:
//   GET  /               → index.html (with security headers)
//   GET  /index.html     → same
//   OPTIONS /api/waitlist → CORS preflight
//   POST /api/waitlist   → validate JSON body → 202 (persists to KV if bound)
//   anything else        → 404 (JSON)
//
// The WAITLIST KV binding is OPTIONAL: when it is not bound, submissions are
// validated and acknowledged (202) but not persisted. To enable it, add to
// wrangler.toml:
//
//   [[kv_namespaces]]
//   binding = "WAITLIST"
//   id = "<kv-namespace-id>"

import indexHTML from "./index.html";

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self' 'unsafe-inline'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const MAX_BODY_BYTES = 16 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function jsonResponse(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

function serveIndex(method) {
  return new Response(method === "HEAD" ? null : indexHTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...SECURITY_HEADERS,
    },
  });
}

function isNonEmptyString(value, maxLen) {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= maxLen;
}

// Validate a waitlist payload. Returns { ok: true, value } or { ok: false, error }.
function validateWaitlist(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  if (!isNonEmptyString(payload.name, 200)) {
    return { ok: false, error: "name is required (1-200 characters)" };
  }
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (email.length > 320 || !EMAIL_RE.test(email)) {
    return { ok: false, error: "a valid email address is required" };
  }
  const limits = {
    agents_used: 200,
    weekly_sessions: 200,
    team_size: 200,
    context_loss_incident: 4000,
  };
  for (const [field, maxLen] of Object.entries(limits)) {
    const v = payload[field];
    if (v !== undefined && v !== null && v !== "" &&
        (typeof v !== "string" || v.trim().length > maxLen)) {
      return { ok: false, error: `${field} must be a string of at most ${maxLen} characters` };
    }
  }
  return { ok: true, value: { ...payload, name: payload.name.trim(), email } };
}

async function handleWaitlist(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse({ ok: false, error: "content-type must be application/json" }, 415, CORS_HEADERS);
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse({ ok: false, error: "unreadable request body" }, 400, CORS_HEADERS);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: "body too large" }, 413, CORS_HEADERS);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return jsonResponse({ ok: false, error: "invalid JSON" }, 400, CORS_HEADERS);
  }
  const result = validateWaitlist(payload);
  if (!result.ok) {
    return jsonResponse({ ok: false, error: result.error }, 400, CORS_HEADERS);
  }
  if (env.WAITLIST) {
    const key = `${new Date().toISOString().slice(0, 10)}:${crypto.randomUUID()}`;
    const record = JSON.stringify({
      received_at: new Date().toISOString(),
      source_ip: request.headers.get("cf-connecting-ip") || null,
      ...result.value,
    });
    try {
      await env.WAITLIST.put(key, record);
    } catch (err) {
      // Fail closed: never acknowledge (202) a submission we failed to persist.
      return jsonResponse({ ok: false, error: "storage unavailable, try again later" }, 503, CORS_HEADERS);
    }
  }
  // No WAITLIST binding → validated and acknowledged, but not persisted
  // (the KV binding is optional by design; see the comment at the top).
  return jsonResponse({ ok: true }, 202, CORS_HEADERS);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if ((request.method === "GET" || request.method === "HEAD") &&
        (path === "/" || path === "/index.html")) {
      return serveIndex(request.method);
    }

    if (path === "/api/waitlist") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...CORS_HEADERS, ...SECURITY_HEADERS } });
      }
      if (request.method === "POST") {
        return handleWaitlist(request, env);
      }
      return jsonResponse({ ok: false, error: "method not allowed" }, 405, {
        ...CORS_HEADERS,
        allow: "POST, OPTIONS",
      });
    }

    return jsonResponse({ ok: false, error: "not found" }, 404);
  },
};
