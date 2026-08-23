import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrations = ["0001_init.sql", "0002_workstream_event_projection.sql"];
const testDirectory = dirname(fileURLToPath(import.meta.url));
const accountMigration = readFileSync(
  resolve(testDirectory, "../migrations/0003_account_foundation.sql"),
  "utf8",
);

const WS_ONE = `wsp_01J${"A".repeat(23)}`;
const WS_TWO = `wsp_01J${"B".repeat(23)}`;
const USER_ONE = `usr_01J${"C".repeat(23)}`;
const USER_TWO = `usr_01J${"D".repeat(23)}`;
const WS_THREE = `wsp_01J${"E".repeat(23)}`;
const WS_FOUR = `wsp_01J${"F".repeat(23)}`;
const USER_THREE = `usr_01J${"G".repeat(23)}`;
const USER_FOUR = `usr_01J${"H".repeat(23)}`;
const REQUEST_HASH = "a".repeat(64);

function beforeAccountMigration(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) {
    db.exec(readFileSync(resolve(testDirectory, `../migrations/${migration}`), "utf8"));
  }
  const insertWorkspace = db.prepare(`
    INSERT INTO workspaces (id, workspace_id, name, status, created_at)
    VALUES (?, ?, ?, 'active', 1)
  `);
  insertWorkspace.run(WS_ONE, WS_ONE, "one");
  insertWorkspace.run(WS_TWO, WS_TWO, "two");
  return db;
}

function migratedDatabase(): DatabaseSync {
  const db = beforeAccountMigration();
  db.exec(accountMigration);
  return db;
}

function addBasicEntitlement(db: DatabaseSync, workspaceID = WS_ONE): void {
  db.prepare(`
    INSERT OR IGNORE INTO workspace_entitlements
      (workspace_id, period_start, period_end, created_at, updated_at)
    VALUES (?, 100, 200, 100, 100)
  `).run(workspaceID);
}

describe("0003 account foundation migration", () => {
  it("applies after the prior D1 migrations and creates every account table", () => {
    const db = migratedDatabase();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    for (const table of [
      "users",
      "provider_identities",
      "workspace_members",
      "account_sessions",
      "auth_states",
      "hosted_beta_capacity",
      "workspace_entitlements",
      "quota_reservations",
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it("scopes identical workstream protocol IDs by workspace", () => {
    const db = migratedDatabase();
    const id = `ws_01J${"M".repeat(23)}`;
    const insert = db.prepare(`
      INSERT INTO workstreams
        (id, workspace_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 10, 10)
    `);
    insert.run(id, WS_ONE, "tenant one");
    insert.run(id, WS_TWO, "tenant two");
    expect(db.prepare(`
      SELECT workspace_id, title FROM workstreams WHERE id = ? ORDER BY workspace_id
    `).all(id)).toEqual([
      { workspace_id: WS_ONE, title: "tenant one" },
      { workspace_id: WS_TWO, title: "tenant two" },
    ]);
    db.close();
  });

  it("atomically caps hosted Basic accounts without charging entitlement retries", () => {
    const db = migratedDatabase();
    expect(db.prepare("SELECT * FROM hosted_beta_capacity WHERE id = 'global'").get()).toMatchObject({
      max_accounts: 50,
      active_accounts: 0,
    });
    db.prepare("UPDATE hosted_beta_capacity SET max_accounts = 1 WHERE id = 'global'").run();

    // AFTER INSERT accounting means an ignored invalid candidate never burns
    // the finite beta capacity.
    db.prepare(`
      INSERT OR IGNORE INTO workspace_entitlements
        (workspace_id, plan_id, status, period_start, period_end, created_at, updated_at)
      VALUES (?, 'basic', 'active', 200, 100, 100, 100)
    `).run(WS_ONE);
    expect(
      db.prepare("SELECT active_accounts FROM hosted_beta_capacity WHERE id = 'global'").get(),
    ).toMatchObject({ active_accounts: 0 });

    addBasicEntitlement(db, WS_ONE);
    expect(
      db.prepare("SELECT active_accounts FROM hosted_beta_capacity WHERE id = 'global'").get(),
    ).toMatchObject({ active_accounts: 1 });

    db.prepare(`
      INSERT OR IGNORE INTO workspace_entitlements
        (workspace_id, plan_id, status, period_start, period_end, created_at, updated_at)
      VALUES (?, 'basic', 'active', 100, 200, 100, 100)
    `).run(WS_ONE);
    expect(
      db.prepare("SELECT active_accounts FROM hosted_beta_capacity WHERE id = 'global'").get(),
    ).toMatchObject({ active_accounts: 1 });

    expect(() => addBasicEntitlement(db, WS_TWO)).toThrow(/hosted beta capacity exceeded/);
    expect(
      db.prepare("SELECT * FROM workspace_entitlements WHERE workspace_id = ?").get(WS_TWO),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT active_accounts FROM hosted_beta_capacity WHERE id = 'global'").get(),
    ).toMatchObject({ active_accounts: 1 });
    db.close();
  });

  it("rolls back the entire signup graph when hosted capacity is exhausted", () => {
    const db = migratedDatabase();
    db.prepare("UPDATE hosted_beta_capacity SET max_accounts = 1 WHERE id = 'global'").run();

    const signup = (
      workspaceID: string,
      userID: string,
      providerSubject: string,
    ): void => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT INTO workspaces (id, workspace_id, name, status, created_at)
          VALUES (?, ?, 'personal', 'active', 10)
        `).run(workspaceID, workspaceID);
        db.prepare(`
          INSERT INTO users
            (id, email, email_verified, personal_workspace_id, created_at, updated_at)
          VALUES (?, ?, 1, ?, 10, 10)
        `).run(userID, `${providerSubject}@example.test`, workspaceID);
        db.prepare(`
          INSERT INTO provider_identities
            (provider, provider_subject, user_id, email, created_at, updated_at)
          VALUES ('workos', ?, ?, ?, 10, 10)
        `).run(providerSubject, userID, `${providerSubject}@example.test`);
        db.prepare(`
          INSERT INTO workspace_members
            (workspace_id, user_id, role, status, created_at)
          VALUES (?, ?, 'owner', 'active', 10)
        `).run(workspaceID, userID);
        db.prepare(`
          INSERT INTO workspace_entitlements
            (workspace_id, plan_id, status, period_start, period_end, created_at, updated_at)
          VALUES (?, 'basic', 'active', 10, 20, 10, 10)
        `).run(workspaceID);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };

    signup(WS_THREE, USER_THREE, "provider-one");
    const before = {
      workspaces: db.prepare("SELECT COUNT(*) AS count FROM workspaces").get(),
      users: db.prepare("SELECT COUNT(*) AS count FROM users").get(),
      identities: db.prepare("SELECT COUNT(*) AS count FROM provider_identities").get(),
      members: db.prepare("SELECT COUNT(*) AS count FROM workspace_members").get(),
      entitlements: db.prepare("SELECT COUNT(*) AS count FROM workspace_entitlements").get(),
    };
    expect(() => signup(WS_FOUR, USER_FOUR, "provider-two")).toThrow(
      /hosted beta capacity exceeded/,
    );
    expect({
      workspaces: db.prepare("SELECT COUNT(*) AS count FROM workspaces").get(),
      users: db.prepare("SELECT COUNT(*) AS count FROM users").get(),
      identities: db.prepare("SELECT COUNT(*) AS count FROM provider_identities").get(),
      members: db.prepare("SELECT COUNT(*) AS count FROM workspace_members").get(),
      entitlements: db.prepare("SELECT COUNT(*) AS count FROM workspace_entitlements").get(),
    }).toEqual(before);
    expect(
      db.prepare("SELECT active_accounts FROM hosted_beta_capacity WHERE id = 'global'").get(),
    ).toMatchObject({ active_accounts: 1 });
    db.close();
  });

  it("does not backfill legacy workspaces and rejects a stale metering claim", () => {
    const db = migratedDatabase();
    const entitlement = db
      .prepare("SELECT * FROM workspace_entitlements WHERE workspace_id = ?")
      .get(WS_ONE);
    expect(entitlement).toBeUndefined();

    // Application policy rejects the missing row before preparing a write. If
    // a previously prepared metered request races with entitlement deletion,
    // the trigger must also abort instead of allowing an uncharged batch.
    expect(() =>
      db.prepare(`
        INSERT OR IGNORE INTO quota_reservations
          (workspace_id, idempotency_key, request_hash, event_count, body_bytes, created_at)
        VALUES (?, 'stale-metered-request', ?, 1, 1, 10)
      `).run(WS_ONE, REQUEST_HASH),
    ).toThrow(/active entitlement required/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM quota_reservations").get()).toMatchObject({ count: 0 });
    expect(
      db.prepare("SELECT * FROM workspace_entitlements WHERE workspace_id = ?").get(WS_ONE),
    ).toBeUndefined();
    db.close();
  });

  it("uses the canonical Basic defaults and bounds active and lifetime devices", () => {
    const db = migratedDatabase();
    addBasicEntitlement(db);
    const entitlement = db
      .prepare("SELECT * FROM workspace_entitlements WHERE workspace_id = ?")
      .get(WS_ONE);
    expect(entitlement).toMatchObject({
      plan_id: "basic",
      status: "active",
      max_devices: 2,
      active_devices: 0,
      max_device_issuances: 10,
      used_device_issuances: 0,
      max_batch_events: 100,
      max_batch_bytes: 262_144,
      max_monthly_events: 5_000,
      max_monthly_bytes: 10_485_760,
      max_lifetime_events: 25_000,
      max_lifetime_bytes: 67_108_864,
      used_monthly_events: 0,
      used_monthly_bytes: 0,
      used_lifetime_events: 0,
      used_lifetime_bytes: 0,
    });
    expect(() =>
      db.prepare("UPDATE workspace_entitlements SET active_devices = 3 WHERE workspace_id = ?").run(WS_ONE),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare("UPDATE workspace_entitlements SET used_device_issuances = 11 WHERE workspace_id = ?").run(WS_ONE),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare(`
        INSERT INTO workspace_entitlements
          (workspace_id, plan_id, period_start, period_end, created_at, updated_at)
        VALUES (?, 'pro', 100, 200, 100, 100)
      `).run(WS_TWO),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("atomically charges device creation and releases only the active slot", () => {
    const db = migratedDatabase();
    addBasicEntitlement(db);
    const insert = db.prepare(`
      INSERT INTO devices
        (id, workspace_id, token_hash, label, capabilities, created_at)
      VALUES (?, ?, ?, ?, 'ingest,read', ?)
    `);
    insert.run("dev-1", WS_ONE, "hash-1", "one", 101);
    insert.run("dev-2", WS_ONE, "hash-2", "two", 102);
    expect(db.prepare(`
      SELECT active_devices, used_device_issuances
      FROM workspace_entitlements WHERE workspace_id = ?
    `).get(WS_ONE)).toMatchObject({ active_devices: 2, used_device_issuances: 2 });
    expect(() => insert.run("dev-3-denied", WS_ONE, "hash-3-denied", "three", 103))
      .toThrow(/device quota exceeded/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 2 });

    db.prepare("UPDATE devices SET revoked_at = 104 WHERE id = 'dev-1'").run();
    for (let issuance = 3; issuance <= 10; issuance += 1) {
      insert.run(
        `dev-${issuance}`,
        WS_ONE,
        `hash-${issuance}`,
        `replacement ${issuance}`,
        100 + issuance,
      );
      db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .run(200 + issuance, `dev-${issuance}`);
    }
    expect(db.prepare(`
      SELECT active_devices, used_device_issuances
      FROM workspace_entitlements WHERE workspace_id = ?
    `).get(WS_ONE)).toMatchObject({ active_devices: 1, used_device_issuances: 10 });
    expect(() => insert.run("dev-11", WS_ONE, "hash-11", "eleven", 311))
      .toThrow(/device quota exceeded/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 10 });
    db.close();
  });

  it("keys identity by provider subject without making email a callback-race lock", () => {
    const db = migratedDatabase();
    const insertUser = db.prepare(`
      INSERT INTO users
        (id, email, display_name, avatar_url, email_verified, status,
         personal_workspace_id, created_at, updated_at)
      VALUES (?, 'same@example.test', NULL, NULL, 1, 'active', ?, 10, 10)
    `);
    insertUser.run(USER_ONE, WS_ONE);
    insertUser.run(USER_TWO, WS_TWO);

    const insertIdentity = db.prepare(`
      INSERT OR IGNORE INTO provider_identities
        (provider, provider_subject, user_id, email, created_at, updated_at)
      VALUES ('workos', 'provider-user', ?, 'same@example.test', 10, 10)
    `);
    insertIdentity.run(USER_ONE);
    insertIdentity.run(USER_TWO);
    expect(
      db.prepare(`
        SELECT user_id FROM provider_identities
        WHERE provider = 'workos' AND provider_subject = 'provider-user'
      `).get(),
    ).toMatchObject({ user_id: USER_ONE });
    expect(db.prepare("SELECT COUNT(*) AS count FROM users").get()).toMatchObject({ count: 2 });
    db.close();
  });

  it("rejects contradictory reuse of an event ID and rolls back receipt and quota", () => {
    const db = migratedDatabase();
    addBasicEntitlement(db);
    const eventID = `evt_01J${"K".repeat(23)}`;
    const original = JSON.stringify({ event_id: eventID, kind: "tool.completed", value: 1 });
    const conflicting = JSON.stringify({ event_id: eventID, kind: "tool.completed", value: 2 });
    db.prepare(`
      INSERT INTO events
        (workspace_id, event_id, idempotency_key, occurred_at, kind, ingested_at, raw_json)
      VALUES (?, ?, 'original', '2026-08-24T00:00:00Z', 'tool.completed', 100, ?)
    `).run(WS_ONE, eventID, original);

    // Exact canonical replay remains an idempotent no-op.
    db.prepare(`
      INSERT OR IGNORE INTO events
        (workspace_id, event_id, idempotency_key, occurred_at, kind, ingested_at, raw_json)
      VALUES (?, ?, 'exact-replay', '2026-08-24T00:00:00Z', 'tool.completed', 101, ?)
    `).run(WS_ONE, eventID, original);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });

    db.exec("BEGIN IMMEDIATE");
    expect(() => {
      try {
        db.prepare(`
          INSERT INTO quota_reservations
            (workspace_id, idempotency_key, request_hash, event_count, body_bytes, created_at)
          VALUES (?, 'conflicting-batch', ?, 1, 10, 110)
        `).run(WS_ONE, REQUEST_HASH);
        db.prepare(`
          INSERT INTO idempotency_keys
            (key, workspace_id, request_hash, receipt_json, created_at)
          VALUES ('conflicting-batch', ?, ?, '{}', 110)
        `).run(WS_ONE, REQUEST_HASH);
        db.prepare(`
          INSERT OR IGNORE INTO events
            (workspace_id, event_id, idempotency_key, occurred_at, kind, ingested_at, raw_json)
          VALUES (?, ?, 'conflicting-batch', '2026-08-24T00:00:00Z', 'tool.completed', 110, ?)
        `).run(WS_ONE, eventID, conflicting);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/event payload conflict/);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM idempotency_keys
      WHERE workspace_id = ? AND key = 'conflicting-batch'
    `).get(WS_ONE)).toMatchObject({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM quota_reservations
      WHERE workspace_id = ? AND idempotency_key = 'conflicting-batch'
    `).get(WS_ONE)).toMatchObject({ count: 0 });
    expect(db.prepare(`
      SELECT used_monthly_events, used_lifetime_events
      FROM workspace_entitlements WHERE workspace_id = ?
    `).get(WS_ONE)).toMatchObject({ used_monthly_events: 0, used_lifetime_events: 0 });
    expect(db.prepare("SELECT raw_json FROM events WHERE workspace_id = ? AND event_id = ?")
      .get(WS_ONE, eventID)).toMatchObject({ raw_json: original });
    db.close();
  });

  it("atomically allows and charges one reservation without double-charging a retry", () => {
    const db = migratedDatabase();
    addBasicEntitlement(db);
    const reserve = db.prepare(`
      INSERT OR IGNORE INTO quota_reservations
        (workspace_id, idempotency_key, request_hash, event_count, body_bytes, created_at)
      VALUES (?, 'batch-1', ?, 40, 4096, 110)
    `);
    reserve.run(WS_ONE, REQUEST_HASH);
    expect(
      db.prepare(`
        SELECT status, decided_at FROM quota_reservations
        WHERE workspace_id = ? AND idempotency_key = 'batch-1'
      `).get(WS_ONE),
    ).toMatchObject({ status: "allowed", decided_at: 110 });
    expect(
      db.prepare(`
        SELECT used_monthly_events, used_monthly_bytes,
               used_lifetime_events, used_lifetime_bytes
        FROM workspace_entitlements WHERE workspace_id = ?
      `).get(WS_ONE),
    ).toMatchObject({
      used_monthly_events: 40,
      used_monthly_bytes: 4096,
      used_lifetime_events: 40,
      used_lifetime_bytes: 4096,
    });

    reserve.run(WS_ONE, REQUEST_HASH);
    expect(
      db.prepare(`
        SELECT used_monthly_events, used_monthly_bytes
        FROM workspace_entitlements WHERE workspace_id = ?
      `).get(WS_ONE),
    ).toMatchObject({ used_monthly_events: 40, used_monthly_bytes: 4096 });
    db.close();
  });

  it("fails closed before charging or retaining an over-quota reservation", () => {
    const db = migratedDatabase();
    addBasicEntitlement(db);
    expect(() =>
      db.prepare(`
        INSERT OR IGNORE INTO quota_reservations
          (workspace_id, idempotency_key, request_hash, event_count, body_bytes, created_at)
        VALUES (?, 'too-large', ?, 101, 1, 110)
      `).run(WS_ONE, REQUEST_HASH),
    ).toThrow(/quota exceeded/);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM quota_reservations WHERE workspace_id = ?").get(WS_ONE),
    ).toMatchObject({ count: 0 });
    expect(
      db.prepare("SELECT used_monthly_events FROM workspace_entitlements WHERE workspace_id = ?").get(WS_ONE),
    ).toMatchObject({ used_monthly_events: 0 });
    expect(() =>
      db.prepare(`
        INSERT INTO quota_reservations
          (workspace_id, idempotency_key, request_hash, event_count, body_bytes, status, created_at, decided_at)
        VALUES (?, 'forged', ?, 1, 1, 'allowed', 110, 110)
      `).run(WS_ONE, REQUEST_HASH),
    ).toThrow(/must start pending/);
    db.close();
  });

  it("resets an expired monthly period inside the atomic reservation gate", () => {
    const db = migratedDatabase();
    addBasicEntitlement(db);
    const reserve = db.prepare(`
      INSERT INTO quota_reservations
        (workspace_id, idempotency_key, request_hash, event_count, body_bytes, created_at)
      VALUES (?, ?, ?, 80, 8000, ?)
    `);
    reserve.run(WS_ONE, "period-one", REQUEST_HASH, 110);
    reserve.run(WS_ONE, "period-two", REQUEST_HASH, 210);

    expect(
      db.prepare(`
        SELECT period_start, period_end, used_monthly_events, used_monthly_bytes,
               used_lifetime_events, used_lifetime_bytes
        FROM workspace_entitlements WHERE workspace_id = ?
      `).get(WS_ONE),
    ).toMatchObject({
      period_start: 200,
      period_end: 300,
      used_monthly_events: 80,
      used_monthly_bytes: 8000,
      used_lifetime_events: 160,
      used_lifetime_bytes: 16000,
    });
    db.close();
  });

  it("requires a canonical SHA-256 request hash on each new reservation", () => {
    const db = migratedDatabase();
    addBasicEntitlement(db);
    expect(() =>
      db.prepare(`
        INSERT INTO quota_reservations
          (workspace_id, idempotency_key, request_hash, event_count, body_bytes, created_at)
        VALUES (?, 'bad-hash', 'ABC', 1, 1, 10)
      `).run(WS_ONE),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("preserves legacy receipts and scopes new idempotency uniqueness by workspace", () => {
    const db = beforeAccountMigration();
    db.prepare(`
      INSERT INTO idempotency_keys (key, workspace_id, device_id, receipt_json, created_at)
      VALUES ('same-key', ?, NULL, '{"legacy":true}', 2)
    `).run(WS_ONE);
    db.exec(accountMigration);

    expect(
      db.prepare("SELECT request_hash, receipt_json FROM idempotency_keys WHERE workspace_id = ? AND key = 'same-key'").get(WS_ONE),
    ).toMatchObject({ request_hash: null, receipt_json: '{"legacy":true}' });
    db.prepare(`
      INSERT INTO idempotency_keys
        (key, workspace_id, device_id, request_hash, receipt_json, created_at)
      VALUES ('same-key', ?, NULL, ?, '{}', 3)
    `).run(WS_TWO, "a".repeat(64));
    expect(() =>
      db.prepare(`
        INSERT INTO idempotency_keys
          (key, workspace_id, device_id, request_hash, receipt_json, created_at)
        VALUES ('same-key', ?, NULL, NULL, '{}', 4)
      `).run(WS_ONE),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it("documents the explicit provisioning and atomic-gate invariants in the SQL itself", () => {
    expect(accountMigration).not.toMatch(/INSERT\s+INTO\s+workspace_entitlements/i);
    expect(accountMigration).toMatch(/UNIQUE\s*\(workspace_id,\s*key\)/i);
    expect(accountMigration).toMatch(/CREATE TRIGGER quota_reservations_check/i);
    expect(accountMigration).toMatch(/CREATE TRIGGER quota_reservations_allow/i);
    expect(accountMigration).toMatch(/request_hash TEXT/i);
    expect(accountMigration).toMatch(/csrf_hash\s+TEXT NOT NULL/i);
  });
});
