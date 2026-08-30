import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(testDirectory, "../migrations");
const WS_ONE = `wsp_01J${"A".repeat(23)}`;
const WS_TWO = `wsp_01J${"B".repeat(23)}`;
const DEVICE_ONE = `dev_01J${"C".repeat(23)}`;
const DEVICE_TWO = `dev_01J${"D".repeat(23)}`;
const REQUEST_HASH = "a".repeat(64);

function migrationFiles(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

function applyThrough(db: DatabaseSync, finalMigration: string): void {
  for (const migration of migrationFiles()) {
    db.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));
    if (migration === finalMigration) return;
  }
  throw new Error(`migration not found: ${finalMigration}`);
}

function seedWorkspace(db: DatabaseSync, workspaceId: string, deviceId: string, token: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, workspace_id, name, status, created_at)
    VALUES (?, ?, 'security test', 'active', 100)
  `).run(workspaceId, workspaceId);
  db.prepare(`
    INSERT INTO workspace_entitlements
      (workspace_id, period_start, period_end, created_at, updated_at)
    VALUES (?, 100, 1000, 100, 100)
  `).run(workspaceId);
  db.prepare(`
    INSERT INTO devices
      (id, workspace_id, token_hash, label, capabilities, created_at)
    VALUES (?, ?, ?, 'security test', 'ingest,read', 100)
  `).run(deviceId, workspaceId, token);
}

function databaseThrough0018(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, "0018_account_deletion.sql");
  seedWorkspace(db, WS_ONE, DEVICE_ONE, "token-one");
  seedWorkspace(db, WS_TWO, DEVICE_TWO, "token-two");
  return db;
}

function databaseThrough0022(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, "0022_workspace_prelock_device_fence.sql");
  seedWorkspace(db, WS_ONE, DEVICE_ONE, "token-one");
  seedWorkspace(db, WS_TWO, DEVICE_TWO, "token-two");
  return db;
}

function insertReceipt(
  db: DatabaseSync,
  key: string,
  workspaceId: string,
  deviceId: string | null,
): void {
  db.prepare(`
    INSERT INTO idempotency_keys
      (key, workspace_id, device_id, request_hash, receipt_json, created_at)
    VALUES (?, ?, ?, ?, '{}', 110)
  `).run(key, workspaceId, deviceId, REQUEST_HASH);
}

describe("0019 device revocation commit fence", () => {
  it("preserves legacy nullable receipts while requiring an active same-tenant device for new ones", () => {
    const db = databaseThrough0018();
    insertReceipt(db, "legacy", WS_ONE, null);
    db.exec(readFileSync(resolve(migrationsDirectory, "0019_device_revocation_commit_fence.sql"), "utf8"));

    expect(db.prepare(`
      SELECT device_id FROM idempotency_keys WHERE workspace_id = ? AND key = 'legacy'
    `).get(WS_ONE)).toEqual({ device_id: null });

    expect(() => insertReceipt(db, "missing", WS_ONE, null)).toThrow(/active device required/);
    expect(() => insertReceipt(db, "unknown", WS_ONE, "dev_missing")).toThrow(
      /active device required/,
    );
    expect(() => insertReceipt(db, "foreign", WS_ONE, DEVICE_TWO)).toThrow(
      /active device required/,
    );

    db.prepare("UPDATE devices SET revoked_at = 120 WHERE id = ?").run(DEVICE_ONE);
    expect(() => insertReceipt(db, "revoked", WS_ONE, DEVICE_ONE)).toThrow(
      /active device required/,
    );

    db.prepare("UPDATE devices SET revoked_at = NULL WHERE id = ?").run(DEVICE_ONE);
    insertReceipt(db, "active", WS_ONE, DEVICE_ONE);
    expect(db.prepare(`
      SELECT device_id FROM idempotency_keys WHERE workspace_id = ? AND key = 'active'
    `).get(WS_ONE)).toEqual({ device_id: DEVICE_ONE });
    db.close();
  });

  it("rolls back quota and every hosted write when revocation wins before commit", () => {
    const db = databaseThrough0018();
    db.exec(readFileSync(resolve(migrationsDirectory, "0019_device_revocation_commit_fence.sql"), "utf8"));
    db.prepare("UPDATE devices SET revoked_at = 120 WHERE id = ?").run(DEVICE_ONE);

    db.exec("BEGIN IMMEDIATE");
    expect(() => {
      try {
        db.prepare(`
          INSERT INTO quota_reservations
            (workspace_id, idempotency_key, request_hash, event_count, body_bytes, created_at)
          VALUES (?, 'revocation-race', ?, 1, 64, 130)
        `).run(WS_ONE, REQUEST_HASH);
        insertReceipt(db, "revocation-race", WS_ONE, DEVICE_ONE);
        db.prepare(`
          INSERT INTO events
            (workspace_id, event_id, idempotency_key, occurred_at, kind, ingested_at, raw_json)
          VALUES (?, 'evt_revocation_race', 'revocation-race',
                  '2026-08-30T00:00:00Z', 'command.completed', 130, '{}')
        `).run(WS_ONE);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/active device required/);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM quota_reservations WHERE workspace_id = ?
    `).get(WS_ONE)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT used_monthly_events, used_monthly_bytes,
             used_lifetime_events, used_lifetime_bytes
      FROM workspace_entitlements WHERE workspace_id = ?
    `).get(WS_ONE)).toEqual({
      used_monthly_events: 0,
      used_monthly_bytes: 0,
      used_lifetime_events: 0,
      used_lifetime_bytes: 0,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM idempotency_keys WHERE workspace_id = ?
    `).get(WS_ONE)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?
    `).get(WS_ONE)).toEqual({ count: 0 });
    db.close();
  });

  it("keeps a batch that commits before the owner revokes its device", () => {
    const db = databaseThrough0018();
    db.exec(readFileSync(resolve(migrationsDirectory, "0019_device_revocation_commit_fence.sql"), "utf8"));
    insertReceipt(db, "committed-first", WS_ONE, DEVICE_ONE);
    db.prepare(`
      INSERT INTO events
        (workspace_id, event_id, idempotency_key, occurred_at, kind, ingested_at, raw_json)
      VALUES (?, 'evt_committed_first', 'committed-first',
              '2026-08-30T00:00:00Z', 'command.completed', 110, '{}')
    `).run(WS_ONE);

    db.prepare("UPDATE devices SET revoked_at = 120 WHERE id = ?").run(DEVICE_ONE);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM idempotency_keys WHERE workspace_id = ?
    `).get(WS_ONE)).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?
    `).get(WS_ONE)).toEqual({ count: 1 });
    db.close();
  });
});

describe("0022 workspace prelock device fence", () => {
  it("upgrades an already-applied 0019 trigger and denies a prelocked workspace", () => {
    const db = databaseThrough0018();
    db.exec(readFileSync(resolve(migrationsDirectory, "0019_device_revocation_commit_fence.sql"), "utf8"));

    db.prepare("UPDATE workspaces SET status = 'deleting' WHERE id = ?").run(WS_ONE);
    // Pin why 0022 is a new migration instead of an edit to the already-applied
    // 0019 history: its old trigger still admits this active device.
    insertReceipt(db, "old-0019-gap", WS_ONE, DEVICE_ONE);

    db.exec(readFileSync(resolve(migrationsDirectory, "0022_workspace_prelock_device_fence.sql"), "utf8"));
    expect(() => insertReceipt(db, "prelocked", WS_ONE, DEVICE_ONE)).toThrow(
      /active device required/,
    );
    db.prepare("UPDATE workspaces SET status = 'active' WHERE id = ?").run(WS_ONE);
    insertReceipt(db, "active-after-upgrade", WS_ONE, DEVICE_ONE);
    db.close();
  });

  it("is authoritative on a fresh full migration chain", () => {
    const db = databaseThrough0022();
    insertReceipt(db, "active", WS_ONE, DEVICE_ONE);
    db.prepare("UPDATE workspaces SET status = 'deleting' WHERE id = ?").run(WS_ONE);
    expect(() => insertReceipt(db, "prelocked", WS_ONE, DEVICE_ONE)).toThrow(
      /active device required/,
    );
    db.close();
  });
});

describe("0020 terminal device revocation", () => {
  it("cannot resurrect a revoked bearer token or mutate its identity", () => {
    const db = databaseThrough0018();
    db.exec(readFileSync(resolve(migrationsDirectory, "0019_device_revocation_commit_fence.sql"), "utf8"));
    db.exec(readFileSync(resolve(migrationsDirectory, "0020_terminal_device_revocation.sql"), "utf8"));

    db.prepare("UPDATE devices SET revoked_at = 120 WHERE id = ?").run(DEVICE_ONE);
    expect(db.prepare(`
      SELECT active_devices FROM workspace_entitlements WHERE workspace_id = ?
    `).get(WS_ONE)).toEqual({ active_devices: 0 });

    expect(() => db.prepare("UPDATE devices SET revoked_at = NULL WHERE id = ?").run(DEVICE_ONE))
      .toThrow(/device revocation is terminal/);
    expect(() => db.prepare("UPDATE devices SET revoked_at = 121 WHERE id = ?").run(DEVICE_ONE))
      .toThrow(/device revocation is terminal/);
    expect(() => insertReceipt(db, "resurrected", WS_ONE, DEVICE_ONE)).toThrow(
      /active device required/,
    );

    for (const update of [
      "id = 'dev_changed'",
      `workspace_id = '${WS_TWO}'`,
      "token_hash = 'changed-token'",
      "capabilities = 'read'",
      "created_at = 101",
    ]) {
      expect(() => db.exec(`UPDATE devices SET ${update} WHERE id = '${DEVICE_ONE}'`))
        .toThrow(/device identity is immutable/);
    }

    db.prepare("UPDATE devices SET label = 'renamed', last_seen_at = 130 WHERE id = ?").run(DEVICE_ONE);
    expect(db.prepare(`
      SELECT label, last_seen_at, revoked_at FROM devices WHERE id = ?
    `).get(DEVICE_ONE)).toEqual({ label: "renamed", last_seen_at: 130, revoked_at: 120 });
    expect(db.prepare(`
      SELECT active_devices FROM workspace_entitlements WHERE workspace_id = ?
    `).get(WS_ONE)).toEqual({ active_devices: 0 });
    db.close();
  });
});
