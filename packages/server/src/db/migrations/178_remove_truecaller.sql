-- Truecaller is no longer part of iPROPY. Remove its configuration and
-- short-lived verification state while preserving any historical lead inbox
-- rows, which may still be useful as business audit history.
DELETE FROM ipy_integration WHERE provider = 'truecaller';
DROP TABLE IF EXISTS ipy_truecaller_request;
