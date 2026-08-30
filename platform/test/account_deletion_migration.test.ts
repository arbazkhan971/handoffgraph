import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKSPACE_PURGE_TABLES } from "../src/account";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(testDirectory, "../migrations");
const WS_ONE = `wsp_01J${"K".repeat(23)}`;
const WS_TWO = `wsp_01J${"M".repeat(23)}`;
const USER_ONE = `usr_01J${"N".repeat(23)}`;
const USER_TWO = `usr_01J${"P".repeat(23)}`;
const EVENT_ONE = `evt_01J${"Q".repeat(23)}`;
const EVENT_TWO = `evt_01J${"R".repeat(23)}`;

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));
  }
  return db;
}

function seedWorkspace(
  db: DatabaseSync,
  workspaceId: string,
  userId: string,
  eventId: string,
  label: string,
): void {
  db.prepare(`
    INSERT INTO workspaces (id, workspace_id, name, status, created_at)
    VALUES (?, ?, ?, 'active', 1)
  `).run(workspaceId, workspaceId, label);
  db.prepare(`
    INSERT INTO users
      (id, email, email_verified, status, personal_workspace_id, created_at, updated_at)
    VALUES (?, ?, 1, 'active', ?, 1, 1)
  `).run(userId, `${label}@example.test`, workspaceId);
  db.prepare(`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at)
    VALUES (?, ?, 'owner', 'active', 1)
  `).run(workspaceId, userId);
  db.prepare(`
    INSERT INTO workspace_entitlements
      (workspace_id, period_start, period_end, created_at, updated_at)
    VALUES (?, 1, 100, 1, 1)
  `).run(workspaceId);
  db.prepare(`
    INSERT INTO events
      (workspace_id, event_id, occurred_at, kind, ingested_at, raw_json)
    VALUES (?, ?, '2026-08-30T00:00:00Z', 'command.completed', 2, ?)
  `).run(workspaceId, eventId, JSON.stringify({ event_id: eventId, label }));
}

function authorizeDeletion(db: DatabaseSync, workspaceId: string, userId: string): void {
  db.prepare(`
    UPDATE workspaces SET status = 'deleting'
    WHERE id = ? AND workspace_id = ?
  `).run(workspaceId, workspaceId);
  db.prepare(`
    INSERT INTO workspace_deletions
      (workspace_id, requested_by_user_id, status, requested_at, next_attempt_at)
    VALUES (?, ?, 'pending', 3, 3)
  `).run(workspaceId, userId);
}

describe("0018 account deletion migration", () => {
  it("covers every tenant table in both the resurrection guard and application purge list", () => {
    const db = migratedDatabase();
    const workspaceTables = (db.prepare(`
      SELECT DISTINCT schema.name AS name
      FROM sqlite_master AS schema
      JOIN pragma_table_info(schema.name) AS column_info
        ON column_info.name = 'workspace_id'
      WHERE schema.type = 'table'
        AND schema.name NOT IN (
          'workspace_deletions', 'workspace_deletion_kv_keys', 'workspaces'
        )
      ORDER BY schema.name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    const unguarded = db.prepare(`
      SELECT schema.name AS name
      FROM sqlite_master AS schema
      JOIN pragma_table_info(schema.name) AS column_info
        ON column_info.name = 'workspace_id'
      WHERE schema.type = 'table'
        AND schema.name NOT IN ('workspace_deletions', 'workspace_deletion_kv_keys')
        AND NOT EXISTS (
          SELECT 1 FROM sqlite_master AS trigger
          WHERE trigger.type = 'trigger'
            AND trigger.tbl_name = schema.name
            AND trigger.name LIKE '%reject_deleting_insert'
        )
      ORDER BY schema.name
    `).all() as Array<{ name: string }>;

    expect(unguarded).toEqual([]);
    expect([...WORKSPACE_PURGE_TABLES].sort()).toEqual(workspaceTables);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_deletions'").get())
      .toMatchObject({ name: "workspace_deletions" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_deletion_kv_keys'").get())
      .toMatchObject({ name: "workspace_deletion_kv_keys" });
    db.close();
  });

  it("keeps ordinary evidence immutable and permits only a tombstoned tenant delete", () => {
    const db = migratedDatabase();
    seedWorkspace(db, WS_ONE, USER_ONE, EVENT_ONE, "one");
    seedWorkspace(db, WS_TWO, USER_TWO, EVENT_TWO, "two");

    expect(() => db.prepare("DELETE FROM events WHERE workspace_id = ?").run(WS_ONE))
      .toThrow(/events are append-only/);
    authorizeDeletion(db, WS_ONE, USER_ONE);
    expect(() => db.prepare("UPDATE events SET kind = 'changed' WHERE workspace_id = ?").run(WS_ONE))
      .toThrow(/events are append-only/);
    expect(() => db.prepare(`
      INSERT INTO events
        (workspace_id, event_id, occurred_at, kind, ingested_at, raw_json)
      VALUES (?, ?, '2026-08-30T00:00:00Z', 'command.completed', 4, '{}')
    `).run(WS_ONE, `evt_01J${"S".repeat(23)}`)).toThrow(/workspace deletion in progress/);

    db.prepare("DELETE FROM events WHERE workspace_id = ?").run(WS_ONE);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 0 });
    expect(() => db.prepare("DELETE FROM events WHERE workspace_id = ?").run(WS_TWO))
      .toThrow(/events are append-only/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_TWO))
      .toMatchObject({ count: 1 });
    db.close();
  });

  it("lets only the exact active personal-workspace owner create a tombstone", () => {
    const db = migratedDatabase();
    seedWorkspace(db, WS_ONE, USER_ONE, EVENT_ONE, "one");
    seedWorkspace(db, WS_TWO, USER_TWO, EVENT_TWO, "two");
    db.prepare("UPDATE workspaces SET status = 'deleting' WHERE id = ?").run(WS_ONE);

    expect(() => db.prepare(`
      INSERT INTO workspace_deletions
        (workspace_id, requested_by_user_id, status, requested_at, next_attempt_at)
      VALUES (?, ?, 'pending', 3, 3)
    `).run(WS_ONE, USER_TWO)).toThrow(/requires its active owner|other workspace links/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_deletions").get())
      .toMatchObject({ count: 0 });

    db.prepare(`
      INSERT INTO workspace_deletions
        (workspace_id, requested_by_user_id, status, requested_at, next_attempt_at)
      VALUES (?, ?, 'pending', 3, 3)
    `).run(WS_ONE, USER_ONE);
    expect(db.prepare("SELECT status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "pending" });
    db.close();
  });

  it("rolls back a mixed-tenant purge instead of crossing the authorization boundary", () => {
    const db = migratedDatabase();
    seedWorkspace(db, WS_ONE, USER_ONE, EVENT_ONE, "one");
    seedWorkspace(db, WS_TWO, USER_TWO, EVENT_TWO, "two");
    authorizeDeletion(db, WS_ONE, USER_ONE);

    db.exec("BEGIN IMMEDIATE");
    expect(() => {
      try {
        db.prepare("DELETE FROM events WHERE workspace_id = ?").run(WS_ONE);
        db.prepare("DELETE FROM events WHERE workspace_id = ?").run(WS_TWO);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/events are append-only/);

    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_TWO))
      .toMatchObject({ count: 1 });
    db.close();
  });

  it("never refunds the lifetime beta issuance and keeps the non-PII tombstone", () => {
    const db = migratedDatabase();
    seedWorkspace(db, WS_ONE, USER_ONE, EVENT_ONE, "one");
    seedWorkspace(db, WS_TWO, USER_TWO, EVENT_TWO, "two");
    expect(db.prepare("SELECT active_accounts FROM hosted_beta_capacity WHERE id = 'global'").get())
      .toMatchObject({ active_accounts: 2 });

    authorizeDeletion(db, WS_ONE, USER_ONE);
    db.prepare("DELETE FROM workspace_entitlements WHERE workspace_id = ?").run(WS_ONE);
    expect(db.prepare("SELECT active_accounts FROM hosted_beta_capacity WHERE id = 'global'").get())
      .toMatchObject({ active_accounts: 2 });
    expect(() => db.prepare("DELETE FROM workspace_deletions WHERE workspace_id = ?").run(WS_ONE))
      .toThrow(/tombstones are permanent/);
    db.close();
  });
});
