-- Photos called `a1818-none-4-bhk-02.jpg` lose the "none".
--
-- The naming pass builds a filename out of what the property actually has:
-- label, project, locality, configuration, size. A field that is *blank* is
-- skipped. A field that literally contains the word "None" is not blank, so it
-- was slugged and joined like any other word, and the buyer got a filename with
-- "none" sitting in the middle of it.
--
-- The code side has filtered these placeholder words for a while
-- (`PLACEHOLDERS` in `integrations/automation/n8n.ts`), so nothing new is named
-- this way. This is the files that were already named before that.
--
-- Only `file_name` is touched, never `storage_key`. The key is where the bytes
-- actually live; the name is what a browser calls the download and what a buyer
-- sees. Rewriting the key here would point every one of these rows at a file
-- that does not exist.

UPDATE ipy_attachment
   SET file_name = regexp_replace(
         file_name,
         -- A placeholder word standing as its own hyphen-separated segment.
         -- Anchored on both sides so a genuine word merely *containing* one of
         -- these is left alone: `nanded-heights` keeps its "na", and a property
         -- honestly called `none-such-road` would need the hyphens to match.
         '-(none|n-a|na|nil|null|tbd|unknown)(?=-)',
         '',
         'gi'
       )
 WHERE file_name ~* '-(none|n-a|na|nil|null|tbd|unknown)-';

-- The same word sitting immediately before the extension, which the pattern
-- above cannot see because there is no trailing hyphen to look ahead at.
UPDATE ipy_attachment
   SET file_name = regexp_replace(file_name, '-(none|n-a|na|nil|null|tbd|unknown)(\.[A-Za-z0-9]+)$', '\2', 'gi')
 WHERE file_name ~* '-(none|n-a|na|nil|null|tbd|unknown)\.[A-Za-z0-9]+$';

-- And any double hyphen the removals left behind.
UPDATE ipy_attachment
   SET file_name = regexp_replace(file_name, '--+', '-', 'g')
 WHERE file_name LIKE '%--%';
