import { decodeTime, isValid as isValidULID, monotonicFactory } from "ulid";

/** Durable account/platform ID prefixes. Opaque credentials use random bytes instead. */
export const ID_PREFIXES = Object.freeze({
  user: "usr_",
  workspace: "wsp_",
  device: "dev_",
  accountSession: "acs_",
  authState: "ast_",
} as const);

export type PlatformIDKind = keyof typeof ID_PREFIXES;
export type PlatformIDPrefix = (typeof ID_PREFIXES)[PlatformIDKind];
export type PrefixedULID<P extends PlatformIDPrefix> = `${P}${string}`;

// A single factory preserves lexical creation order when several durable IDs
// are allocated in the same millisecond.
const nextULID = monotonicFactory();

function newID<P extends PlatformIDPrefix>(prefix: P, timestamp?: number): PrefixedULID<P> {
  return `${prefix}${nextULID(timestamp)}`;
}

function isID<P extends PlatformIDPrefix>(value: string, prefix: P): value is PrefixedULID<P> {
  if (!value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  if (body.length !== 26 || body !== body.toUpperCase() || !isValidULID(body)) return false;

  // ulid.isValid validates the alphabet and length. decodeTime additionally
  // rejects timestamp overflow (the first Crockford digit must be 0..7).
  try {
    decodeTime(body);
    return true;
  } catch {
    return false;
  }
}

export function newUserID(timestamp?: number): PrefixedULID<"usr_"> {
  return newID(ID_PREFIXES.user, timestamp);
}

export function newWorkspaceID(timestamp?: number): PrefixedULID<"wsp_"> {
  return newID(ID_PREFIXES.workspace, timestamp);
}

export function newDeviceID(timestamp?: number): PrefixedULID<"dev_"> {
  return newID(ID_PREFIXES.device, timestamp);
}

export function newAccountSessionID(timestamp?: number): PrefixedULID<"acs_"> {
  return newID(ID_PREFIXES.accountSession, timestamp);
}

export function newAuthStateID(timestamp?: number): PrefixedULID<"ast_"> {
  return newID(ID_PREFIXES.authState, timestamp);
}

export function isUserID(value: string): value is PrefixedULID<"usr_"> {
  return isID(value, ID_PREFIXES.user);
}

export function isWorkspaceID(value: string): value is PrefixedULID<"wsp_"> {
  return isID(value, ID_PREFIXES.workspace);
}

export function isDeviceID(value: string): value is PrefixedULID<"dev_"> {
  return isID(value, ID_PREFIXES.device);
}

export function isAccountSessionID(value: string): value is PrefixedULID<"acs_"> {
  return isID(value, ID_PREFIXES.accountSession);
}

export function isAuthStateID(value: string): value is PrefixedULID<"ast_"> {
  return isID(value, ID_PREFIXES.authState);
}
