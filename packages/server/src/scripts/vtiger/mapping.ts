/**
 * Vtiger Contacts → iPropy `leads`. Designed against a live discovery pull
 * (25 modules, full field lists, 3 sample rows) rather than Vtiger's stock
 * schema — this account's Leads/Accounts/Potentials modules were never
 * enabled; every party record and every pipeline stage lives on Contacts,
 * which happens to be the same one-record-per-person shape `leads` already
 * uses. That's the whole reason this migration is a field mapping and not a
 * restructuring.
 *
 * Three custom fields whose Vtiger API name says "test" (`cf_contacts_test4`,
 * etc.) are not dead. Vtiger names a custom field after the internal slot it
 * was created in, never after what somebody typed into the label afterwards
 * — `cf_contacts_test4` is labelled "Lost Reason" and a live sample carried
 * "Deal with others" in it. Judge every field by its label and sample data,
 * never by its API name.
 *
 * What this file does NOT decide: the pipeline-stage mapping below has three
 * genuinely ambiguous entries (marked). Get sign-off on those before running
 * a real load — getting a stage wrong doesn't error, it just quietly
 * misrepresents ten years of funnel history.
 */

// ---------------------------------------------------------------------------
// Pipeline stage: Vtiger `contactstatus` → iPropy `status` (lead_status)
// ---------------------------------------------------------------------------
/*
  The seven Vtiger stages aren't in any describe() output — this version's
  API returns empty picklistValues for every field, on every module. They're
  recovered from the `timespentin*` field labels instead (Vtiger auto-tracks
  time-in-stage per pipeline stage, one field per stage, and label text
  survives even where the picklist listing doesn't) and confirmed against
  live sample data ("Lead Lost" appeared in a real row).

  Four of seven are unambiguous. Three are a judgement call:
    - "Meeting Fixed" could be a site visit or an office meeting — this
      product has both concepts (`SITE_VISIT_STATUS` is a different thing
      entirely, tracked per-visit rather than per-lead).
    - "Property Available" — a unit has been matched to them, not that
      they've seen it. Closest existing stage is "Qualified", but that name
      undersells what actually happened.
    - "Need to Track" reads as "needs a follow-up", which in iPropy is a
      *date on the record* (`next_followup_at`), not a pipeline stage — but
      the Vtiger data only has the stage, not a follow-up date, so the
      information still needs to land somewhere.
*/
export const STATUS_MAP: Record<string, string> = {
  'New Contact': 'New', // unambiguous
  'Meeting Fixed': 'Site Visit Scheduled', // judgement call — confirm
  'Negotiation': 'Negotiation', // exact match
  'Property Available': 'Qualified', // judgement call — confirm
  'Need to Track': 'Attempted Contact', // judgement call — confirm
  'Lead Won': 'Converted', // unambiguous
  'Lead Lost': 'Lost', // unambiguous
};

// ---------------------------------------------------------------------------
// Direct value matches — confirmed against live sample data, no
// reinterpretation needed. Anything a sample carries that ISN'T in the
// right-hand list gets added as a new picklist option at load time (never
// silently coerced into the nearest existing one — a value invented by
// whoever answered the phone ten years ago is not this script's to reword).
// ---------------------------------------------------------------------------
export const FIELD_MAP = {
  // Vtiger field -> iPropy field, both on the same module (Contacts -> leads)
  contacttype: 'contact_type', // 'Buyer' / 'Tenant' seen live — both exist in contact_type already
  leadsource: 'lead_source', // '99acres' exists; 'Propertywala' does not yet — will be added
  title: 'property_type', // 'Apartment' / 'Builder Floor' seen live — both exist already
  cf_contacts_beds: 'configuration', // '3 BHK' / '4 BHK' — single value, wrapped into an array
  happiness_rating: 'preferred_locations', // relabelled from Vtiger's stock "Locality" field; single value, wrapped into an array
  cf_contacts_test4: 'lost_reason', // mislabelled name, real data — see file header
  support_end_date: 'next_followup_at',
  email: 'email',
  secondaryemail: 'secondary_email',
  otherphone: 'alternate_phone',
  language: 'preferred_language',
} as const;

// mobile and name need transform logic, not a straight rename — handled in
// the extraction step, reusing the same normalise.ts pipeline the spreadsheet
// importer already uses for Indian phone/date/price formats. full_name is
// `trim(firstname + ' ' + lastname)`: this account is inconsistent about
// which of the two holds the whole name, and that formula is correct either
// way.

// ---------------------------------------------------------------------------
// System / audit fields — go to ipy_record columns, not the leads payload.
// createdtime/modifiedtime MUST be preserved as the real historical dates;
// defaulting to "now" would make ten years of history look like it all
// happened on migration day.
// ---------------------------------------------------------------------------
export const SYSTEM_FIELD_MAP = {
  createdtime: 'created_at',
  modifiedtime: 'updated_at',
  created_user_id: 'created_by', // resolved through a Vtiger-user -> iPropy-user crosswalk, built from the Users module
  assigned_user_id: 'owner_id', // same crosswalk
  id: '__external_ref', // stored in ipy_record_external_ref(source='vtiger', external_id), for idempotent re-runs
} as const;

// ---------------------------------------------------------------------------
// Consent — NOT written onto the lead. iPropy deliberately removed its three
// consent booleans from `leads` (CLAUDE.md, migration ~11 Aug) because
// consent belongs to a phone/email handle, not a person record. Vtiger's
// emailoptin/smsoptin/consent_* fields route to core/consent/index.ts instead.
// ---------------------------------------------------------------------------
export const CONSENT_FIELDS = [
  'emailoptin', 'smsoptin', 'consent_requested', 'consent_trash_data',
  'consent_lock_data', 'consent_track_email_engagement', 'consent_track_shared_documents',
];

// ---------------------------------------------------------------------------
// No home on a lead record, and why. Kept here so a reviewer can see they
// were considered, not dropped by omission.
// ---------------------------------------------------------------------------
export const NOTES_ONLY_FIELDS = {
  // Property-shaped attributes (which unit, which floor, which way it
  // faces) describe a *property*, not the person asking about it — putting
  // them on the lead record would misuse a field iPropy uses for something
  // else. All four were empty in every sample pulled, which is suggestive
  // but not proof at 20,000+ records — folded into qualification_notes as a
  // formatted line when present, rather than given dedicated fields, since
  // it's one lead's aside about one enquiry rather than structured data
  // anything downstream (matching, reporting) needs to query on.
  department: 'Unit Number',
  cf_contacts_ertyu: 'Unit Type',
  cf_contacts_test2: 'Portion',
  cf_contacts_test5: 'Floor',
  cf_contacts_test6: 'Facing',
  cf_contacts_test7: 'Area (Size)',
  // A single historical date, not a log — iPropy tracks site visits as their
  // own entity (SITE_VISIT_STATUS), and one column can't hold ten years of
  // them. Recorded as a note instead of forced into a field with different
  // meaning.
  birthday: 'Last Visited Date (Vtiger)',
};

// ---------------------------------------------------------------------------
// Explicitly not migrated to any field. Not lost: the full raw Vtiger row is
// kept in ipy_record_external_ref.meta regardless, so anything here can be
// recovered later without a second pass against the live account.
// ---------------------------------------------------------------------------
export const SKIP_FIELDS = [
  'primary_phone_field', 'primary_email_field', 'record_currency_id', 'record_conversion_rate',
  'emailoptin_requestcount', 'emailoptin_lastrequestedon', 'isclosed', 'time_zone',
  'profile_rating', 'profile_score', 'starred', 'notify_owner', 'isconvertedfromlead',
  'mailing_gps_lat', 'mailing_gps_lng', 'primary_linkedin', 'followers_linkedin',
  'primary_facebook', 'followers_facebook', 'facebookid', 'instagramid', 'twitterid',
  'data_erased', 'contact_no', 'last_contacted_via', 'last_contacted_on', 'imagename',
  'salutationtype', 'source', 'account_id', 'modifiedby',
];
