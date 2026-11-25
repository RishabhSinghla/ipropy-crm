-- Email sending from records, email templates and the mailbox (IMAP) reader were removed
-- (owner's instruction, 25 November 2026). SMTP stays: password-reset and alert emails use it.
-- Only the mailbox settings card goes; ipy_email_log, templates and every stored email stay in the database.
DELETE FROM ipy_integration WHERE provider = 'imap';
