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
const AREA_UNITS = [
  { value: 'sqft', label: 'Sq.ft.' },
  { value: 'sqyd', label: 'Sq.yd.' },
];

const MODULES: ModuleDef[] = [
  // =========================================================================
  // LEADS
  // =========================================================================
  {
    name: 'leads',
    // One party record for the whole journey: enquiry → prospect → customer.
    // A separate Contacts module would duplicate the person and split their
    // timeline across two ids at conversion.
    label: 'Leads & Contacts',
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
          F.phone('mobile', 'Mobile', {
            mandatory: true, quickCreate: true, maxLength: 10,
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
          F.pick('lifecycle_stage', 'Lifecycle Stage', 'lifecycle_stage', {
            mandatory: true, quickCreate: true,
            help: 'Advances automatically: Lead → Prospect on first site visit, Customer on booking',
          }),
          F.pick('status', 'Pipeline Status', 'lead_status', { mandatory: true, quickCreate: true }),
          F.pick('contact_type', 'Type', 'contact_type'),
          F.pick('rating', 'Rating', 'rating'),
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
          F.multipick('configuration', 'Configuration', 'configuration'),
          F.pick('purpose', 'Purpose', 'purpose'),
          F.money('budget_min', 'Budget (Min)', { quickCreate: true, config: { min: 0, notAfterField: 'budget_max' } }),
          F.money('budget_max', 'Budget (Max)', { quickCreate: true, config: { min: 0 } }),
          F.pick('budget_band', 'Budget Band', 'budget_band'),
          F.multipick('preferred_locations', 'Preferred Locations', 'locality'),
          // One area with its own unit, not a min/max pair. A buyer says "about
          // 1200 sq.ft", not "between 1100 and 1300 carpet" — the range was two
          // fields collecting one answer, and neither carried the unit.
          F.area('area', 'Area', {
            config: { min: 0, unitField: 'area_unit', unitOptions: AREA_UNITS },
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
        name: 'ai_qualification',
        label: 'AI Qualification',
        fields: [
          F.score('ai_score', 'AI Score', { help: 'Predicted likelihood to convert, 0-100' }),
          F.json('ai_score_reasons', 'Score Drivers', { readonly: true, displayType: 'detail_only' }),
          F.date('ai_scored_at', 'Last Scored', { readonly: true }),
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
      {
        name: 'preferences',
        label: 'Communication Preferences',
        collapsed: true,
        fields: [
          F.bool('do_not_call', 'Do Not Call'),
          F.bool('do_not_whatsapp', 'Do Not WhatsApp'),
          F.bool('email_opt_out', 'Email Opt Out'),
        ],
      },
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
        name: 'All Records', isDefault: true, showMetrics: true,
        columns: ['lead_number', 'full_name', 'mobile', 'lifecycle_stage', 'status', 'lead_source', 'ai_score', 'budget_max', 'owner_id'],
        sortBy: 'created_at',
      },
      {
        name: 'Open Leads', showMetrics: true,
        columns: ['full_name', 'mobile', 'status', 'ai_score', 'next_followup_at', 'owner_id'],
        filter: {
          logic: 'AND',
          conditions: [
            { field: 'lifecycle_stage', operator: 'in', value: ['Lead', 'Prospect'] },
            { field: 'status', operator: 'not_in', value: ['Junk', 'Lost', 'Converted'] },
          ],
        },
        sortBy: 'ai_score',
      },
      {
        name: 'Customers', showMetrics: true,
        columns: ['full_name', 'mobile', 'email', 'lifetime_value', 'kyc_status', 'owner_id'],
        filter: { logic: 'AND', conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'Customer' }] },
        sortBy: 'lifetime_value',
      },
      {
        name: 'My Open Leads', showMetrics: true,
        columns: ['full_name', 'mobile', 'status', 'ai_score', 'next_followup_at'],
        filter: {
          logic: 'AND',
          conditions: [
            { field: 'owner_id', operator: 'is_me' },
            { field: 'lifecycle_stage', operator: 'in', value: ['Lead', 'Prospect'] },
            { field: 'status', operator: 'not_in', value: ['Junk', 'Lost'] },
          ],
        },
        sortBy: 'ai_score',
      },
      {
        name: 'Hot Leads',
        columns: ['full_name', 'mobile', 'ai_score', 'budget_max', 'next_followup_at', 'owner_id'],
        filter: { logic: 'AND', conditions: [{ field: 'ai_score', operator: 'greater_or_equal', value: 70 }, { field: 'is_converted', operator: 'is_false' }] },
        sortBy: 'ai_score',
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
        columns: ['full_name', 'mobile', 'ai_score', 'budget_max', 'owner_id'],
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
    label: 'Properties',
    singular: 'Property',
    table: 'ipy_e_properties',
    icon: 'home',
    color: '#22c55e',
    sequence: 50,
    menuGroup: 'Inventory',
    labelFields: ['name'],
    pipelineField: 'status',
    duplicateCheckFields: ['property_code'],
    blocks: [
      {
        name: 'property_information',
        label: 'Property Information',
        fields: [
          F.autonum('property_code', 'Property Code', 'UNIT-'),
          F.text('name', 'Unit Name', { mandatory: true, quickCreate: true, searchable: true, help: 'e.g. "Tower A — 1204"' }),
          // Projects are no longer a module — a unit carries its development's
          // name itself. Plain text, so it needs no second record to exist.
          F.text('project_name', 'Project', { quickCreate: true, searchable: true }),
          F.pick('status', 'Status', 'property_status', { mandatory: true, quickCreate: true }),
          F.pick('property_type', 'Property Type', 'property_type', { quickCreate: true }),
          F.pick('configuration', 'Configuration', 'configuration', { quickCreate: true }),
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
          F.num('bedrooms', 'Bedrooms'),
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
          F.area('carpet_area', 'Carpet Area', { quickCreate: true }),
          F.area('built_up_area', 'Built-up Area'),
          F.area('super_built_up_area', 'Super Built-up Area'),
          F.area('plot_area', 'Plot Area'),
          F.area('balcony_area', 'Balcony Area'),
          F.area('terrace_area', 'Terrace Area'),
          F.text('area_unit', 'Area Unit', { default: 'sqft' }),
        ],
      },
      {
        name: 'pricing',
        label: 'Pricing',
        fields: [
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
            name: 'total_price', label: 'All-inclusive Price', uitype: 'formula', column: 'total_price',
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
          F.date('blocked_until', 'Blocked Until'),
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
      { name: 'All Inventory', isDefault: true, columns: ['property_code', 'name', 'project_name', 'configuration', 'carpet_area', 'total_price', 'status', 'floor', 'facing'], sortBy: 'created_at' },
      { name: 'Available Units', showMetrics: true, columns: ['name', 'project_name', 'configuration', 'carpet_area', 'total_price', 'floor', 'facing'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] }, sortBy: 'total_price', sortDir: 'asc' },
      { name: 'By Status', displayMode: 'kanban', groupBy: 'status', columns: ['name', 'project_name', 'configuration', 'total_price'] },
      { name: 'Blocked Units', columns: ['name', 'project_name', 'blocked_until', 'blocked_for_lead_id', 'blocked_by'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: ['Held', 'Blocked'] }] } },
      { name: 'Premium Units', columns: ['name', 'project_name', 'configuration', 'total_price', 'facing', 'status'], filter: { logic: 'AND', conditions: [{ field: 'total_price', operator: 'greater_or_equal', value: 20000000 }] }, sortBy: 'total_price' },
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
