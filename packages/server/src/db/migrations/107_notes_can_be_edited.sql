-- Notes become editable, with the previous words kept.
--
-- The desk's rule: the person who wrote a note can fix it later, and the fix is
-- honest — the note says "(edited)" and the earlier text stays reachable, like
-- a message app. Only the author (or an admin) may edit; nobody edits someone
-- else's note.

ALTER TABLE ipy_comment ADD COLUMN IF NOT EXISTS edit_history JSONB NOT NULL DEFAULT '[]';
