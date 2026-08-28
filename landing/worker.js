// HandoffGraph landing worker — handoffgraph.dev
//
// No build step: wrangler bundles this file directly and inlines
// landing/index.html as text via the `rules` entry in wrangler.toml.
//
// Routes:
//   GET  /               → index.html (with security headers)
//   GET  /index.html     → same
//   GET  /og.png         → social preview card (one-day cache)
//   GET  /favicon.png    → site icon (one-day cache)
//   anything else        → 404 (JSON)
//
// The page's calls to action link straight to the hosted signup/signin flow
// on api.handoffgraph.dev; there is no request-access/waitlist surface
// (landing/index.test.mjs enforces that).

import indexHTML from "./index.html";
import faviconImage from "./favicon.png";
import ogImage from "./og.png";

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'sha256-5r0ceAi77ofyhKluuUBJUzdOIMc4aEZR9Xlgif5W6zg=' 'sha256-KeVIeV/k9Jk0Yq+Cu12nXqK2pUwCy3DTPBRhjXhOTxA='; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function jsonResponse(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
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

function servePNG(method, body) {
  return new Response(method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
      ...SECURITY_HEADERS,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if ((request.method === "GET" || request.method === "HEAD") &&
        (path === "/" || path === "/index.html")) {
      return serveIndex(request.method);
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/og.png") return servePNG(request.method, ogImage);
      if (path === "/favicon.png") return servePNG(request.method, faviconImage);
    }

    return jsonResponse({ ok: false, error: "not found" }, 404);
  },
};
