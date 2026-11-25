-- Meta lead capture (Facebook lead ads) and the Meta Conversions API were removed (owner's instruction,
-- 25 November 2026). New Facebook leads no longer arrive. The settings cards go, including any page token.
-- Every lead already captured, ipy_lead_inbox, ipy_facebook_* and ipy_meta_conversion stay in the database.
DELETE FROM ipy_integration WHERE provider IN ('facebook_leads', 'meta_conversions');
