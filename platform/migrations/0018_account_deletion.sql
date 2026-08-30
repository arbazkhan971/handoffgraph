-- Owner-confirmed hosted account/workspace deletion.
--
-- Ordinary retention and application paths still cannot update or delete
-- append-only evidence.  The one exception is a workspace carrying a durable
-- deletion tombstone created by the authenticated account-plane route.  The
-- tombstone is deliberately not foreign-keyed to workspaces: it is both the
-- retry cursor for cross-service R2 cleanup and the permanent resurrection
-- guard after every tenant row has been removed.

CREATE TABLE workspace_deletions (
    workspace_id         TEXT PRIMARY KEY
                         CHECK(length(workspace_id) = 30 AND
                               substr(workspace_id, 1, 4) = 'wsp_' AND
                               substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                               substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    requested_by_user_id TEXT
                         CHECK(requested_by_user_id IS NULL OR
                               (length(requested_by_user_id) = 30 AND
                                substr(requested_by_user_id, 1, 4) = 'usr_' AND
                                substr(requested_by_user_id, 5, 1) GLOB '[0-7]' AND
                                substr(requested_by_user_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
    status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending', 'r2_grace', 'complete')),
    requested_at         INTEGER NOT NULL CHECK(requested_at >= 0),
    next_attempt_at      INTEGER,
    workos_deleted_at    INTEGER,
    completed_at         INTEGER,
    r2_sweeps            INTEGER NOT NULL DEFAULT 0 CHECK(r2_sweeps >= 0),
    CHECK(workos_deleted_at IS NULL OR workos_deleted_at >= requested_at),
    CHECK(
      (status = 'pending' AND requested_by_user_id IS NOT NULL AND
       next_attempt_at IS NOT NULL AND completed_at IS NULL) OR
      (status = 'r2_grace' AND requested_by_user_id IS NULL AND
       next_attempt_at IS NOT NULL AND workos_deleted_at IS NOT NULL AND
       completed_at IS NULL) OR
      (status = 'complete' AND requested_by_user_id IS NULL AND
       next_attempt_at IS NULL AND workos_deleted_at IS NOT NULL AND
       completed_at IS NOT NULL AND
       completed_at >= requested_at)
    )
);
CREATE INDEX idx_workspace_deletions_due
    ON workspace_deletions(status, next_attempt_at, workspace_id);

-- Exact edge-cache keys are retained only while the deletion saga needs to
-- invalidate them before and after the D1 purge. They contain hashes, never
-- raw credentials, and are removed atomically when the tombstone completes.
CREATE TABLE workspace_deletion_kv_keys (
    workspace_id TEXT NOT NULL,
    namespace    TEXT NOT NULL CHECK(namespace IN ('apikey', 'gateway')),
    cache_key    TEXT NOT NULL,
    deleted_at   INTEGER CHECK(deleted_at IS NULL OR deleted_at >= 0),
    PRIMARY KEY (workspace_id, namespace, cache_key),
    CHECK(
      (namespace = 'apikey' AND length(cache_key) = 79 AND
       substr(cache_key, 1, 15) = 'apikey-verdict:' AND
       substr(cache_key, 16) NOT GLOB '*[^0-9a-f]*') OR
      (namespace = 'gateway' AND length(cache_key) = 67 AND
       substr(cache_key, 1, 3) = 'vk:' AND
       substr(cache_key, 4) NOT GLOB '*[^0-9a-f]*')
    )
);
CREATE INDEX idx_workspace_deletion_kv_pending
    ON workspace_deletion_kv_keys(workspace_id, deleted_at, namespace, cache_key);

CREATE TRIGGER workspace_deletion_kv_keys_require_pending_insert
BEFORE INSERT ON workspace_deletion_kv_keys
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_deletions
  WHERE workspace_id = NEW.workspace_id AND status = 'pending'
)
BEGIN
    SELECT RAISE(ABORT, 'cache cleanup requires a pending workspace deletion');
END;

-- Application authorization is still mandatory, but the tombstone itself is
-- powerful enough to open append-only DELETE guards.  Require it to name the
-- active owner of that exact personal workspace after the acceptance batch
-- has locked the workspace.  The table intentionally has no lasting foreign
-- key because those referenced rows are about to be purged.
CREATE TRIGGER workspace_deletions_require_owner_insert
BEFORE INSERT ON workspace_deletions
WHEN NEW.status <> 'pending'
  OR NOT EXISTS (
    SELECT 1
    FROM workspaces
    JOIN users
      ON users.id = NEW.requested_by_user_id
     AND users.personal_workspace_id = workspaces.id
     AND users.status = 'active'
    JOIN workspace_members
      ON workspace_members.workspace_id = workspaces.id
     AND workspace_members.user_id = users.id
     AND workspace_members.role = 'owner'
     AND workspace_members.status = 'active'
    WHERE workspaces.id = NEW.workspace_id
      AND workspaces.workspace_id = NEW.workspace_id
      AND workspaces.status = 'deleting'
  )
BEGIN
    SELECT RAISE(ABORT, 'workspace deletion requires its active owner');
END;

-- Deleting users would follow user foreign keys into another tenant. Refuse
-- to mint the tombstone while any such row exists, and perform this check in
-- the same transaction as the credential revocation so a concurrent team
-- operation cannot race the application-level preflight.
CREATE TRIGGER workspace_deletions_reject_foreign_links_insert
BEFORE INSERT ON workspace_deletions
WHEN EXISTS (
  SELECT 1 FROM workspace_members
  WHERE user_id = NEW.requested_by_user_id
    AND workspace_id <> NEW.workspace_id
)
OR EXISTS (
  SELECT 1 FROM workspace_invites
  WHERE workspace_id <> NEW.workspace_id
    AND (created_by = NEW.requested_by_user_id OR
         accepted_by = NEW.requested_by_user_id)
)
BEGIN
    SELECT RAISE(ABORT, 'account has other workspace links');
END;

-- A completed tombstone is a privacy/safety control, not tenant content.  It
-- contains no provider subject, email, name, payload, or object key and may
-- not be removed to recreate the deleted tenant ID.
CREATE TRIGGER workspace_deletions_forbid_delete
BEFORE DELETE ON workspace_deletions
BEGIN
    SELECT RAISE(ABORT, 'workspace deletion tombstones are permanent');
END;

CREATE TRIGGER workspace_deletions_monotone_status
BEFORE UPDATE ON workspace_deletions
WHEN NEW.workspace_id <> OLD.workspace_id
  OR NEW.requested_at <> OLD.requested_at
  OR OLD.status = 'complete'
  OR (OLD.workos_deleted_at IS NOT NULL AND
      NEW.workos_deleted_at IS NOT OLD.workos_deleted_at)
  OR NEW.r2_sweeps < OLD.r2_sweeps
  OR (OLD.status = 'pending' AND NEW.status = 'complete')
  OR (OLD.status = 'pending' AND NEW.status = 'pending' AND
      NEW.requested_by_user_id <> OLD.requested_by_user_id)
  OR (OLD.status = 'r2_grace' AND NEW.status = 'pending')
BEGIN
    SELECT RAISE(ABORT, 'workspace deletion state is immutable or terminal');
END;

-- -------------------------------------------------------------------------
-- Deletion-aware append-only guards
-- -------------------------------------------------------------------------

DROP TRIGGER events_forbid_delete;
CREATE TRIGGER events_forbid_delete
BEFORE DELETE ON events
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_deletions WHERE workspace_id = OLD.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;

DROP TRIGGER events_reject_delete;
CREATE TRIGGER events_reject_delete
BEFORE DELETE ON events
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_deletions WHERE workspace_id = OLD.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;

DROP TRIGGER audit_chain_forbid_delete;
CREATE TRIGGER audit_chain_forbid_delete
BEFORE DELETE ON audit_chain
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
 AND NOT EXISTS (
   SELECT 1 FROM workspace_deletions WHERE workspace_id = OLD.workspace_id
 )
BEGIN
    SELECT RAISE(ABORT, 'audit chain is append-only');
END;

DROP TRIGGER artifact_file_list_reject_delete;
CREATE TRIGGER artifact_file_list_reject_delete
BEFORE DELETE ON artifact_file_list
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_deletions WHERE workspace_id = OLD.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'artifact objects are never deleted by retention');
END;

DROP TRIGGER dashboard_versions_forbid_delete;
CREATE TRIGGER dashboard_versions_forbid_delete
BEFORE DELETE ON dashboard_versions
WHEN EXISTS (SELECT 1 FROM dashboards WHERE id = OLD.dashboard_id)
 AND NOT EXISTS (
   SELECT 1 FROM workspace_deletions WHERE workspace_id = OLD.workspace_id
 )
BEGIN
    SELECT RAISE(ABORT, 'dashboard versions are append-only');
END;

DROP TRIGGER gateway_requests_reject_delete;
CREATE TRIGGER gateway_requests_reject_delete
BEFORE DELETE ON gateway_requests
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_deletions WHERE workspace_id = OLD.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'gateway_requests is append-only');
END;

DROP TRIGGER attachments_reject_delete;
CREATE TRIGGER attachments_reject_delete
BEFORE DELETE ON attachments
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_deletions WHERE workspace_id = OLD.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'attachments are never deleted by a sweep');
END;

DROP TRIGGER workspace_members_last_owner_delete;
CREATE TRIGGER workspace_members_last_owner_delete
BEFORE DELETE ON workspace_members
WHEN OLD.role = 'owner' AND OLD.status = 'active'
 AND EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
 AND NOT EXISTS (
   SELECT 1 FROM workspace_deletions WHERE workspace_id = OLD.workspace_id
 )
 AND NOT EXISTS (
   SELECT 1 FROM workspace_members
   WHERE workspace_id = OLD.workspace_id
     AND user_id <> OLD.user_id
     AND role = 'owner'
     AND status = 'active'
 )
BEGIN
    SELECT RAISE(ABORT, 'workspace must retain an owner');
END;

-- -------------------------------------------------------------------------
-- Resurrection guards
-- -------------------------------------------------------------------------
--
-- Authentication is revoked when the tombstone is inserted, but a request
-- that authenticated immediately before that transaction may still reach a
-- later INSERT.  These guards make the D1 write itself the final authority.
-- Updates cannot recreate a purged row; inserts can, so every tenant-scoped
-- table present through migration 0018 is covered here.

CREATE TRIGGER workspaces_reject_deleting_insert
BEFORE INSERT ON workspaces
WHEN EXISTS (
  SELECT 1 FROM workspace_deletions
  WHERE workspace_id = NEW.id OR workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER users_reject_deleting_insert
BEFORE INSERT ON users
WHEN EXISTS (
  SELECT 1 FROM workspace_deletions
  WHERE workspace_id = NEW.personal_workspace_id
)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER users_reject_deleting_workspace_update
BEFORE UPDATE OF personal_workspace_id ON users
WHEN EXISTS (
  SELECT 1 FROM workspace_deletions
  WHERE workspace_id = NEW.personal_workspace_id
)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER account_sessions_reject_deleting_insert
BEFORE INSERT ON account_sessions
WHEN EXISTS (
  SELECT 1
  FROM users
  JOIN workspace_deletions
    ON workspace_deletions.workspace_id = users.personal_workspace_id
  WHERE users.id = NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER provider_identities_reject_deleting_insert
BEFORE INSERT ON provider_identities
WHEN EXISTS (
  SELECT 1
  FROM users
  JOIN workspace_deletions
    ON workspace_deletions.workspace_id = users.personal_workspace_id
  WHERE users.id = NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER workspace_members_reject_deleting_insert
BEFORE INSERT ON workspace_members
WHEN EXISTS (
  SELECT 1 FROM workspace_deletions
  WHERE workspace_id = NEW.workspace_id
     OR requested_by_user_id = NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER alert_rules_reject_deleting_insert
BEFORE INSERT ON alert_rules
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER annotation_items_reject_deleting_insert
BEFORE INSERT ON annotation_items
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER annotation_queues_reject_deleting_insert
BEFORE INSERT ON annotation_queues
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER api_keys_reject_deleting_insert
BEFORE INSERT ON api_keys
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER artifact_file_list_reject_deleting_insert
BEFORE INSERT ON artifact_file_list
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER attachments_reject_deleting_insert
BEFORE INSERT ON attachments
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER audit_chain_reject_deleting_insert
BEFORE INSERT ON audit_chain
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER checkpoints_reject_deleting_insert
BEFORE INSERT ON checkpoints
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER dashboard_shares_reject_deleting_insert
BEFORE INSERT ON dashboard_shares
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER dashboard_versions_reject_deleting_insert
BEFORE INSERT ON dashboard_versions
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER dashboards_reject_deleting_insert
BEFORE INSERT ON dashboards
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER devices_reject_deleting_insert
BEFORE INSERT ON devices
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER ee_masking_rules_reject_deleting_insert
BEFORE INSERT ON ee_masking_rules
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER ee_scim_tokens_reject_deleting_insert
BEFORE INSERT ON ee_scim_tokens
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER ee_sso_connections_reject_deleting_insert
BEFORE INSERT ON ee_sso_connections
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER eval_configs_reject_deleting_insert
BEFORE INSERT ON eval_configs
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER eval_runs_reject_deleting_insert
BEFORE INSERT ON eval_runs
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER events_reject_deleting_insert
BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER exports_reject_deleting_insert
BEFORE INSERT ON exports
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER gateway_capture_bodies_reject_deleting_insert
BEFORE INSERT ON gateway_capture_bodies
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER gateway_keys_reject_deleting_insert
BEFORE INSERT ON gateway_keys
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER gateway_requests_reject_deleting_insert
BEFORE INSERT ON gateway_requests
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER handoffs_reject_deleting_insert
BEFORE INSERT ON handoffs
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER idempotency_keys_reject_deleting_insert
BEFORE INSERT ON idempotency_keys
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER playground_runs_reject_deleting_insert
BEFORE INSERT ON playground_runs
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER quota_reservations_reject_deleting_insert
BEFORE INSERT ON quota_reservations
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER repositories_reject_deleting_insert
BEFORE INSERT ON repositories
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER retention_policies_reject_deleting_insert
BEFORE INSERT ON retention_policies
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER sessions_reject_deleting_insert
BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER simulation_runs_reject_deleting_insert
BEFORE INSERT ON simulation_runs
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER simulation_scenarios_reject_deleting_insert
BEFORE INSERT ON simulation_scenarios
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER span_fingerprints_reject_deleting_insert
BEFORE INSERT ON span_fingerprints
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER span_observations_reject_deleting_insert
BEFORE INSERT ON span_observations
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER spans_reject_deleting_insert
BEFORE INSERT ON spans
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER traces_reject_deleting_insert
BEFORE INSERT ON traces
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER webhook_cursors_reject_deleting_insert
BEFORE INSERT ON webhook_cursors
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER webhook_deliveries_reject_deleting_insert
BEFORE INSERT ON webhook_deliveries
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER webhook_endpoints_reject_deleting_insert
BEFORE INSERT ON webhook_endpoints
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER workspace_entitlements_reject_deleting_insert
BEFORE INSERT ON workspace_entitlements
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER workspace_invites_reject_deleting_insert
BEFORE INSERT ON workspace_invites
WHEN EXISTS (
  SELECT 1 FROM workspace_deletions
  WHERE workspace_id = NEW.workspace_id
     OR requested_by_user_id = NEW.created_by
     OR requested_by_user_id = NEW.accepted_by
)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER workspace_invites_reject_deleting_user_update
BEFORE UPDATE OF workspace_id, created_by, accepted_by ON workspace_invites
WHEN EXISTS (
  SELECT 1 FROM workspace_deletions
  WHERE workspace_id = NEW.workspace_id
     OR requested_by_user_id = NEW.created_by
     OR requested_by_user_id = NEW.accepted_by
)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER workspace_seats_reject_deleting_insert
BEFORE INSERT ON workspace_seats
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;

CREATE TRIGGER workstreams_reject_deleting_insert
BEFORE INSERT ON workstreams
WHEN EXISTS (SELECT 1 FROM workspace_deletions WHERE workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace deletion in progress'); END;
