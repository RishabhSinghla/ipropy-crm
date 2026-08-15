-- ===========================================================================
-- iPropy CRM — 050: the record number leaves the record header
--
-- A lead's header opened with its name and then "LD-00003", in two places at
-- once: a chip hard-coded beside the name, and again as the first summary chip,
-- because the auto-number is the first field of the first block and the seeded
-- header takes the first four.
--
-- Neither is information a salesperson opening a lead wants. The number is an
-- internal key — it stays on the record, stays in the list view, stays
-- searchable and still prints — it just stops taking the best space on the page.
--
-- The hard-coded chip is now `showRecordNumber` on the detail layout, off
-- unless an admin turns it on in Admin → Layout Designer. This migration does
-- the other half: drops the auto-number from the summary chips of layouts
-- nobody has edited.
--
-- **Layouts an administrator customised are left exactly as they are**
-- (`is_customised`, migration 031). If somebody deliberately put the number in
-- their header, that is their decision, not a default to be rewritten.
-- ===========================================================================

UPDATE ipy_layout l
SET config = config || jsonb_build_object('headerFields', COALESCE((
      SELECT jsonb_agg(h ORDER BY ord)
        FROM jsonb_array_elements_text(config->'headerFields') WITH ORDINALITY AS t(h, ord)
       WHERE h NOT IN (
         SELECT f.name FROM ipy_field f
          WHERE f.module_id = l.module_id AND f.uitype = 'autonumber'
       )
    ), '[]'::jsonb))
WHERE l.type = 'detail'
  AND l.is_customised = false
  AND config ? 'headerFields';
