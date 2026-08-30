-- Bind each HandoffGraph browser session to the WorkOS AuthKit session that
-- created it. The provider session id is required for AuthKit's browser logout
-- endpoint. It is a logout handle, not a bearer credential, but remains
-- bounded and is never exposed by account read models.

ALTER TABLE account_sessions
ADD COLUMN workos_session_id TEXT
CHECK (
  workos_session_id IS NULL OR (
    length(workos_session_id) BETWEEN 9 AND 128
    AND substr(workos_session_id, 1, 8) = 'session_'
    AND substr(workos_session_id, 9) NOT GLOB '*[^0-9A-Za-z_-]*'
  )
);

-- A session minted before this migration has no provider session id and
-- therefore cannot complete a truthful WorkOS logout. Fail closed by forcing
-- one reauthentication; the next callback records the verified `sid`.
UPDATE account_sessions
SET revoked_at = created_at
WHERE workos_session_id IS NULL
  AND revoked_at IS NULL;

-- A WorkOS session is globally unique across active and revoked bound rows.
-- The partial predicate permits only historical legacy NULL rows; it does not
-- permit a revoked provider SID to be reused by another retained row.
CREATE UNIQUE INDEX idx_account_sessions_workos_session
ON account_sessions(workos_session_id)
WHERE workos_session_id IS NOT NULL;

-- A user may have at most one live local browser credential. This makes the
-- user-scoped sign-out UPDATE return one deterministic current WorkOS SID and
-- turns unexpected duplicate issuance into a controlled constraint failure.
CREATE UNIQUE INDEX idx_account_sessions_active_user_unique
ON account_sessions(user_id)
WHERE revoked_at IS NULL;

-- ALTER TABLE must leave the column nullable so existing rows can be carried
-- forward and revoked. All credentials minted by the upgraded application are
-- required to carry a verified provider session id. A verified reauthentication
-- may rotate the provider SID in place only while the local row stays active
-- and both local bearer/CSRF hashes rotate in the same statement.
CREATE TRIGGER account_sessions_require_workos_session_insert
BEFORE INSERT ON account_sessions
WHEN NEW.workos_session_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'workos session id required');
END;

CREATE TRIGGER account_sessions_forbid_workos_session_update
BEFORE UPDATE OF workos_session_id ON account_sessions
WHEN NEW.workos_session_id IS NULL
  OR (
    NEW.workos_session_id IS NOT OLD.workos_session_id
    AND (
      OLD.revoked_at IS NOT NULL
      OR NEW.revoked_at IS NOT NULL
      OR NEW.id IS NOT OLD.id
      OR NEW.user_id IS NOT OLD.user_id
      OR NEW.token_hash IS OLD.token_hash
      OR NEW.csrf_hash IS OLD.csrf_hash
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'workos session id change requires active credential rotation');
END;
