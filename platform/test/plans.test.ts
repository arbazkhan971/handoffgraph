import { describe, expect, it } from "vitest";
import { BASIC_LIMITS, PLAN_CATALOG, PLAN_IDS, getPlan } from "../src/plans";

describe("plan catalog", () => {
  it("contains only the four declared plans", () => {
    expect(Object.keys(PLAN_CATALOG)).toEqual([...PLAN_IDS]);
    expect(getPlan("basic")).toBe(PLAN_CATALOG.basic);
    expect(getPlan("enterprise")).toBeNull();
  });

  it("pins the enforceable Basic quota snapshot", () => {
    expect(PLAN_CATALOG.basic).toMatchObject({
      available: true,
      accountRequired: true,
      hostedEntitlement: true,
      unmetered: false,
      capabilities: {
        localCapture: true,
        hostedSync: true,
        sharedWorkspaces: false,
      },
    });
    expect(BASIC_LIMITS).toEqual({
      maxDevices: 2,
      maxDeviceIssuances: 10,
      maxBatchEvents: 100,
      maxBatchBytes: 262_144,
      maxMonthlyEvents: 5_000,
      maxMonthlyBytes: 10_485_760,
      maxLifetimeEvents: 25_000,
      maxLifetimeBytes: 67_108_864,
    });
    expect(PLAN_CATALOG.basic.limits).toBe(BASIC_LIMITS);
  });

  it("keeps Local account-free and outside hosted metering", () => {
    expect(PLAN_CATALOG.local).toMatchObject({
      available: true,
      accountRequired: false,
      hostedEntitlement: false,
      unmetered: true,
      limits: null,
      capabilities: { hostedSync: false, sharedWorkspaces: false },
    });
  });

  it("does not fabricate Pro or Team availability, capabilities, or caps", () => {
    for (const id of ["pro", "team"] as const) {
      expect(PLAN_CATALOG[id]).toMatchObject({
        available: false,
        hostedEntitlement: false,
        unmetered: false,
        limits: null,
        capabilities: { hostedSync: false, sharedWorkspaces: false },
      });
    }
  });

  it("is deeply immutable at every exposed object boundary", () => {
    expect(Object.isFrozen(PLAN_CATALOG)).toBe(true);
    expect(Object.isFrozen(PLAN_CATALOG.basic)).toBe(true);
    expect(Object.isFrozen(BASIC_LIMITS)).toBe(true);
    expect(Object.isFrozen(PLAN_CATALOG.basic.capabilities)).toBe(true);
  });
});
