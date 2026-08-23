// Waitlist validation + persistence, separated from the HTML-serving Worker
// so the fail-closed storage contract can be tested without a bundler.

export const CORS_HEADERS = {
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export const MAX_BODY_BYTES = 16 * 1024;
export const WAITLIST_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isNonEmptyString(value, maxLen) {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= maxLen;
}

/** Validate a waitlist payload without performing I/O. */
export function validateWaitlist(payload) {
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
    const value = payload[field];
    if (
      value !== undefined &&
      value !== null &&
      value !== "" &&
      (typeof value !== "string" || value.trim().length > maxLen)
    ) {
      return { ok: false, error: `${field} must be a string of at most ${maxLen} characters` };
    }
  }
  // Persist only the documented form contract. Unknown client keys and
  // server-owned metadata are discarded instead of being spread into KV.
  const value = { name: payload.name.trim(), email };
  for (const field of Object.keys(limits)) {
    if (typeof payload[field] === "string" && payload[field].trim() !== "") {
      value[field] = payload[field].trim();
    }
  }
  return { ok: true, value };
}

/** Read UTF-8 incrementally and stop once the byte cap is crossed. */
export async function readRequestBody(request, maxBytes) {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { ok: false, status: 413, error: "body too large" };
    }
  }
  if (request.body === null) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("body too large");
        return { ok: false, status: 413, error: "body too large" };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    return { ok: false, status: 400, error: "unreadable request body" };
  } finally {
    reader.releaseLock();
  }
}

async function waitlistKey(email) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email.toLowerCase()),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `email:${hex}`;
}

/**
 * Validate and durably persist one waitlist submission.
 *
 * `respond` is the Worker shell's JSON response helper. The explicit seam
 * keeps security headers centralized there and makes this module testable.
 */
export async function handleWaitlist(request, env, respond) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return respond(
      { ok: false, error: "content-type must be application/json" },
      415,
      CORS_HEADERS,
    );
  }

  const body = await readRequestBody(request, MAX_BODY_BYTES);
  if (!body.ok) return respond({ ok: false, error: body.error }, body.status, CORS_HEADERS);
  const raw = body.text;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return respond({ ok: false, error: "invalid JSON" }, 400, CORS_HEADERS);
  }
  const result = validateWaitlist(payload);
  if (!result.ok) {
    return respond({ ok: false, error: result.error }, 400, CORS_HEADERS);
  }

  if (!env.WAITLIST) {
    return respond(
      { ok: false, error: "waitlist storage is not configured; use the email fallback" },
      503,
      CORS_HEADERS,
    );
  }

  const now = new Date().toISOString();
  // A pseudonymous, deterministic key makes repeat submissions update one
  // record instead of creating unbounded duplicates or exposing the email in
  // KV listings. Edge abuse controls are still required before production.
  const key = await waitlistKey(result.value.email);
  const record = JSON.stringify({
    ...result.value,
    // Server-derived metadata wins even if a client sends the same key.
    received_at: now,
  });
  try {
    await env.WAITLIST.put(key, record, {
      expirationTtl: WAITLIST_RETENTION_SECONDS,
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "waitlist storage write failed",
      error_type: error instanceof Error ? error.name : "unknown",
    }));
    // Fail closed: never acknowledge a submission that was not persisted.
    return respond(
      { ok: false, error: "storage unavailable, try again later" },
      503,
      CORS_HEADERS,
    );
  }
  return respond({ ok: true }, 202, CORS_HEADERS);
}
