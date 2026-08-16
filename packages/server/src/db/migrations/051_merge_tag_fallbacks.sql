-- ===========================================================================
-- iPropy CRM — 051: stop the welcome message saying "interest in ."
--
-- The seeded "Instant lead response" workflow greets a new lead with
--
--   Hi {{first_name}}, thanks for your interest in {{interested_project}}.
--
-- "Interested In" is optional free text, so it is empty on most leads, and an
-- empty merge tag rendered as an empty string. What actually went out — and
-- what is sitting in the send queue right now — is
--
--   Hi Rishabh, thanks for your interest in . I am iPropy Admin from iPropy.
--
-- `renderTemplate` now understands `{{field|wording when empty}}` and tidies
-- the orphaned punctuation an empty tag leaves behind. That fixes the engine;
-- this fixes the rows. Seeded automation is create-only on purpose (see
-- CLAUDE.md § Conventions), so editing the seed does nothing to a database
-- that already has these workflows — every existing install keeps sending the
-- broken sentence until something rewrites the row.
--
-- The `{{first_name}} {{last_name}}` pairs go the same way. Migration 026
-- replaced the two halves with a single `full_name`; the halves are still
-- derived on the fly, so a two-word name looked fine and a one-word name —
-- which is half the enquiries on an Indian property desk — produced
-- "Call new lead: Rishabh " with a trailing space.
--
-- Text replacement rather than jsonb surgery: the tags appear inside several
-- different keys (`fallbackText`, `subject`, `body`, `title`) and the point is
-- to catch them wherever an admin's own edits have since moved them.
-- ===========================================================================

UPDATE ipy_workflow_task
SET config = replace(config::text, '{{first_name}} {{last_name}}', '{{full_name}}')::jsonb
WHERE config::text LIKE '%{{first_name}} {{last_name}}%';

UPDATE ipy_workflow_task
SET config = replace(
      config::text,
      'thanks for your interest in {{interested_project}}.',
      'thanks for your interest in {{interested_project|our properties}}.'
    )::jsonb
WHERE config::text LIKE '%thanks for your interest in {{interested_project}}.%';

UPDATE ipy_workflow_task
SET config = replace(config::text, 'Hi {{first_name}},', 'Hi {{first_name|there}},')::jsonb
WHERE config::text LIKE '%Hi {{first_name}},%';

-- Anything already queued for a human to send carries the rendered text, not
-- the template, so fixing the workflow does nothing for the messages waiting
-- in the send queue this morning. They are the ones somebody is about to send.
UPDATE ipy_device_send
SET body = replace(body, 'thanks for your interest in .', 'thanks for your interest in our properties.')
WHERE status IN ('pending', 'opened')
  AND body LIKE '%thanks for your interest in .%';
