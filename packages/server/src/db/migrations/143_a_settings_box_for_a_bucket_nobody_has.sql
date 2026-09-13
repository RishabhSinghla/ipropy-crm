-- The one setting in the Companion category, and the category with it.
--
-- `companion.apk_url` let an administrator point the Android download at a
-- storage bucket instead of at the CRM. It was added for the day the APK
-- outgrows living in the image (071), and that day has not come: the value has
-- been empty since it was created, and the CRM serves the file itself.
--
-- What it cost in the meantime was a whole section of the settings screen
-- asking the business a question it has no way to answer — "where is the
-- Android app downloaded from", with a paragraph about object storage under
-- it. A setting nobody can act on is not customisation, it is a decision
-- handed to somebody who did not want it.
--
-- The download route now always serves the build it was shipped with. If the
-- bucket day ever arrives, it is a smaller change to make then than this box
-- has been to look at since August.

DELETE FROM ipy_setting WHERE key = 'companion.apk_url';
