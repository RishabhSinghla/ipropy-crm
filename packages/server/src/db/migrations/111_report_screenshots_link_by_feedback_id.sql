-- Report screenshots were links that pointed at nothing.
--
-- Migration 110's intent: the report's screenshots live in ipy_attachment
-- "exactly like photos on a property". But a photo on a property carries
-- record_id = <property id>, and ipy_attachment.record_id has a FOREIGN KEY to
-- ipy_record — the one id space every module's records share. A feedback row
-- is not in that space, so the very first report submitted with a screenshot
-- died on insert: constraint violation, HTTP 409, and the reporter saw "This
-- record is referenced elsewhere and cannot be changed or removed" — for an
-- INSERT that was neither changing nor removing anything. Every report with a
-- screenshot failed; text-only reports worked, which is why the flow looked
-- half-alive.
--
-- The fix is the link the table should have had from the start: a real
-- feedback_id column, the same shape tag_link uses for many-to-many and the
-- notifications table uses for context. record_id stays NULL on these rows —
-- the file-serving route already treats a null record as "belongs to whoever
-- uploaded it", which is exactly the permission a report screenshot wants
-- (the reporter sees his own shots, admins see everyone's).
--
-- No data migration: every insert that carried a screenshot failed outright,
-- so there are no orphan rows to re-home.

ALTER TABLE ipy_attachment
  ADD COLUMN feedback_id UUID REFERENCES ipy_feedback(id) ON DELETE CASCADE;

CREATE INDEX idx_attachment_feedback ON ipy_attachment(feedback_id);
