export const PLAN_IDS = ["local", "basic", "pro", "team"] as const;
export type PlanID = (typeof PLAN_IDS)[number];

export interface HostedPlanLimits {
  readonly maxDevices: number;
  /** Lifetime device rows, including revoked devices. */
  readonly maxDeviceIssuances: number;
  readonly maxBatchEvents: number;
  readonly maxBatchBytes: number;
  readonly maxMonthlyEvents: number;
  readonly maxMonthlyBytes: number;
  readonly maxLifetimeEvents: number;
  readonly maxLifetimeBytes: number;
}

export interface PlanCapabilities {
  readonly localCapture: boolean;
  readonly hostedSync: boolean;
  readonly sharedWorkspaces: boolean;
}

export interface PlanDefinition {
  readonly id: PlanID;
  readonly name: string;
  readonly available: boolean;
  readonly accountRequired: boolean;
  /** True only when the plan may be provisioned in workspace_entitlements. */
  readonly hostedEntitlement: boolean;
  readonly unmetered: boolean;
  readonly limits: HostedPlanLimits | null;
  readonly capabilities: PlanCapabilities;
}

export const BASIC_LIMITS: HostedPlanLimits = Object.freeze({
  maxDevices: 2,
  maxDeviceIssuances: 10,
  maxBatchEvents: 100,
  maxBatchBytes: 262_144,
  maxMonthlyEvents: 5_000,
  maxMonthlyBytes: 10_485_760,
  maxLifetimeEvents: 25_000,
  maxLifetimeBytes: 67_108_864,
});

const LOCAL_CAPABILITIES: PlanCapabilities = Object.freeze({
  localCapture: true,
  hostedSync: false,
  sharedWorkspaces: false,
});

const BASIC_CAPABILITIES: PlanCapabilities = Object.freeze({
  localCapture: true,
  hostedSync: true,
  sharedWorkspaces: false,
});

const UNAVAILABLE_CAPABILITIES: PlanCapabilities = Object.freeze({
  localCapture: true,
  hostedSync: false,
  sharedWorkspaces: false,
});

/**
 * Immutable, deliberately conservative plan catalog.
 *
 * Local is account-free and unmetered because it never reaches the hosted
 * quota path. Basic is the only hosted entitlement currently provisionable.
 * Pro and Team are visible previews, not promises: they expose no limits or
 * hosted capabilities until those products actually ship.
 */
export const PLAN_CATALOG: Readonly<Record<PlanID, PlanDefinition>> = Object.freeze({
  local: Object.freeze({
    id: "local",
    name: "Local",
    available: true,
    accountRequired: false,
    hostedEntitlement: false,
    unmetered: true,
    limits: null,
    capabilities: LOCAL_CAPABILITIES,
  }),
  basic: Object.freeze({
    id: "basic",
    name: "Basic",
    available: true,
    accountRequired: true,
    hostedEntitlement: true,
    unmetered: false,
    limits: BASIC_LIMITS,
    capabilities: BASIC_CAPABILITIES,
  }),
  pro: Object.freeze({
    id: "pro",
    name: "Pro",
    available: false,
    accountRequired: true,
    hostedEntitlement: false,
    unmetered: false,
    limits: null,
    capabilities: UNAVAILABLE_CAPABILITIES,
  }),
  team: Object.freeze({
    id: "team",
    name: "Team",
    available: false,
    accountRequired: true,
    hostedEntitlement: false,
    unmetered: false,
    limits: null,
    capabilities: UNAVAILABLE_CAPABILITIES,
  }),
});

export function getPlan(id: string): PlanDefinition | null {
  return Object.prototype.hasOwnProperty.call(PLAN_CATALOG, id)
    ? PLAN_CATALOG[id as PlanID]
    : null;
}
