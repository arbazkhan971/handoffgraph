// Registration-time guard for workspace-supplied outbound URLs (webhook
// endpoints, alert channels, gateway upstream/fallback base URLs).
//
// SCOPE — read this before trusting it:
//
// This is a REGISTRATION-TIME guard, not an egress-time one. It inspects the
// literal URL a customer submits and rejects the shapes that are obviously
// pointed back at the platform's own network: plaintext http, credentials in
// the URL, literal addresses inside private/loopback/link-local/metadata
// ranges, the localhost/.internal/.local name families, and ports outside the
// two the platform is willing to talk to.
//
// It CANNOT stop DNS rebinding. `https://evil.example` may resolve to a public
// address when the endpoint is registered and to 169.254.169.254 when the
// delivery fires minutes later; nothing checkable at registration time sees
// that. It also does not follow redirects — a permitted host answering 302 to
// a private address is an egress-time concern. Closing those honestly needs
// egress-side policy (Cloudflare egress policies / a filtering egress gateway
// on the account's Workers egress path), not more parsing here. Until that
// exists, this module is defence in depth against mistakes and casual abuse,
// and is described as exactly that everywhere it is used.
//
// Every decision is a pure function of the string: no DNS, no network, no
// clock — so the same URL always gets the same verdict, in production and in
// tests alike.

/** Verdict for one candidate outbound URL. `reason` is safe to return to the caller. */
export type OutboundURLVerdict = { ok: true } | { ok: false; reason: string };

const OK: OutboundURLVerdict = { ok: true };

const deny = (reason: string): OutboundURLVerdict => ({ ok: false, reason });

/** Longest URL accepted anywhere on the platform (matches the per-module caps). */
const MAX_URL_BYTES = 2048;

/**
 * Ports the platform is willing to open an outbound TLS connection on. 443 is
 * https; 8443 is the conventional alternate that legitimate self-hosted
 * receivers use. Everything else (8080, 6379, 5432, 22 …) is far more likely
 * to be an internal service than a customer's webhook receiver.
 */
const ALLOWED_PORTS = Object.freeze(new Set(["", "443", "8443"]));

/**
 * Hostname suffixes that only ever name something inside a private network.
 * `.local` is mDNS, `.internal` is the cloud-internal convention (including
 * metadata.google.internal), and `localhost` is matched both bare and as a
 * suffix (`api.localhost` resolves to loopback in every modern resolver).
 */
const PRIVATE_HOST_SUFFIXES = Object.freeze([".localhost", ".internal", ".local"] as const);

/** Dotted-quad IPv4, captured for range analysis. Rejects 1.2.3.4.5 and 01.2.3.4. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(hostname: string): number[] | null {
  const match = IPV4_PATTERN.exec(hostname);
  if (match === null) return null;
  const octets = match.slice(1, 5).map((part) => Number.parseInt(part, 10));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/**
 * True for IPv4 literals the platform must never dial: RFC1918 private space,
 * loopback, link-local (which contains the 169.254.169.254 cloud metadata
 * endpoint), "this host" 0.0.0.0/8, carrier-grade NAT, and the multicast /
 * reserved tail. Everything else is treated as public.
 */
function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * True for IPv6 literals in loopback (::1), unique-local (fc00::/7) and
 * link-local (fe80::/10) space, plus the IPv4-mapped forms (::ffff:10.0.0.1)
 * that would otherwise smuggle a private IPv4 through as IPv6.
 */
function isPrivateIPv6(hostname: string): boolean {
  // URL.hostname keeps IPv6 literals in brackets and lowercases them.
  const inner = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const address = inner.split("%")[0]; // drop any zone id
  if (address === "::1" || address === "::" || address === "0:0:0:0:0:0:0:1") return true;

  // ::ffff:a.b.c.d — judge the embedded IPv4. The URL parser normalizes that
  // dotted form to two hex groups (::ffff:a00:1), so both spellings are read.
  const mappedDotted = /^::ffff:(?:0:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (mappedDotted !== null) {
    const octets = ipv4Octets(mappedDotted[1]);
    return octets === null || isPrivateIPv4(octets);
  }
  const mappedHex = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mappedHex !== null) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }

  const head = address.split(":")[0];
  if (head.length === 0) return false;
  const group = Number.parseInt(head, 16);
  if (Number.isNaN(group)) return false;
  if ((group & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((group & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

function looksLikeIPv6(hostname: string): boolean {
  return hostname.startsWith("[") || hostname.includes(":");
}

/**
 * Judge one workspace-supplied URL, fail-closed. Returns `{ok: true}` only for
 * an https URL, with no embedded credentials, on port 443/8443, naming a host
 * that is not a private literal address and not in the localhost/.internal/
 * .local families.
 *
 * The reason strings are deliberately specific: they are shown to the operator
 * who typed the URL, and they describe the URL they submitted, never anything
 * about the platform's own network.
 */
export function validateOutboundURL(url: unknown): OutboundURLVerdict {
  if (typeof url !== "string" || url.length === 0) return deny("url must be a non-empty string");
  if (new TextEncoder().encode(url).byteLength > MAX_URL_BYTES) {
    return deny(`url must be at most ${MAX_URL_BYTES} bytes`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny("url must be a well-formed absolute URL");
  }

  if (parsed.protocol !== "https:") return deny("url must use https");
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return deny("url must not contain userinfo");
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    return deny("url port must be 443 or 8443");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) return deny("url must have a hostname");

  if (looksLikeIPv6(hostname)) {
    return isPrivateIPv6(hostname)
      ? deny("url host is a private, loopback, or link-local IPv6 address")
      : OK;
  }

  const octets = ipv4Octets(hostname);
  if (octets !== null) {
    return isPrivateIPv4(octets)
      ? deny("url host is a private, loopback, link-local, or metadata IPv4 address")
      : OK;
  }

  // A trailing dot is the fully-qualified form of the same name.
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (name === "localhost") return deny("url host is a loopback hostname");
  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    if (name.endsWith(suffix)) return deny(`url host is in the private ${suffix} name space`);
  }

  return OK;
}
