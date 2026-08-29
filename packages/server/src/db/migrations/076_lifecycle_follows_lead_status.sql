-- Lead Status and Lifecycle Stage stop being two things to keep in agreement.
--
-- Both are useful and neither is redundant. Status is the sales pipeline; the
-- lifecycle is the relationship, and WhatsApp and telephony both rank an inbound
-- match by it so a customer's call finds their record before a two-year-old
-- enquiry does. What was wrong was that a person had to fill in both, and nobody
-- ever did — a lead moved to Converted with its Lifecycle left on Lead, and
-- every report grouped by relationship was then wrong invisibly.
--
-- So: **status is the one a person sets, and the lifecycle follows it.** The
-- mapping below is an ordinary setting, editable in Admin → Settings → Leads,
-- and the sync is in core/entity/lifecycleFromStatus.ts.
--
-- Junk and Lost are deliberately unmapped. They say how an enquiry ended, not
-- what the person is: somebody who bought a floor last year and whose latest
-- enquiry went nowhere is still a Customer. An unmapped status changes nothing,
-- and the move is forward-only, so a repeat buyer is never demoted.

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('leads.stage_from_status',
   '{"New":"Lead","Attempted Contact":"Lead","Contacted":"Lead","Qualified":"Prospect","Site Visit Scheduled":"Prospect","Site Visit Done":"Prospect","Negotiation":"Prospect","Converted":"Customer"}'::jsonb,
   'sales',
   'Which Lead Status makes someone a Customer',
   'Lifecycle Stage is worked out from Lead Status, so nobody has to remember to change both. '
   || 'Each status on the left sets the stage on the right. A status you leave out changes nothing — '
   || 'which is why Junk and Lost are missing: they describe how an enquiry ended, not who the person '
   || 'is. Nobody is ever moved backwards, so a past customer sending a fresh enquiry stays a customer.')
ON CONFLICT (key) DO NOTHING;

-- The lifecycle is now derived, so it should not be typed into. Read-only rather
-- than hidden: it is worth seeing on the record, it is just not yours to set.
--
-- Scoped to the field on leads, and skipped if an admin has already customised
-- that field themselves — `is_customised` is the flag that stops the cold-start
-- seed undoing somebody's own decisions, and it means the same here.
UPDATE ipy_field f
   SET display_type = 'readonly', is_readonly = true
  FROM ipy_module m
 WHERE m.id = f.module_id
   AND m.name = 'leads'
   AND f.column_name = 'lifecycle_stage'
   AND COALESCE(f.is_customised, false) = false;
