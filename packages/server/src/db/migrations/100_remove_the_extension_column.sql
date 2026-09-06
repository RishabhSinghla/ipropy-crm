-- The extension is gone as a concept.
--
-- It was a telephony dial-by-extension box that no provider integration in this
-- repo ever read: placeCall dials `telephony_number ?? phone` and never touches
-- the column. All it ever did in practice was sit on two forms (own profile,
-- admin user editor) and one list column, where the classic bug showed: the
-- editor sent `extension: '' || undefined` — undefined — on clear, so the PATCH
-- skipped the column entirely and a removed "100" reappeared on reload. Asked
-- for its removal outright, so the column goes with the UI.
ALTER TABLE ipy_user DROP COLUMN IF EXISTS extension;
