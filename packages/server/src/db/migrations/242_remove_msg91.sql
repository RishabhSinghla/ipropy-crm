-- SMS and RCS campaigns through MSG91 removed (owner's instruction, 25 November 2026).
-- The settings card goes; the campaign tables and their rows are left alone.
DELETE FROM ipy_integration WHERE provider = 'msg91';
