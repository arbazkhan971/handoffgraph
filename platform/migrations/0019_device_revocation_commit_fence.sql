-- Commit-time device authorization for hosted mutations.
--
-- Initial bearer authentication necessarily happens before request-body
-- parsing and quota preparation.  Revocation can commit during that interval,
-- so the receipt insert inside the final D1 batch is the linearization point:
-- either ingestion commits first, or revocation wins and this trigger rolls
-- the entire quota/receipt/event/projection batch back.
--
-- Existing migrated receipts may have device_id=NULL and remain readable.
-- Only new inserts must name the still-active device bound to the same tenant.

CREATE TRIGGER idempotency_keys_require_active_device
BEFORE INSERT ON idempotency_keys
WHEN NEW.device_id IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM devices
    WHERE id = NEW.device_id
      AND workspace_id = NEW.workspace_id
      AND revoked_at IS NULL
  )
BEGIN
    SELECT RAISE(ABORT, 'active device required');
END;
