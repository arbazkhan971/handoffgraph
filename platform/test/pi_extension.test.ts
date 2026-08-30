import { describe, expect, it } from "vitest";

import { truncateCapturedText } from "../../integrations/pi/handoffgraph-extension";

const MAX_TEXT_BYTES = 4096;
const TRUNCATION_MARKER = "…[truncated]";
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

describe("Pi capture extension text bounds", () => {
  it("preserves complete text at the byte ceiling", () => {
    const exact = "x".repeat(MAX_TEXT_BYTES);
    expect(truncateCapturedText(exact)).toBe(exact);
  });

  it("marks oversized ASCII capture inside the byte ceiling", () => {
    const captured = truncateCapturedText("x".repeat(MAX_TEXT_BYTES + 1));
    expect(captured.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(byteLength(captured)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  });

  it("keeps multibyte capture valid and inside the byte ceiling", () => {
    const captured = truncateCapturedText("🙂".repeat(MAX_TEXT_BYTES));
    expect(captured.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(byteLength(captured)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(captured.includes("�")).toBe(false);
  });
});
