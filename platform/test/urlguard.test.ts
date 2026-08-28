// Unit tests for src/urlguard.ts — the registration-time screen applied to
// every workspace-supplied outbound URL (webhook endpoints, alert channels,
// gateway upstreams). The matrix below is the contract: each rule is stated
// as blocked-vs-allowed pairs so a future relaxation cannot happen silently.

import { describe, expect, it } from "vitest";

import { validateOutboundURL } from "../src/urlguard";

function reasonFor(url: unknown): string {
  const verdict = validateOutboundURL(url);
  if (verdict.ok) throw new Error(`expected ${String(url)} to be rejected`);
  return verdict.reason;
}

describe("validateOutboundURL — allowed", () => {
  const allowed = [
    "https://hooks.example.com/services/T000/B000/XXXX",
    "https://example.com",
    "https://example.com:443/hook",
    "https://example.com:8443/hook",
    "https://sub.domain.example.co.uk/deep/path?query=1#frag",
    "https://8.8.8.8/hook", // a public IPv4 literal is fine
    "https://172.15.0.1/hook", // just below the 172.16/12 block
    "https://172.32.0.1/hook", // just above it
    "https://192.169.0.1/hook", // adjacent to 192.168/16, still public
    "https://11.0.0.1/hook", // adjacent to 10/8
    "https://[2606:4700:4700::1111]/hook", // public IPv6 literal
    "https://internal-tools.example.com/hook", // "internal" as a label, not a TLD
    "https://localhost.example.com/hook", // "localhost" as a label, not the name
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(validateOutboundURL(url)).toEqual({ ok: true });
    });
  }
});

describe("validateOutboundURL — scheme, shape and credentials", () => {
  it("requires https", () => {
    expect(reasonFor("http://example.com/hook")).toBe("url must use https");
    expect(reasonFor("ftp://example.com/hook")).toBe("url must use https");
    expect(reasonFor("file:///etc/passwd")).toBe("url must use https");
    expect(reasonFor("javascript:alert(1)")).toBe("url must use https");
  });

  it("rejects non-strings, empties and unparseable URLs", () => {
    expect(reasonFor(42)).toBe("url must be a non-empty string");
    expect(reasonFor(null)).toBe("url must be a non-empty string");
    expect(reasonFor(undefined)).toBe("url must be a non-empty string");
    expect(reasonFor("")).toBe("url must be a non-empty string");
    expect(reasonFor("/relative/path")).toBe("url must be a well-formed absolute URL");
    expect(reasonFor("https://")).toBe("url must be a well-formed absolute URL");
  });

  it("rejects an over-long URL", () => {
    expect(reasonFor(`https://example.com/${"a".repeat(4096)}`)).toBe(
      "url must be at most 2048 bytes",
    );
  });

  it("rejects userinfo in the URL", () => {
    expect(reasonFor("https://user:pass@example.com/hook")).toBe("url must not contain userinfo");
    expect(reasonFor("https://user@example.com/hook")).toBe("url must not contain userinfo");
    // The classic confusion payload: this reads as example.com but the real
    // host is 169.254.169.254. The userinfo rule catches it before the host is
    // even considered, which is why the rule exists at all.
    expect(reasonFor("https://example.com@169.254.169.254/latest/meta-data")).toBe(
      "url must not contain userinfo",
    );
  });
});

describe("validateOutboundURL — ports", () => {
  it("allows only 443 and 8443", () => {
    expect(validateOutboundURL("https://example.com:443/hook")).toEqual({ ok: true });
    expect(validateOutboundURL("https://example.com:8443/hook")).toEqual({ ok: true });
    for (const port of [80, 8080, 22, 25, 3306, 5432, 6379, 9200, 1, 65535]) {
      expect(reasonFor(`https://example.com:${port}/hook`)).toBe("url port must be 443 or 8443");
    }
  });
});

describe("validateOutboundURL — private IPv4 literals", () => {
  const blocked = [
    ["10.0.0.5", "10/8"],
    ["10.255.255.255", "10/8 upper"],
    ["172.16.0.1", "172.16/12 lower"],
    ["172.31.255.254", "172.16/12 upper"],
    ["192.168.1.1", "192.168/16"],
    ["127.0.0.1", "127/8 loopback"],
    ["127.255.255.255", "127/8 upper"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "169.254/16 link-local"],
    ["0.0.0.0", "this host"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["224.0.0.1", "multicast"],
  ] as const;

  for (const [host, label] of blocked) {
    it(`blocks ${host} (${label})`, () => {
      expect(reasonFor(`https://${host}/hook`)).toBe(
        "url host is a private, loopback, link-local, or metadata IPv4 address",
      );
    });
  }

  it("blocks the alternate integer/hex spellings the URL parser normalizes", () => {
    // 2130706433 === 0x7f000001 === 127.0.0.1
    expect(reasonFor("https://2130706433/hook")).toBe(
      "url host is a private, loopback, link-local, or metadata IPv4 address",
    );
    expect(reasonFor("https://0x7f000001/hook")).toBe(
      "url host is a private, loopback, link-local, or metadata IPv4 address",
    );
  });
});

describe("validateOutboundURL — private IPv6 literals", () => {
  const blocked = [
    ["[::1]", "loopback"],
    ["[::]", "unspecified"],
    ["[fc00::1]", "fc00::/7 unique-local"],
    ["[fd12:3456:789a::1]", "fd00::/8 unique-local"],
    ["[fe80::1]", "fe80::/10 link-local"],
    ["[febf::1]", "fe80::/10 upper"],
    ["[::ffff:10.0.0.1]", "IPv4-mapped private"],
    ["[::ffff:169.254.169.254]", "IPv4-mapped metadata"],
  ] as const;

  for (const [host, label] of blocked) {
    it(`blocks ${host} (${label})`, () => {
      expect(reasonFor(`https://${host}/hook`)).toBe(
        "url host is a private, loopback, or link-local IPv6 address",
      );
    });
  }

  it("allows a public IPv6 literal and a public IPv4-mapped address", () => {
    expect(validateOutboundURL("https://[2001:4860:4860::8888]/hook")).toEqual({ ok: true });
    expect(validateOutboundURL("https://[::ffff:8.8.8.8]/hook")).toEqual({ ok: true });
  });
});

describe("validateOutboundURL — private hostname families", () => {
  it("blocks localhost, bare and as a suffix", () => {
    expect(reasonFor("https://localhost/hook")).toBe("url host is a loopback hostname");
    expect(reasonFor("https://LOCALHOST/hook")).toBe("url host is a loopback hostname");
    expect(reasonFor("https://localhost./hook")).toBe("url host is a loopback hostname");
    expect(reasonFor("https://api.localhost/hook")).toBe(
      "url host is in the private .localhost name space",
    );
  });

  it("blocks the .internal family, including the cloud metadata names", () => {
    expect(reasonFor("https://metadata.google.internal/computeMetadata/v1/")).toBe(
      "url host is in the private .internal name space",
    );
    expect(reasonFor("https://anything.internal/hook")).toBe(
      "url host is in the private .internal name space",
    );
  });

  it("blocks the .local mDNS family", () => {
    expect(reasonFor("https://printer.local/hook")).toBe(
      "url host is in the private .local name space",
    );
    expect(reasonFor("https://Printer.LOCAL./hook")).toBe(
      "url host is in the private .local name space",
    );
  });
});

describe("validateOutboundURL — determinism", () => {
  it("is a pure function of the string: same input, same verdict", () => {
    for (const url of ["https://example.com/hook", "https://10.0.0.1/hook", "http://x.example"]) {
      expect(validateOutboundURL(url)).toEqual(validateOutboundURL(url));
    }
  });
});
