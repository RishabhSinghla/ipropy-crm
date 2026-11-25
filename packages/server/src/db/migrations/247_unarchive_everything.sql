-- The Archive module was removed (owner's instruction, 25 November 2026). Nothing is deleted:
-- every archived record goes back into the list of its own module (Contacts, Inventories,
-- Associates, ...) with its history, and the 12-hour "Lost goes to the Archive" timer is cleared.
UPDATE ipy_record
   SET archived_at = NULL, lost_archive_due_at = NULL
 WHERE archived_at IS NOT NULL OR lost_archive_due_at IS NOT NULL;
