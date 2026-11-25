-- Google RCS was removed (owner's instruction, 25 November 2026). Only the settings
-- card goes, and only if nobody filled it in; messages and conversations are untouched.
DELETE FROM ipy_integration
WHERE provider = 'google_rcs'
  AND is_active = false
  AND credentials = '{}'::jsonb
  AND config = '{}'::jsonb;
