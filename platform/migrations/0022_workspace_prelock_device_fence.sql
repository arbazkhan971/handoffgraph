-- Make the account-deletion workspace prelock terminal for device mutations.
--
-- Migration 0019 was already applied to staging and checked only the device's
-- revoked_at value. A deletion request deliberately prelocks the workspace
-- before publishing its permanent R2 ledger; if that R2 write fails, devices
-- have not yet been revoked. Recreate the 0019 trigger so the final receipt
-- insert also requires the exact workspace to remain active. This is the D1
-- linearization point for an ingest request authenticated before the prelock.

DROP TRIGGER IF EXISTS idempotency_keys_require_active_device;

CREATE TRIGGER idempotency_keys_require_active_device
BEFORE INSERT ON idempotency_keys
WHEN NEW.device_id IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM devices AS d
    JOIN workspaces AS w
      ON w.id = d.workspace_id AND w.workspace_id = d.workspace_id
    WHERE d.id = NEW.device_id
      AND d.workspace_id = NEW.workspace_id
      AND d.revoked_at IS NULL
      AND w.status = 'active'
  )
BEGIN
    SELECT RAISE(ABORT, 'active device required');
END;
