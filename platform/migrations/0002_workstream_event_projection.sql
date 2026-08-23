-- Deterministic source coordinates for the event-derived workstream read model.
--
-- Raw events remain append-only. These columns let ingestion update the
-- derived workstreams table without making the result depend on batch arrival
-- order: the earliest workstream.started title wins, while lifecycle event ids
-- provide total-order tiebreakers. Completion is terminal across local and
-- hosted read models; later start/accept events cannot reopen a workstream.

ALTER TABLE workstreams ADD COLUMN title_event_at_ms INTEGER;
ALTER TABLE workstreams ADD COLUMN title_event_id TEXT;
ALTER TABLE workstreams ADD COLUMN status_event_at_ms INTEGER;
ALTER TABLE workstreams ADD COLUMN status_event_id TEXT;
