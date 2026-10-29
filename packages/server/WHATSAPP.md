
## WhatsApp Lookup (29 October 2026)

Sidebar → **WhatsApp Lookup**, for every signed-in user: paste a number (any spelling — `+91 98912-22206`, `098912 22206`, `0091…`), press Enter, and see the profile name and picture through the linked number (OpenWA), or "not on WhatsApp", or "not connected". Code: `business/lookup.ts`, page `pages/WhatsAppLookup.tsx`, log table `ipy_wa_lookup_log` (migration `226`).

* **Manual and slow by rule** (each lookup is a query WhatsApp sees from a real person's number): one number per press, a 3-second pause between a user's lookups, 30 an hour per user, 300 a day for the whole team — all counted from the log, so a restart cannot reset them. The same number within ten minutes is answered from memory and costs nothing.
* **The picture is fetched by the CRM** (WhatsApp's own hosts only, 2 MB max) and shown as a data URL; WhatsApp's picture addresses expire.
* **Contacts shown are only ones this person may open** (`recordService.getRecord` as them). **Save avatar (and WhatsApp name)** is a separate press, performed as that person (their edit permission), refuses any record that does not hold the number, and — unlike the bulk checker — replaces the avatar and name because a person asked. It shares `downloadProfilePhoto` / `storeAvatar` with `numberCheck.ts`.
* Administrators read the log (who, number, result) on the same page. **Not proved against a real number**; tests use the pretend OpenWA.
