-- The user's designation goes.
--
-- The owner's words: "I see this designation field inside user, we don't need
-- it at all, rip it off everywhere". A job title on a CRM user was decoration
-- — nobody's permission, routing or report ever read it.
--
-- The lead's own `designation` field is untouched: that one describes the
-- *contact's* job, which a property desk asks for.

ALTER TABLE ipy_user DROP COLUMN IF EXISTS designation;
