import { describe, expect, it } from "vitest";
import {
  ID_PREFIXES,
  isAccountSessionID,
  isAuthStateID,
  isDeviceID,
  isUserID,
  isWorkspaceID,
  newAccountSessionID,
  newAuthStateID,
  newDeviceID,
  newUserID,
  newWorkspaceID,
} from "../src/ids";

describe("platform durable IDs", () => {
  it("generates canonical prefixed ULIDs for every account row type", () => {
    const cases = [
      [newUserID(), ID_PREFIXES.user, isUserID],
      [newWorkspaceID(), ID_PREFIXES.workspace, isWorkspaceID],
      [newDeviceID(), ID_PREFIXES.device, isDeviceID],
      [newAccountSessionID(), ID_PREFIXES.accountSession, isAccountSessionID],
      [newAuthStateID(), ID_PREFIXES.authState, isAuthStateID],
    ] as const;

    for (const [id, prefix, validate] of cases) {
      expect(id).toMatch(new RegExp(`^${prefix}[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
      expect(validate(id)).toBe(true);
    }
  });

  it("is strictly monotonic for allocations in one millisecond", () => {
    const timestamp = Date.now();
    const ids = Array.from({ length: 1_000 }, () => newUserID(timestamp));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("rejects wrong prefixes, lowercase, malformed, and overflow ULIDs", () => {
    const user = newUserID();
    expect(isWorkspaceID(user)).toBe(false);
    expect(isUserID(user.toLowerCase())).toBe(false);
    expect(isUserID("usr_not-a-ulid")).toBe(false);
    expect(isUserID(`usr_8${"0".repeat(25)}`)).toBe(false);
  });

  it("keeps the prefix registry immutable", () => {
    expect(Object.isFrozen(ID_PREFIXES)).toBe(true);
  });
});
