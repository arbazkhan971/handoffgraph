import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(testDirectory, "../migrations");
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort();
const workosMigrationName = "0021_workos_session_logout.sql";
const workosMigration = readFileSync(
  resolve(migrationsDirectory, workosMigrationName),
  "utf8",
);

const WORKSPACE_ID = `wsp_01J${"A".repeat(23)}`;
const USER_ID = `usr_01J${"B".repeat(23)}`;
const SID = "session_01HQSXZGF8FHF7A9ZZFCW4387R";
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function sessionID(sequence: number): string {
  return `acs_01J${"C".repeat(22)}${ID_ALPHABET[sequence]}`;
}

function digest(sequence: number): string {
  return sequence.toString(16).padStart(64, "0");
}

function workspaceID(sequence: number): string {
  return `wsp_01J${"D".repeat(22)}${ID_ALPHABET[sequence]}`;
}

function userID(sequence: number): string {
  return `usr_01J${"E".repeat(22)}${ID_ALPHABET[sequence]}`;
}

function insertAccount(db: DatabaseSync, sequence: number): string {
  const workspace = workspaceID(sequence);
  const user = userID(sequence);
  db.prepare(`
    INSERT INTO workspaces (id, workspace_id, name, status, created_at)
    VALUES (?, ?, 'Additional WorkOS migration account', 'active', 1)
  `).run(workspace, workspace);
  db.prepare(`
    INSERT INTO users
      (id, email, email_verified, status, personal_workspace_id, created_at, updated_at)
    VALUES (?, ?, 1, 'active', ?, 1, 1)
  `).run(user, `workos-${sequence}@example.test`, workspace);
  return user;
}

function beforeWorkOSMigration(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrationNames.filter((name) => name < workosMigrationName)) {
    db.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));
  }
  db.prepare(`
    INSERT INTO workspaces (id, workspace_id, name, status, created_at)
    VALUES (?, ?, 'WorkOS migration test', 'active', 1)
  `).run(WORKSPACE_ID, WORKSPACE_ID);
  db.prepare(`
    INSERT INTO users
      (id, email, email_verified, status, personal_workspace_id, created_at, updated_at)
    VALUES (?, 'workos-migration@example.test', 1, 'active', ?, 1, 1)
  `).run(USER_ID, WORKSPACE_ID);
  return db;
}

function insertLegacySession(
  db: DatabaseSync,
  sequence: number,
  revokedAt: number | null = null,
): void {
  db.prepare(`
    INSERT INTO account_sessions
      (id, user_id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, revoked_at)
    VALUES (?, ?, ?, ?, 10, 100, 10, ?)
  `).run(sessionID(sequence), USER_ID, digest(sequence), "a".repeat(64), revokedAt);
}

function insertBoundSession(
  db: DatabaseSync,
  sequence: number,
  workosSessionID: string | null,
  userId = USER_ID,
  revokedAt: number | null = null,
): void {
  db.prepare(`
    INSERT INTO account_sessions
      (id, user_id, token_hash, csrf_hash, created_at, expires_at,
       last_seen_at, revoked_at, workos_session_id)
    VALUES (?, ?, ?, ?, 20, 200, 20, ?, ?)
  `).run(
    sessionID(sequence),
    userId,
    digest(sequence),
    "b".repeat(64),
    revokedAt,
    workosSessionID,
  );
}

describe("0021 WorkOS session logout migration", () => {
  it("applies after 0001-0020 and revokes only unbound active legacy sessions", () => {
    expect(migrationNames).toContain(workosMigrationName);
    const db = beforeWorkOSMigration();
    insertLegacySession(db, 0);
    insertLegacySession(db, 1, 30);

    db.exec(workosMigration);

    const columns = db.prepare("PRAGMA table_info(account_sessions)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("workos_session_id");
    expect(db.prepare(`
      SELECT id, workos_session_id, revoked_at
      FROM account_sessions ORDER BY id
    `).all()).toEqual([
      { id: sessionID(0), workos_session_id: null, revoked_at: 10 },
      { id: sessionID(1), workos_session_id: null, revoked_at: 30 },
    ]);
    db.close();
  });

  it("accepts bounded provider IDs and rejects NULL, malformed, or duplicate IDs", () => {
    const db = beforeWorkOSMigration();
    db.exec(workosMigration);
    const secondUser = insertAccount(db, 0);
    const thirdUser = insertAccount(db, 1);
    const fourthUser = insertAccount(db, 2);

    const minimum = "session_a";
    const maximum = `session_${"Z".repeat(120)}`;
    insertBoundSession(db, 0, minimum);
    insertBoundSession(db, 1, maximum, secondUser);
    insertBoundSession(db, 2, SID, thirdUser);

    expect(() => insertBoundSession(db, 3, null, fourthUser)).toThrow(/workos session id required/);
    for (const [offset, invalid] of [
      "session_",
      "other_01HQSXZGF8FHF7A9ZZFCW4387R",
      "session_bad/value",
      "session_bad value",
      "session_é",
      `session_${"Z".repeat(121)}`,
    ].entries()) {
      expect(() => insertBoundSession(db, 4 + offset, invalid, fourthUser)).toThrow(/CHECK constraint failed/);
    }
    expect(() => insertBoundSession(db, 10, SID, fourthUser)).toThrow(/UNIQUE constraint failed/);
    expect(() => insertBoundSession(db, 11, "session_second_active", USER_ID))
      .toThrow(/UNIQUE constraint failed: account_sessions.user_id/);
    expect(() => db.prepare(`
      UPDATE account_sessions SET workos_session_id = NULL WHERE id = ?
    `).run(sessionID(0))).toThrow(/requires active credential rotation/);
    expect(() => db.prepare(`
      UPDATE account_sessions SET workos_session_id = 'session_retargeted' WHERE id = ?
    `).run(sessionID(0))).toThrow(/requires active credential rotation/);
    expect(() => db.prepare(`
      UPDATE account_sessions
      SET workos_session_id = 'session_token_only', token_hash = ?
      WHERE id = ?
    `).run(digest(20), sessionID(0))).toThrow(/requires active credential rotation/);
    expect(() => db.prepare(`
      UPDATE account_sessions
      SET workos_session_id = 'session_user_retarget',
          user_id = ?,
          token_hash = ?,
          csrf_hash = ?
      WHERE id = ?
    `).run(fourthUser, digest(20), "c".repeat(64), sessionID(0)))
      .toThrow(/requires active credential rotation/);

    db.prepare(`
      UPDATE account_sessions
      SET workos_session_id = 'session_rotated',
          token_hash = ?,
          csrf_hash = ?
      WHERE id = ?
    `).run(digest(21), "c".repeat(64), sessionID(0));
    expect(db.prepare(`
      SELECT workos_session_id, token_hash, csrf_hash
      FROM account_sessions WHERE id = ?
    `).get(sessionID(0))).toEqual({
      workos_session_id: "session_rotated",
      token_hash: digest(21),
      csrf_hash: "c".repeat(64),
    });

    db.prepare("UPDATE account_sessions SET revoked_at = 30 WHERE id = ?").run(sessionID(0));
    expect(() => db.prepare(`
      UPDATE account_sessions
      SET workos_session_id = 'session_revoked_retarget',
          token_hash = ?,
          csrf_hash = ?
      WHERE id = ?
    `).run(digest(22), "d".repeat(64), sessionID(0)))
      .toThrow(/requires active credential rotation/);

    // Anonymous authentication replaces the one active local row in a single
    // transaction. The same verified WorkOS SID remains globally unique while
    // this controlled replacement succeeds without an uncontrolled D1 error.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM account_sessions WHERE id = ?").run(sessionID(2));
      insertBoundSession(db, 12, SID, thirdUser);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    expect(db.prepare(`
      SELECT id, workos_session_id FROM account_sessions
      WHERE workos_session_id = ?
    `).all(SID)).toEqual([{ id: sessionID(12), workos_session_id: SID }]);
    db.close();
  });
});
