-- Device bearer identities are immutable, and revocation is terminal.
--
-- The active-device entitlement counter is released on NULL -> non-NULL in
-- 0003. Allowing a later non-NULL -> NULL update would re-enable the bearer
-- token without reclaiming that counter, bypassing both revocation intent and
-- quota accounting. Identity changes would have the same audit ambiguity.

CREATE TRIGGER devices_reject_revocation_reversal
BEFORE UPDATE OF revoked_at ON devices
WHEN OLD.revoked_at IS NOT NULL
  AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
    SELECT RAISE(ABORT, 'device revocation is terminal');
END;

CREATE TRIGGER devices_reject_identity_mutation
BEFORE UPDATE OF id, workspace_id, token_hash, capabilities, created_at ON devices
WHEN OLD.id IS NOT NEW.id
  OR OLD.workspace_id IS NOT NEW.workspace_id
  OR OLD.token_hash IS NOT NEW.token_hash
  OR OLD.capabilities IS NOT NEW.capabilities
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'device identity is immutable');
END;
