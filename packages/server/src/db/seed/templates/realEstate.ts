import { F, type ModuleDef } from '../helpers.js';
import type { IndustryTemplate } from './types.js';

/**
 * The seeded real-estate data model — the starting metadata for an Indian
 * property desk.
 *
 * Everything here is *starting* metadata — an admin can add fields, reorder
 * blocks, rename labels, add modules, or delete what they don't need. Nothing
 * in the engine hard-codes any of these names except a small set of
 * integration touchpoints (documented in README).
 *
 * This file is data, not logic, and that is the whole point: a different trade
 * is a different file next to this one, not a fork of the engine.
 */

/** The two units an Indian buyer's requirement is ever quoted in. */
/*
  Area and price units live in `ipy_unit_master`, not here.

  These used to be two literal arrays copied into every area and currency
  field's `config.unitOptions`. The Area / Size Unit Master screen then edited
  a different list, so an admin who added Bigha or Marla changed a table
  nothing read — the form still offered Sq.ft. and Sq.yd., because each field
  carried a frozen copy made when it was seeded.

  Migration 118 tagged the fields with `unitMaster` to fix that, and the seed
  undid it on the next cold start: `config` is replaced wholesale for any field
  an admin has not customised, so the tag survived about an hour. Tagging them
  here is what makes it stick. `registry.syncUnitMasters` fills `unitOptions`
  from the master on every read, so the master is the only list.
*/

const MODULES: ModuleDef[] = [
  // =========================================================================
  // LEADS
  // =========================================================================
  {
    name: 'leads',
    // One party record for the whole journey: enquiry → prospect → customer.
    // Labelled the way the desk speaks — a second module for the "converted"
    // half would duplicate the person and split their timeline across two ids.
    label: 'Leads',
    singular: 'Lead',
    table: 'ipy_e_leads',
    icon: 'users',
    color: '#8b5cf6',
    sequence: 10,
    menuGroup: 'Sales',
    // One name field. Splitting a person into first/last has no payoff on an
    // Indian property desk — half the enquiries arrive as a single word and the
    // other half as three — and it doubled the typing on the busiest form here.
    // The old halves are retired in migration 026, not dropped.
    labelFields: ['full_name'],
    pipelineField: 'status',
    duplicateCheckFields: ['mobile', 'email'],
    /*
      A lead needs one way to reach them, not one particular way.

      `mobile` used to be mandatory on its own, which refused every email-only
      and NRI enquiry outright. What a rep does when a form will not save is type
      a fake number, so the strict rule produced worse data than the loose one
      and produced it permanently. Neither field is mandatory now; the pair is.
    */
    settings: { requireOneOf: [['mobile', 'email']] },
    supportsConversion: true,
    blocks: [
      {
        name: 'lead_information',
        label: 'Basic Information',
        fields: [
          F.autonum('lead_number', 'Record #', 'LD-'),
          F.text('full_name', 'Full Name', {
            mandatory: true, quickCreate: true, searchable: true, maxLength: 120,
          }),
          // The country code is not a question anybody in this business is
          // asked. It was a mandatory dropdown of its own until migration 064;
          // every lead is an Indian mobile, so the code became a setting on the
          // field — `codePrefix` — that the phone control paints in front of
          // the box and nothing has to fill in. Change it in one place and
          // every create form, every list and every WhatsApp link follows.
          // Not mandatory on its own — see `requireOneOf` on the module above.
          F.phone('mobile', 'Mobile', {
            quickCreate: true, maxLength: 10,
            config: { digits: 10, codePrefix: '+91' },
            help: 'Ten digits, without the country code',
          }),
          F.email('email', 'Email', { quickCreate: true }),
          F.email('secondary_email', 'Secondary Email'),
          F.phone('alternate_phone', 'Alternate Phone', { config: { codePrefix: '+91' } }),
          // No prefix on this one, deliberately: it stores the *full* dialable
          // number, which is what a wa.me link and the Cloud API send to. A
          // code painted in front of a value that already carries one reads as
          // +91 +91.
          F.phone('whatsapp_number', 'WhatsApp Number', { help: 'Defaults to mobile if left blank' }),
          /*
            One pipeline, one field. `lifecycle_stage` was a second
            relationship axis that nobody filled in by hand and every report
            then silently disagreed with; migration 103 retired it. Status is
            the pipeline and the relationship both.
          */
          F.pick('status', 'Pipeline Status', 'lead_status', { mandatory: true, quickCreate: true }),
          // Defaulted, because it is mandatory: every lead that arrives without
          // somebody choosing one — which is every automated source — is
          // otherwise rejected by validation.
          F.pick('contact_type', 'Type', 'contact_type', { default: 'Buyer' }),
          /*
            Read-only because the scorer sets it, not a person. When it was
            editable an edit was accepted, answered 200, written into the audit
            trail as a change that happened — and then overwritten by the
            scorer moments later. The rep saw Hot, the database kept Warm, and
            nothing said so.

            A rating somebody can set by hand is a reasonable thing to want. It
            is a different field from this one.
          */
          F.pick('rating', 'Rating', 'rating', { readonly: true }),
          F.owner(),
          F.text('company', 'Company', { searchable: true }),
          F.text('designation', 'Designation'),
        ],
      },
      {
        name: 'requirement',
        label: 'Requirement',
        fields: [
          // Was a lookup at the Projects module. Projects are gone, but "which
          // development are they after" is still the first thing a rep asks, so
          // it survives as free text rather than as a second record to create.
          F.text('interested_project', 'Interested In', { quickCreate: true, searchable: true }),
          F.pick('property_type', 'Property Type', 'property_type'),
          // Label carries no trace of "Configuration" — this business only
          // ever means bedroom count by it. The field's API name stays
          // 'configuration' (buyer matching reads it by that key; renaming it
          // is refused by FIELDS_USED_IN_CODE) but nobody sees that name.
          F.multipick('configuration', 'Bedrooms Wanted', 'configuration'),
          F.pick('purpose', 'Purpose', 'purpose'),
          // The price box plus its qualifier — the same pair the area control
          // made. A budget is "₹8,500/sq.yd." or "₹1.5 Cr total"; the qualifier
          // changes what the number means, so it rides with it.
          F.money('budget', 'Budget / Demand', { quickCreate: true, config: { min: 0, unitField: 'budget_unit', unitMaster: 'budget_demand' } }),
          F.pick('budget_unit', 'Budget Unit', 'price_unit', { default: 'total', displayType: 'hidden' }),
          F.pick('budget_band', 'Budget Band', 'budget_band'),
          F.multipick('preferred_locations', 'Preferred Locations', 'locality'),
          // One area with its own unit, not a min/max pair. A buyer says "about
          // 1200 sq.ft", not "between 1100 and 1300 carpet" — the range was two
          // fields collecting one answer, and neither carried the unit.
          F.area('area', 'Area', {
            config: { min: 0, unitField: 'area_unit', unitMaster: 'area' },
          }),
          F.pick('area_unit', 'Area Unit', 'area_unit', { default: 'sqft', displayType: 'hidden' }),
          F.pick('possession_timeline', 'Possession Timeline', 'purchase_timeline'),
          F.pick('funding_type', 'Funding Type', 'funding_type'),
          F.bool('loan_required', 'Loan Required'),
        ],
      },
      {
        name: 'source_attribution',
        label: 'Source & Attribution',
        fields: [
          F.pick('lead_source', 'Lead Source', 'lead_source', { quickCreate: true }),
          F.pick('sub_source', 'Sub Source', 'lead_sub_source'),
          F.ref('referred_by', 'Referred By', ['leads']),
          F.text('utm_source', 'UTM Source'),
          F.text('utm_medium', 'UTM Medium'),
          F.text('utm_campaign', 'UTM Campaign'),
          F.text('utm_term', 'UTM Term'),
          F.text('utm_content', 'UTM Content'),
          F.url('landing_page', 'Landing Page'),
          F.text('gclid', 'Google Click ID', { displayType: 'hidden' }),
          F.text('fbclid', 'Facebook Click ID', { displayType: 'hidden' }),
          F.text('ip_address', 'IP Address', { displayType: 'hidden' }),
        ],
      },
      {
        // The scored trio (ai_score, ai_score_reasons, ai_scored_at) is gone
        // — migration 104. A number nobody acted on, that the desk read as
        // noise, is not made better by three places showing it.
        name: 'ai_qualification',
        label: 'AI Qualification',
        fields: [
          F.textarea('qualification_notes', 'Qualification Notes'),
        ],
      },
      {
        name: 'follow_up',
        label: 'Follow Up',
        fields: [
          // Dates, not date-times. A follow-up is planned for a *day* on a
          // property desk; the clock time was noise the user had to dismiss on
          // every edit, and a stray 05:48 pm read as a commitment nobody made.
          F.date('next_followup_at', 'Next Follow-up'),
          F.date('last_contacted_at', 'Last Contacted', { readonly: true }),
          F.num('contact_attempts', 'Contact Attempts', { readonly: true }),
          F.num('first_response_secs', 'First Response (sec)', { readonly: true, displayType: 'detail_only' }),
        ],
      },
      {
        name: 'personal',
        label: 'Personal Details',
        collapsed: true,
        fields: [
          F.date('date_of_birth', 'Date of Birth'),
          F.date('anniversary', 'Anniversary'),
          F.pick('gender', 'Gender', 'gender'),
          F.pick('occupation', 'Occupation', 'occupation'),
          F.money('annual_income', 'Annual Income'),
          F.text('nationality', 'Nationality'),
          F.bool('is_nri', 'NRI'),
          F.pick('preferred_language', 'Preferred Language', 'language'),
          F.pick('preferred_contact', 'Preferred Contact Method', 'preferred_contact'),
          F.image('portrait_url', 'Photo'),
        ],
      },
      {
        name: 'kyc',
        label: 'KYC',
        collapsed: true,
        fields: [
          F.pick('kyc_status', 'KYC Status', 'kyc_status'),
          F.text('pan', 'PAN'),
          F.text('aadhaar_masked', 'Aadhaar (masked)', { help: 'Store only the last 4 digits' }),
          F.text('passport_number', 'Passport Number'),
        ],
      },
      /*
        Communication Preferences held three booleans — Do Not Call, Do Not
        WhatsApp, Email Opt Out — and they are deliberately not here any more.

        They were deleted from this CRM on 11 August. A tombstone stops them
        returning to a database that already has one, but a fresh install has no
        tombstones, so leaving them defined here meant every new deployment got
        three fields the owner had removed.

        They are also the wrong shape. Consent belongs to a phone number or an
        address, not to a lead record: someone can text STOP from a number the
        CRM has never seen, and that still has to be honoured. Keeping the fact
        in two places is what broke it — all three columns went in one go and
        the code kept naming them, so a do-not-call request was neither stored
        nor obeyed for three weeks.

        `core/consent/index.ts` is the one store now, keyed by handle and
        channel, and every send path reads it.
      */
      {
        name: 'relationship',
        label: 'Relationship Value',
        collapsed: true,
        fields: [
          F.score('engagement_score', 'Engagement Score'),
          F.money('lifetime_value', 'Lifetime Value', { readonly: true }),
          F.bool('is_converted', 'Converted', { readonly: true }),
          F.date('converted_at', 'Converted On', { readonly: true }),
          F.pick('lost_reason', 'Lost Reason', 'lost_reason'),
          F.pick('junk_reason', 'Junk Reason', 'junk_reason'),
        ],
      },
      {
        name: 'more',
        label: 'More Information',
        collapsed: true,
        fields: [
          F.address('address', 'Address'),
          F.json('requirement', 'Detailed Requirement', {
            displayType: 'detail_only',
            help: 'Free-form requirement captured by the AI assistant',
          }),
          F.textarea('description', 'Notes', { searchable: true }),
        ],
      },
    ],
    relations: [],
    views: [
      {
        name: 'All Leads', isDefault: true, showMetrics: true,
        columns: ['lead_number', 'full_name', 'mobile', 'status', 'lead_source', 'rating', 'budget', 'owner_id'],
        sortBy: 'created_at',
      },
      {
        name: 'Open Leads', showMetrics: true,
        columns: ['full_name', 'mobile', 'status', 'next_followup_at', 'owner_id'],
        filter: {
          logic: 'AND',
          conditions: [
            { field: 'status', operator: 'not_in', value: ['Junk', 'Lost', 'Converted'] },
          ],
        },
        sortBy: 'updated_at',
      },
      {
        name: 'Customers', showMetrics: true,
        columns: ['full_name', 'mobile', 'email', 'lifetime_value', 'kyc_status', 'owner_id'],
        filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Converted' }] },
        sortBy: 'lifetime_value',
      },
      {
        name: 'My Open Leads', showMetrics: true,
        columns: ['full_name', 'mobile', 'status', 'next_followup_at'],
        filter: {
          logic: 'AND',
          conditions: [
            { field: 'owner_id', operator: 'is_me' },
            { field: 'status', operator: 'not_in', value: ['Junk', 'Lost'] },
          ],
        },
        sortBy: 'updated_at',
      },
      {
        name: 'Hot Leads',
        columns: ['full_name', 'mobile', 'rating', 'budget', 'next_followup_at', 'owner_id'],
        filter: { logic: 'AND', conditions: [{ field: 'rating', operator: 'equals', value: 'Hot' }, { field: 'is_converted', operator: 'is_false' }] },
        sortBy: 'updated_at',
      },
      {
        name: 'Today’s Follow-ups',
        columns: ['full_name', 'mobile', 'status', 'next_followup_at', 'last_contacted_at', 'owner_id'],
        filter: { logic: 'AND', conditions: [{ field: 'next_followup_at', operator: 'today' }] },
        sortBy: 'next_followup_at', sortDir: 'asc',
      },
      {
        name: 'Overdue Follow-ups',
        columns: ['full_name', 'mobile', 'status', 'next_followup_at', 'owner_id'],
        filter: { logic: 'AND', conditions: [{ field: 'next_followup_at', operator: 'less_than', value: 'now' }, { field: 'is_converted', operator: 'is_false' }] },
        sortBy: 'next_followup_at', sortDir: 'asc',
      },
      {
        name: 'Uncontacted (24h+)',
        columns: ['full_name', 'mobile', 'lead_source', 'created_at', 'owner_id'],
        filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'New' }, { field: 'created_at', operator: 'older_than_n_days', value: 1 }] },
        sortBy: 'created_at', sortDir: 'asc',
      },
      {
        name: 'Pipeline', displayMode: 'kanban', groupBy: 'status',
        columns: ['full_name', 'mobile', 'budget', 'owner_id'],
        filter: { logic: 'AND', conditions: [{ field: 'is_converted', operator: 'is_false' }] },
      },
    ],
  },


  // =========================================================================
  // ORGANIZATIONS
  // =========================================================================

  // =========================================================================
  // PROPERTIES / UNITS
  // =========================================================================
  {
    name: 'properties',
    label: 'Inventories',
    singular: 'Inventory',
    table: 'ipy_e_properties',
    icon: 'home',
    color: '#22c55e',
    sequence: 50,
    menuGroup: 'Inventory',
    labelFields: ['full_name'],
    pipelineField: 'status',
    /*
      The duplicate check used to be ['property_code'] — an autonumber the system
      generates on the way in. `prepareValues` stamps a fresh number before the
      check runs, so it searched for a value that had never been stored and could
      not match. It was configured protection that gave none.

      The real identity of a builder floor here is where it is, which building,
      and which floor. `tower` and `unit_number` are deliberately not in the key:
      not one live property fills them in, and a key containing a field nobody
      fills is the same no-op in different clothes.

      `all` because these combine — two floors in one locality are not
      duplicates; the same house number on the same floor is.
    */
    // One owner / contact number means one Property record in this CRM. Unit
    // numbers can repeat across projects and are descriptive, not an identity.
    duplicateCheckFields: ['mobile'],
    settings: { duplicateCheckMode: 'all' },
    blocks: [
      {
        name: 'property_information',
        label: 'Property Information',
        fields: [
          F.autonum('property_code', 'Property Code', 'UNIT-'),
          F.text('full_name', 'Full Name', { quickCreate: true, searchable: true }),
          F.phone('mobile', 'Mobile', {
            mandatory: true, unique: true, quickCreate: true, maxLength: 10,
            config: { digits: 10, codePrefix: '+91' },
            help: 'Required and unique — one mobile can belong to only one property record',
          }),
          // Projects are no longer a module — a unit carries its development's
          // name itself. Plain text, so it needs no second record to exist.
          F.text('project_name', 'Project', { quickCreate: true, searchable: true }),
          F.pick('status', 'Status', 'property_status', { mandatory: true, quickCreate: true }),
          F.pick('property_type', 'Property Type', 'property_type', { quickCreate: true }),
          // Configuration (the "2 BHK" picklist) is deleted — this business
          // only ever used it to mean bedroom count, and Bedrooms (below, now
          // quick-create) already says that as a plain number. See migration
          // 111.
          F.owner(),
        ],
      },
      {
        name: 'unit_details',
        label: 'Unit Details',
        fields: [
          F.text('tower', 'Tower / Block'),
          F.text('wing', 'Wing'),
          F.num('floor', 'Floor'),
          F.text('unit_number', 'Unit Number'),
          F.pick('facing', 'Facing', 'facing'),
          F.text('view_description', 'View'),
          F.bool('corner_unit', 'Corner Unit'),
          F.bool('vastu_compliant', 'Vastu Compliant'),
          // Quick-create, taking over from the deleted Configuration picklist
          // — this business only ever used "configuration" to mean bedroom
          // count, so the plain number is the whole field now.
          F.num('bedrooms', 'Bedrooms', { quickCreate: true }),
          F.num('bathrooms', 'Bathrooms'),
          F.num('balconies', 'Balconies'),
          F.num('parking_slots', 'Parking Slots'),
          F.pick('furnishing', 'Furnishing', 'furnishing'),
        ],
      },
      {
        name: 'areas',
        label: 'Areas',
        fields: [
          // The unit lives beside the size, exactly as it does on Contacts —
          // one control, a number and a Sq.ft./Sq.yd. dropdown. Faridabad
          // quotes plots in gaj and flats in square feet, so a size stored
          // without its unit compares wrongly against a buyer's requirement.
          // Carpet Area used to be the field here and was removed outright
          // (migration 113); its values became this one.
          F.area('area', 'Area / Size', {
            quickCreate: true,
            config: { min: 0, unitField: 'area_unit', unitMaster: 'area' },
          }),
          F.area('built_up_area', 'Built-up Area'),
          F.area('super_built_up_area', 'Super Built-up Area'),
          F.area('plot_area', 'Plot Area'),
          F.area('balcony_area', 'Balcony Area'),
          F.area('terrace_area', 'Terrace Area'),
          F.pick('area_unit', 'Area Unit', 'area_unit', { default: 'sqft', displayType: 'hidden' }),
        ],
      },
      {
        name: 'pricing',
        label: 'Pricing',
        fields: [
          // What the seller is asking, with its qualifier welded on — the
          // budget/budget_unit pair on a contact, on the inventory side.
          F.money('demand', 'Demand', {
            quickCreate: true,
            config: { min: 0, unitField: 'demand_unit', unitMaster: 'budget_demand' },
          }),
          F.pick('demand_unit', 'Demand Unit', 'price_unit', { default: 'total', displayType: 'hidden' }),
          F.money('base_price', 'Base Price', { quickCreate: true }),
          F.money('rate_per_sqft', 'Rate per sq.ft'),
          F.money('floor_rise_charge', 'Floor Rise Charge'),
          F.money('plc_charge', 'PLC Charge', { help: 'Preferred Location Charge' }),
          F.money('parking_charge', 'Parking Charge'),
          F.money('club_membership', 'Club Membership'),
          F.money('maintenance_deposit', 'Maintenance Deposit'),
          F.money('other_charges', 'Other Charges'),
          F.pct('gst_percent', 'GST %'),
          F.pct('stamp_duty_percent', 'Stamp Duty %'),
          F.money('registration_charge', 'Registration Charge'),
          {
            /*
              Not "All-inclusive". The formula below is base price plus the six
              charge fields; GST, stamp duty and registration are not in it, and
              all three sit directly above this on the same form. Registration
              Charge is a plain rupee figure, so it is the one somebody is most
              likely to fill in and expect to see counted.

              The label is what was wrong, not the formula. This number is the
              advertised price everywhere — the website, the big figure on every
              share link, the Price line in the WhatsApp summary — and adding tax
              to it would raise all of them by about 11% overnight, while
              silently narrowing buyer matching, which counts inventory at
              `total_price <= budget * 1.1`.
            */
            name: 'total_price', label: 'Price with Charges', uitype: 'formula', column: 'total_price',
            readonly: true,
            config: {
              formula: {
                expression:
                  '{base_price} + COALESCE({floor_rise_charge},0) + COALESCE({plc_charge},0) + COALESCE({parking_charge},0) + COALESCE({club_membership},0) + COALESCE({maintenance_deposit},0) + COALESCE({other_charges},0)',
                returnType: 'number',
              },
              currency: 'INR',
            },
            help: 'Auto-computed from base price plus all charges',
          },
        ],
      },
      {
        name: 'rental',
        label: 'Rental / Lease',
        collapsed: true,
        fields: [
          F.money('monthly_rent', 'Monthly Rent'),
          F.money('security_deposit', 'Security Deposit'),
          F.money('maintenance_monthly', 'Monthly Maintenance'),
        ],
      },
      {
        name: 'availability',
        label: 'Availability',
        fields: [
          F.pick('possession_status', 'Possession Status', 'possession_status'),
          F.date('possession_date', 'Possession Date'),
          F.date('blocked_until', 'Blocked Until', {
            /*
              Required once the unit is actually Held.

              A unit set to Held with no expiry never reaches the hourly release
              job — its condition is "blocked_until older than 0 days", and a
              blank date is never older than anything — so the unit leaves the
              market permanently and nothing says so. Making the field mandatory
              outright would block every property that is not on hold, which is
              nearly all of them.
            */
            config: {
              requiredWhen: {
                logic: 'AND',
                conditions: [{ field: 'status', operator: 'in', value: ['Held', 'Blocked'] }],
              },
            },
          }),
          { name: 'blocked_by', label: 'Blocked By', uitype: 'user', column: 'blocked_by', readonly: true },
          F.ref('blocked_for_lead_id', 'Blocked For', ['leads']),
          F.bool('is_resale', 'Resale Unit'),
          F.num('age_of_property', 'Age (years)'),
          F.ref('owner_contact_id', 'Owner (Resale)', ['leads']),
        ],
      },
      {
        name: 'location_media',
        label: 'Location & Media',
        collapsed: true,
        fields: [
          F.pick('city', 'City', 'city'),
          F.pick('locality', 'Locality', 'locality'),
          F.dec('latitude', 'Latitude'),
          F.dec('longitude', 'Longitude'),
          F.multipick('amenities', 'Amenities', 'amenities'),
          F.image('gallery', 'Gallery', { config: { multiple: true } }),
          F.url('floor_plan_url', 'Floor Plan'),
          F.url('video_url', 'Video'),
          F.url('virtual_tour_url', 'Virtual Tour'),
          F.textarea('description', 'Description', { searchable: true }),
          F.bool('publish_to_web', 'Show on Website', {
            // Off by default, deliberately. A property is created before it has
            // photos, a price or a verified address, and the old default sent
            // it to the public website at that moment.
            storage: 'json', default: false, quickCreate: true,
            help: 'Off until you turn it on. A property only appears on the public website once this is on '
              + 'and its status is one of the public ones.',
          }),
        ],
      },
    ],
    relations: [
    ],
    views: [
      { name: 'All Inventories', isDefault: true, columns: ['property_code', 'full_name', 'project_name', 'bedrooms', 'area', 'total_price', 'status', 'floor', 'facing'], sortBy: 'created_at' },
      { name: 'Available Units', showMetrics: true, columns: ['full_name', 'project_name', 'bedrooms', 'area', 'total_price', 'floor', 'facing'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] }, sortBy: 'total_price', sortDir: 'asc' },
      { name: 'By Status', displayMode: 'kanban', groupBy: 'status', columns: ['full_name', 'project_name', 'bedrooms', 'total_price'] },
      { name: 'Blocked Units', columns: ['full_name', 'project_name', 'blocked_until', 'blocked_for_lead_id', 'blocked_by'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: ['Held', 'Blocked'] }] } },
      { name: 'Premium Units', columns: ['full_name', 'project_name', 'bedrooms', 'total_price', 'facing', 'status'], filter: { logic: 'AND', conditions: [{ field: 'total_price', operator: 'greater_or_equal', value: 20000000 }] }, sortBy: 'total_price' },
    ],
  },

  // =========================================================================
  // DEALS
  // =========================================================================

  // =========================================================================
  // SITE VISITS
  // =========================================================================

  // =========================================================================
  // BOOKINGS
  // =========================================================================

  // =========================================================================
  // PAYMENTS
  // =========================================================================

  // =========================================================================
  // CHANNEL PARTNERS
  // =========================================================================

];

export const REAL_ESTATE: IndustryTemplate = {
  key: 'real-estate',
  label: 'Real estate',
  description: 'Builders, brokers and channel partners — enquiries, site visits, units and bookings.',
  modules: MODULES,
};
