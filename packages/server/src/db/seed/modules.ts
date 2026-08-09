import { F, type ModuleDef } from './helpers.js';

/**
 * The seeded real-estate data model.
 *
 * Everything here is *starting* metadata — an admin can add fields, reorder
 * blocks, rename labels, add modules, or delete what they don't need. Nothing
 * in the engine hard-codes any of these names except a small set of
 * integration touchpoints (documented in README).
 */

export const MODULES: ModuleDef[] = [
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
          // The country code is its own field so it is a visible choice rather
          // than a silent +91 default — an NRI buyer stored under the wrong
          // code never matches on WhatsApp or in the call log again.
          F.pick('country_code', 'Country', 'country_code', {
            mandatory: true, quickCreate: true, default: '+91',
          }),
          F.phone('mobile', 'Mobile', {
            mandatory: true, quickCreate: true, maxLength: 10,
            // National-number length per country. India is ten — which is what
            // the business asked for — without making an NRI buyer's UAE
            // number unenterable.
            config: {
              digits: 10,
              digitsFrom: 'country_code',
              digitsMap: {
                '+91': 10, '+971': 9, '+966': 9, '+974': 8, '+968': 8,
                '+965': 8, '+973': 8, '+65': 8, '+61': 9, '+44': 10, '+1': 10,
              },
            },
            help: '10 digits, without the country code',
          }),
          F.email('email', 'Email', { quickCreate: true }),
          F.email('secondary_email', 'Secondary Email'),
          F.phone('alternate_phone', 'Alternate Phone'),
          F.phone('whatsapp_number', 'WhatsApp Number', { help: 'Defaults to mobile if left blank' }),
          F.pick('lifecycle_stage', 'Lifecycle Stage', 'lifecycle_stage', {
            mandatory: true, quickCreate: true,
            help: 'Advances automatically: Lead → Prospect on first site visit, Customer on booking',
          }),
          F.pick('status', 'Pipeline Status', 'lead_status', { mandatory: true, quickCreate: true }),
          F.pick('contact_type', 'Type', 'contact_type'),
          F.pick('rating', 'Rating', 'rating'),
          F.owner(),
          F.ref('organization_id', 'Organisation', ['organizations']),
          F.text('company', 'Company', { searchable: true }),
          F.text('designation', 'Designation'),
        ],
      },
      {
        name: 'requirement',
        label: 'Requirement',
        fields: [
          F.ref('interested_project_id', 'Interested Project', ['projects'], { quickCreate: true }),
          F.pick('property_type', 'Property Type', 'property_type'),
          F.multipick('configuration', 'Configuration', 'configuration'),
          F.pick('purpose', 'Purpose', 'purpose'),
          F.money('budget_min', 'Budget (Min)', { quickCreate: true, config: { min: 0, notAfterField: 'budget_max' } }),
          F.money('budget_max', 'Budget (Max)', { quickCreate: true, config: { min: 0 } }),
          F.pick('budget_band', 'Budget Band', 'budget_band'),
          F.multipick('preferred_locations', 'Preferred Locations', 'locality'),
          F.area('carpet_area_min', 'Carpet Area (Min)', { config: { min: 0, notAfterField: 'carpet_area_max' } }),
          F.area('carpet_area_max', 'Carpet Area (Max)', { config: { min: 0 } }),
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
          F.ref('campaign_id', 'Campaign', ['campaigns']),
          F.ref('channel_partner_id', 'Channel Partner', ['channel_partners']),
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
          F.pick('ai_grade', 'AI Grade', 'ai_grade', { readonly: true }),
          F.json('ai_score_reasons', 'Score Drivers', { readonly: true, displayType: 'detail_only' }),
          F.datetime('ai_scored_at', 'Last Scored', { readonly: true }),
          F.textarea('qualification_notes', 'Qualification Notes'),
        ],
      },
      {
        name: 'follow_up',
        label: 'Follow Up',
        fields: [
          F.datetime('next_followup_at', 'Next Follow-up'),
          F.datetime('last_contacted_at', 'Last Contacted', { readonly: true }),
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
          F.datetime('converted_at', 'Converted On', { readonly: true }),
          F.ref('converted_deal_id', 'First Deal', ['deals'], { readonly: true }),
          F.ref('converted_org_id', 'Organisation', ['organizations'], { readonly: true, displayType: 'hidden' }),
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
    relations: [
      { name: 'lead_activities', label: 'Activities', target: 'activities', type: 'one_to_many', foreignField: 'related_to' },
      { name: 'lead_deals', label: 'Deals', target: 'deals', type: 'one_to_many', foreignField: 'contact_id' },
      { name: 'lead_site_visits', label: 'Site Visits', target: 'site_visits', type: 'one_to_many', foreignField: 'lead_id' },
    ],
    views: [
      {
        name: 'All Records', isDefault: true, showMetrics: true,
        columns: ['lead_number', 'full_name', 'mobile', 'lifecycle_stage', 'status', 'lead_source', 'ai_score', 'budget_max', 'owner_id'],
        sortBy: 'created_at',
      },
      {
        name: 'Open Leads', showMetrics: true,
        columns: ['full_name', 'mobile', 'status', 'ai_score', 'next_followup_at', 'interested_project_id', 'owner_id'],
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
        columns: ['full_name', 'mobile', 'status', 'ai_score', 'next_followup_at', 'interested_project_id'],
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
        columns: ['full_name', 'mobile', 'ai_score', 'budget_max', 'interested_project_id', 'next_followup_at', 'owner_id'],
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
  {
    name: 'organizations',
    label: 'Organisations',
    singular: 'Organisation',
    table: 'ipy_e_organizations',
    icon: 'building-2',
    color: '#14b8a6',
    sequence: 30,
    menuGroup: 'Sales',
    // Reached from the lead it belongs to (migration 025).
    showInMenu: false,
    labelFields: ['name'],
    duplicateCheckFields: ['name', 'gstin'],
    blocks: [
      {
        name: 'org_information',
        label: 'Organisation Information',
        fields: [
          F.autonum('org_number', 'Organisation #', 'ORG-'),
          F.text('name', 'Name', { mandatory: true, quickCreate: true, searchable: true }),
          F.pick('org_type', 'Type', 'org_type', { quickCreate: true }),
          F.text('industry', 'Industry'),
          F.phone('phone', 'Phone', { quickCreate: true }),
          F.email('email', 'Email', { quickCreate: true }),
          F.url('website', 'Website'),
          F.owner(),
          F.num('employees', 'Employees'),
          F.money('annual_revenue', 'Annual Revenue'),
          F.pick('rating', 'Rating', 'rating'),
        ],
      },
      {
        name: 'compliance',
        label: 'Compliance',
        fields: [
          F.text('gstin', 'GSTIN'),
          F.text('pan', 'PAN'),
          F.text('cin', 'CIN'),
          F.text('rera_registration', 'RERA Registration'),
        ],
      },
      {
        name: 'addresses',
        label: 'Addresses',
        collapsed: true,
        fields: [
          F.address('billing_address', 'Billing Address'),
          F.address('shipping_address', 'Site Address'),
        ],
      },
      {
        name: 'more',
        label: 'More Information',
        collapsed: true,
        fields: [F.image('logo_url', 'Logo'), F.textarea('description', 'Description', { searchable: true })],
      },
    ],
    relations: [
      { name: 'org_leads', label: 'Leads & Contacts', target: 'leads', type: 'one_to_many', foreignField: 'organization_id' },
      { name: 'org_projects', label: 'Projects', target: 'projects', type: 'one_to_many', foreignField: 'developer_id' },
      { name: 'org_deals', label: 'Deals', target: 'deals', type: 'one_to_many', foreignField: 'organization_id' },
    ],
    views: [
      { name: 'All Organisations', isDefault: true, columns: ['org_number', 'name', 'org_type', 'phone', 'email', 'owner_id'], sortBy: 'name', sortDir: 'asc' },
      { name: 'Developers', columns: ['name', 'phone', 'rera_registration', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'org_type', operator: 'in', value: ['Developer', 'Builder'] }] } },
    ],
  },

  // =========================================================================
  // PROJECTS
  // =========================================================================
  {
    name: 'projects',
    label: 'Projects',
    singular: 'Project',
    table: 'ipy_e_projects',
    icon: 'landmark',
    color: '#f59e0b',
    sequence: 40,
    menuGroup: 'Inventory',
    // Reached from Properties — one Inventory entry, not two.
    showInMenu: false,
    labelFields: ['name'],
    pipelineField: 'status',
    duplicateCheckFields: ['project_code', 'rera_number'],
    blocks: [
      {
        name: 'project_information',
        label: 'Project Information',
        fields: [
          F.autonum('project_code', 'Project Code', 'PRJ-'),
          F.text('name', 'Project Name', { mandatory: true, quickCreate: true, searchable: true }),
          F.ref('developer_id', 'Developer', ['organizations'], { quickCreate: true }),
          F.pick('status', 'Status', 'project_status', { mandatory: true, quickCreate: true }),
          F.pick('project_type', 'Project Type', 'project_type', { quickCreate: true }),
          F.owner(),
        ],
      },
      {
        name: 'location',
        label: 'Location',
        fields: [
          F.pick('city', 'City', 'city', { quickCreate: true, searchable: true }),
          F.pick('locality', 'Locality', 'locality', { quickCreate: true, searchable: true }),
          F.pick('micro_market', 'Micro Market', 'micro_market'),
          F.pick('state', 'State', 'state'),
          F.text('country', 'Country', { default: 'India' }),
          F.text('pincode', 'Pincode'),
          F.address('address', 'Full Address'),
          F.dec('latitude', 'Latitude'),
          F.dec('longitude', 'Longitude'),
          F.json('connectivity', 'Connectivity', { help: 'Nearby landmarks with distances — used by AI pitches' }),
        ],
      },
      {
        name: 'compliance',
        label: 'RERA & Approvals',
        fields: [
          F.text('rera_number', 'RERA Number'),
          F.date('rera_expiry', 'RERA Expiry'),
          F.json('approvals', 'Approvals'),
        ],
      },
      {
        name: 'scale',
        label: 'Project Scale',
        fields: [
          F.dec('total_land_area', 'Total Land Area'),
          F.text('land_area_unit', 'Land Area Unit', { default: 'acre' }),
          F.num('total_towers', 'Total Towers'),
          F.num('total_floors', 'Total Floors'),
          F.num('total_units', 'Total Units'),
          F.rollup('available_units', 'Available Units', 'project_properties', 'count', {
            filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] },
          }),
          F.rollup('booked_units', 'Booked Units', 'project_properties', 'count', {
            filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: ['Booked', 'Sold'] }] },
          }),
          F.rollup('total_inventory', 'Total Inventory', 'project_properties', 'count'),
          F.pct('open_area_percent', 'Open Area %'),
        ],
      },
      {
        name: 'commercials',
        label: 'Commercials',
        fields: [
          F.money('price_min', 'Price (Min)', { quickCreate: true, config: { min: 0, notAfterField: 'price_max' } }),
          F.money('price_max', 'Price (Max)', { quickCreate: true, config: { min: 0 } }),
          F.money('rate_per_sqft', 'Rate per sq.ft'),
          F.multipick('configurations', 'Configurations', 'configuration'),
          F.pct('broker_commission_pct', 'Broker Commission %'),
        ],
      },
      {
        name: 'timeline',
        label: 'Timeline',
        fields: [
          F.date('launch_date', 'Launch Date'),
          F.date('possession_date', 'Possession Date'),
          F.pct('completion_percent', 'Construction Progress %'),
        ],
      },
      {
        name: 'marketing',
        label: 'Marketing Collateral',
        collapsed: true,
        fields: [
          F.multipick('amenities', 'Amenities', 'amenities'),
          F.json('usps', 'USPs', { help: 'Selling points the AI assistant will use in pitches' }),
          F.url('brochure_url', 'Brochure'),
          F.url('video_url', 'Video'),
          F.url('virtual_tour_url', 'Virtual Tour'),
          F.url('master_plan_url', 'Master Plan'),
          F.image('gallery', 'Gallery', { config: { multiple: true } }),
          F.json('floor_plans', 'Floor Plans'),
          F.bool('publish_to_web', 'Show on Website', {
            storage: 'json', default: true, quickCreate: true,
            help: 'Whether this project appears on the public property website, in addition to the usual status-based visibility.',
          }),
        ],
      },
      { name: 'more', label: 'Description', collapsed: true, fields: [F.textarea('description', 'Description', { searchable: true })] },
    ],
    relations: [
      { name: 'project_properties', label: 'Inventory', target: 'properties', type: 'one_to_many', foreignField: 'project_id' },
      { name: 'project_leads', label: 'Leads', target: 'leads', type: 'one_to_many', foreignField: 'interested_project_id' },
      { name: 'project_deals', label: 'Deals', target: 'deals', type: 'one_to_many', foreignField: 'project_id' },
      { name: 'project_site_visits', label: 'Site Visits', target: 'site_visits', type: 'one_to_many', foreignField: 'project_id' },
      { name: 'project_bookings', label: 'Bookings', target: 'bookings', type: 'one_to_many', foreignField: 'project_id' },
      { name: 'project_campaigns', label: 'Campaigns', target: 'campaigns', type: 'one_to_many', foreignField: 'project_id' },
      { name: 'project_documents', label: 'Documents', target: 'documents', type: 'one_to_many', foreignField: 'project_id' },
    ],
    views: [
      { name: 'All Projects', isDefault: true, columns: ['project_code', 'name', 'developer_id', 'status', 'city', 'locality', 'price_min', 'price_max', 'available_units', 'possession_date'], sortBy: 'created_at' },
      { name: 'Active Inventory', columns: ['name', 'city', 'locality', 'available_units', 'booked_units', 'price_min', 'possession_date'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: ['New Launch', 'Under Construction', 'Nearing Possession', 'Ready To Move'] }] } },
      { name: 'By Status', displayMode: 'kanban', groupBy: 'status', columns: ['name', 'city', 'available_units', 'price_min'] },
      { name: 'Map View', displayMode: 'map', columns: ['name', 'city', 'locality', 'price_min', 'status'] },
    ],
  },

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
          F.ref('project_id', 'Project', ['projects'], { quickCreate: true }),
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
          F.datetime('blocked_until', 'Blocked Until'),
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
            storage: 'json', default: true, quickCreate: true,
            help: 'Whether this unit appears on the public property website, in addition to the usual status-based visibility.',
          }),
        ],
      },
    ],
    relations: [
      { name: 'property_deals', label: 'Deals', target: 'deals', type: 'one_to_many', foreignField: 'property_id' },
      { name: 'property_site_visits', label: 'Site Visits', target: 'site_visits', type: 'one_to_many', foreignField: 'property_id' },
      { name: 'property_bookings', label: 'Bookings', target: 'bookings', type: 'one_to_many', foreignField: 'property_id' },
    ],
    views: [
      { name: 'All Inventory', isDefault: true, columns: ['property_code', 'name', 'project_id', 'configuration', 'carpet_area', 'total_price', 'status', 'floor', 'facing'], sortBy: 'created_at' },
      { name: 'Available Units', showMetrics: true, columns: ['name', 'project_id', 'configuration', 'carpet_area', 'total_price', 'floor', 'facing'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] }, sortBy: 'total_price', sortDir: 'asc' },
      { name: 'Inventory Board', displayMode: 'kanban', groupBy: 'status', columns: ['name', 'project_id', 'configuration', 'total_price'] },
      { name: 'Blocked Units', columns: ['name', 'project_id', 'blocked_until', 'blocked_for_lead_id', 'blocked_by'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: ['Held', 'Blocked'] }] } },
      { name: 'Premium Units', columns: ['name', 'project_id', 'configuration', 'total_price', 'facing', 'status'], filter: { logic: 'AND', conditions: [{ field: 'total_price', operator: 'greater_or_equal', value: 20000000 }] }, sortBy: 'total_price' },
    ],
  },

  // =========================================================================
  // DEALS
  // =========================================================================
  {
    name: 'deals',
    label: 'Deals',
    singular: 'Deal',
    table: 'ipy_e_deals',
    icon: 'handshake',
    color: '#ec4899',
    sequence: 60,
    menuGroup: 'Sales',
    // A tab on the lead. Still fully live, just not a destination.
    showInMenu: false,
    labelFields: ['name'],
    pipelineField: 'stage',
    blocks: [
      {
        name: 'deal_information',
        label: 'Deal Information',
        fields: [
          F.autonum('deal_number', 'Deal #', 'DL-'),
          F.text('name', 'Deal Name', { mandatory: true, quickCreate: true, searchable: true }),
          F.ref('contact_id', 'Buyer', ['leads'], { quickCreate: true }),
          F.ref('organization_id', 'Organisation', ['organizations']),
          F.pick('stage', 'Stage', 'deal_stage', { mandatory: true, quickCreate: true }),
          F.num('probability', 'Probability %', { readonly: true, help: 'Derived from the stage' }),
          F.owner(),
        ],
      },
      {
        name: 'property_interest',
        label: 'Property Interest',
        fields: [
          F.ref('project_id', 'Project', ['projects'], { quickCreate: true }),
          F.ref('property_id', 'Unit', ['properties'], { quickCreate: true }),
          F.ref('source_lead_id', 'Source Lead', ['leads'], { readonly: true }),
          F.ref('channel_partner_id', 'Channel Partner', ['channel_partners']),
          F.ref('campaign_id', 'Campaign', ['campaigns']),
          F.pick('lead_source', 'Lead Source', 'lead_source'),
        ],
      },
      {
        name: 'commercials',
        label: 'Commercials',
        fields: [
          F.money('amount', 'Deal Value', { mandatory: true, quickCreate: true }),
          F.money('negotiated_price', 'Negotiated Price'),
          F.money('discount_amount', 'Discount Amount'),
          F.pct('discount_percent', 'Discount %'),
          F.date('expected_close_date', 'Expected Close Date', { quickCreate: true }),
          F.date('actual_close_date', 'Actual Close Date', { readonly: true }),
          F.datetime('next_followup_at', 'Next Follow-up'),
        ],
      },
      {
        name: 'ai_intelligence',
        label: 'AI Intelligence',
        fields: [
          F.score('ai_risk_score', 'Risk Score', { help: 'Higher means more likely to stall or be lost' }),
          F.json('ai_risk_reasons', 'Risk Drivers', { readonly: true, displayType: 'detail_only' }),
          F.textarea('ai_next_action', 'Recommended Next Action', { readonly: true }),
          F.date('ai_forecast_close', 'Forecast Close Date', { readonly: true }),
          F.datetime('ai_analysed_at', 'Last Analysed', { readonly: true }),
        ],
      },
      {
        name: 'pipeline_analytics',
        label: 'Pipeline Analytics',
        collapsed: true,
        fields: [
          F.datetime('stage_changed_at', 'Stage Changed At', { readonly: true }),
          F.num('days_in_stage', 'Days in Stage', { readonly: true }),
          F.bool('is_won', 'Won', { readonly: true }),
          F.bool('is_lost', 'Lost', { readonly: true }),
          F.pick('lost_reason', 'Lost Reason', 'lost_reason'),
          F.text('lost_to_competitor', 'Lost To'),
        ],
      },
      { name: 'more', label: 'Description', collapsed: true, fields: [F.textarea('description', 'Description', { searchable: true })] },
    ],
    relations: [
      { name: 'deal_site_visits', label: 'Site Visits', target: 'site_visits', type: 'one_to_many', foreignField: 'deal_id' },
      { name: 'deal_bookings', label: 'Bookings', target: 'bookings', type: 'one_to_many', foreignField: 'deal_id' },
      { name: 'deal_activities', label: 'Activities', target: 'activities', type: 'one_to_many', foreignField: 'related_to' },
      { name: 'deal_documents', label: 'Documents', target: 'documents', type: 'one_to_many', foreignField: 'related_to' },
    ],
    views: [
      { name: 'All Deals', isDefault: true, columns: ['deal_number', 'name', 'contact_id', 'project_id', 'stage', 'amount', 'expected_close_date', 'owner_id'], sortBy: 'created_at' },
      { name: 'Sales Pipeline', displayMode: 'kanban', groupBy: 'stage', showMetrics: true, columns: ['name', 'contact_id', 'amount', 'expected_close_date', 'ai_risk_score'], filter: { logic: 'AND', conditions: [{ field: 'is_won', operator: 'is_false' }, { field: 'is_lost', operator: 'is_false' }] } },
      { name: 'My Open Deals', columns: ['name', 'contact_id', 'stage', 'amount', 'expected_close_date', 'ai_risk_score'], filter: { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_me' }, { field: 'is_won', operator: 'is_false' }, { field: 'is_lost', operator: 'is_false' }] } },
      { name: 'Closing This Month', showMetrics: true, columns: ['name', 'contact_id', 'stage', 'amount', 'expected_close_date', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'expected_close_date', operator: 'this_month' }, { field: 'is_lost', operator: 'is_false' }] }, sortBy: 'expected_close_date', sortDir: 'asc' },
      { name: 'At Risk', columns: ['name', 'contact_id', 'stage', 'amount', 'ai_risk_score', 'ai_next_action', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'ai_risk_score', operator: 'greater_or_equal', value: 60 }, { field: 'is_won', operator: 'is_false' }, { field: 'is_lost', operator: 'is_false' }] }, sortBy: 'ai_risk_score' },
      { name: 'Won Deals', columns: ['name', 'contact_id', 'project_id', 'amount', 'actual_close_date', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'is_won', operator: 'is_true' }] }, sortBy: 'actual_close_date' },
    ],
  },

  // =========================================================================
  // SITE VISITS
  // =========================================================================
  {
    name: 'site_visits',
    label: 'Site Visits',
    singular: 'Site Visit',
    table: 'ipy_e_site_visits',
    icon: 'map-pinned',
    color: '#f97316',
    sequence: 70,
    menuGroup: 'Sales',
    // A tab on the lead.
    showInMenu: false,
    labelFields: ['subject'],
    pipelineField: 'status',
    blocks: [
      {
        name: 'visit_information',
        label: 'Visit Information',
        fields: [
          F.autonum('visit_number', 'Visit #', 'SV-'),
          F.text('subject', 'Subject', { mandatory: true, quickCreate: true, searchable: true }),
          F.pick('status', 'Status', 'site_visit_status', { mandatory: true, quickCreate: true }),
          F.pick('visit_type', 'Visit Type', 'site_visit_type', { quickCreate: true }),
          F.datetime('scheduled_at', 'Scheduled At', { mandatory: true, quickCreate: true }),
          F.num('duration_minutes', 'Duration (min)', { default: 60 }),
          F.owner(),
        ],
      },
      {
        name: 'participants',
        label: 'Participants & Property',
        fields: [
          F.ref('lead_id', 'Lead', ['leads'], { quickCreate: true }),
          F.ref('contact_id', 'Buyer', ['leads'], { quickCreate: true }),
          F.ref('deal_id', 'Deal', ['deals']),
          F.ref('project_id', 'Project', ['projects'], { quickCreate: true }),
          F.ref('property_id', 'Unit', ['properties']),
          F.ref('channel_partner_id', 'Channel Partner', ['channel_partners']),
          { name: 'accompanied_by', label: 'Accompanied By', uitype: 'user', column: 'accompanied_by' },
          F.num('attendees_count', 'Number of Attendees', { default: 1 }),
        ],
      },
      {
        name: 'logistics',
        label: 'Logistics',
        collapsed: true,
        fields: [
          F.bool('pickup_required', 'Pickup Required'),
          F.textarea('pickup_address', 'Pickup Address'),
          F.datetime('actual_start', 'Actual Start', { readonly: true }),
          F.datetime('actual_end', 'Actual End', { readonly: true }),
          F.bool('confirmation_sent', 'Confirmation Sent', { readonly: true }),
          F.bool('reminder_sent', 'Reminder Sent', { readonly: true }),
          F.dec('checkin_latitude', 'Check-in Latitude', { readonly: true, displayType: 'hidden' }),
          F.dec('checkin_longitude', 'Check-in Longitude', { readonly: true, displayType: 'hidden' }),
        ],
      },
      {
        name: 'outcome',
        label: 'Outcome',
        fields: [
          F.pick('interest_level', 'Interest Level', 'interest_level'),
          F.textarea('feedback', 'Client Feedback', { searchable: true }),
          F.multipick('objections', 'Objections', 'lost_reason'),
          F.json('units_shown', 'Units Shown'),
          F.textarea('next_step', 'Next Step'),
          F.num('rating', 'Visit Rating (1-5)'),
          F.textarea('ai_summary', 'AI Summary', { readonly: true }),
          F.pick('ai_sentiment', 'AI Sentiment', 'sentiment', { readonly: true }),
        ],
      },
      { name: 'more', label: 'Notes', collapsed: true, fields: [F.textarea('description', 'Notes')] },
    ],
    views: [
      { name: 'All Site Visits', isDefault: true, columns: ['visit_number', 'subject', 'lead_id', 'project_id', 'scheduled_at', 'status', 'interest_level', 'owner_id'], sortBy: 'scheduled_at' },
      { name: 'Today', showMetrics: true, columns: ['subject', 'lead_id', 'project_id', 'scheduled_at', 'status', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'scheduled_at', operator: 'today' }] }, sortBy: 'scheduled_at', sortDir: 'asc' },
      { name: 'Upcoming', columns: ['subject', 'lead_id', 'project_id', 'scheduled_at', 'status', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'scheduled_at', operator: 'next_n_days', value: 7 }, { field: 'status', operator: 'in', value: ['Scheduled', 'Confirmed'] }] }, sortBy: 'scheduled_at', sortDir: 'asc' },
      { name: 'Calendar', displayMode: 'calendar', columns: ['subject', 'scheduled_at', 'status'], sortBy: 'scheduled_at', sortDir: 'asc' },
      { name: 'Pending Feedback', columns: ['subject', 'lead_id', 'scheduled_at', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Completed' }, { field: 'feedback', operator: 'is_empty' }] } },
    ],
  },

  // =========================================================================
  // BOOKINGS
  // =========================================================================
  {
    name: 'bookings',
    label: 'Bookings',
    singular: 'Booking',
    table: 'ipy_e_bookings',
    icon: 'file-signature',
    color: '#6366f1',
    sequence: 80,
    menuGroup: 'Sales',
    // Retired in migration 025 — the business does not use this.
    showInMenu: false,
    labelFields: ['booking_number'],
    pipelineField: 'status',
    blocks: [
      {
        name: 'booking_information',
        label: 'Booking Information',
        fields: [
          F.autonum('booking_number', 'Booking #', 'BKG-'),
          F.pick('status', 'Status', 'booking_status', { mandatory: true, quickCreate: true }),
          F.date('booking_date', 'Booking Date', { mandatory: true, quickCreate: true }),
          F.ref('deal_id', 'Deal', ['deals'], { quickCreate: true }),
          F.ref('contact_id', 'Primary Applicant', ['leads'], { mandatory: true, quickCreate: true }),
          F.ref('co_applicant_id', 'Co-Applicant', ['leads']),
          F.ref('project_id', 'Project', ['projects'], { quickCreate: true }),
          F.ref('property_id', 'Unit', ['properties'], { mandatory: true, quickCreate: true }),
          F.ref('channel_partner_id', 'Channel Partner', ['channel_partners']),
          F.owner(),
        ],
      },
      {
        name: 'financials',
        label: 'Financials',
        fields: [
          F.money('agreement_value', 'Agreement Value', { quickCreate: true }),
          F.money('total_consideration', 'Total Consideration'),
          F.money('token_amount', 'Token Amount'),
          F.money('booking_amount', 'Booking Amount'),
          F.money('discount_amount', 'Discount'),
          F.money('gst_amount', 'GST'),
          F.money('stamp_duty', 'Stamp Duty'),
          F.money('registration_fee', 'Registration Fee'),
          F.money('amount_received', 'Amount Received', { readonly: true, help: 'Rolled up from linked payments' }),
          F.money('amount_due', 'Amount Due', { readonly: true }),
        ],
      },
      {
        name: 'payment_plan',
        label: 'Payment Plan',
        fields: [
          F.pick('payment_plan', 'Payment Plan', 'payment_plan'),
          F.json('payment_schedule', 'Schedule', { help: 'Milestones auto-generate Payment records' }),
        ],
      },
      {
        name: 'loan',
        label: 'Home Loan',
        collapsed: true,
        fields: [
          F.bool('loan_required', 'Loan Required'),
          F.text('loan_bank', 'Bank / NBFC'),
          F.money('loan_amount', 'Loan Amount'),
          F.pick('loan_status', 'Loan Status', 'loan_status'),
          F.date('loan_sanctioned_at', 'Sanctioned On'),
        ],
      },
      {
        name: 'legal',
        label: 'Legal & Documentation',
        fields: [
          F.date('agreement_date', 'Agreement Date'),
          F.date('registration_date', 'Registration Date'),
          F.date('possession_date', 'Possession Date'),
          F.bool('kyc_complete', 'KYC Complete'),
          F.json('documents_pending', 'Pending Documents'),
        ],
      },
      {
        name: 'commission',
        label: 'Commission',
        collapsed: true,
        fields: [
          F.money('broker_commission', 'Broker Commission'),
          F.pick('commission_status', 'Commission Status', 'commission_status'),
        ],
      },
      {
        name: 'more',
        label: 'More',
        collapsed: true,
        fields: [
          F.pick('cancellation_reason', 'Cancellation Reason', 'lost_reason'),
          F.datetime('cancelled_at', 'Cancelled At', { readonly: true }),
          F.textarea('description', 'Notes'),
        ],
      },
    ],
    relations: [
      { name: 'booking_payments', label: 'Payments', target: 'payments', type: 'one_to_many', foreignField: 'booking_id' },
      { name: 'booking_documents', label: 'Documents', target: 'documents', type: 'one_to_many', foreignField: 'related_to' },
    ],
    views: [
      { name: 'All Bookings', isDefault: true, showMetrics: true, columns: ['booking_number', 'contact_id', 'project_id', 'property_id', 'agreement_value', 'status', 'booking_date', 'owner_id'], sortBy: 'booking_date' },
      { name: 'Booking Pipeline', displayMode: 'kanban', groupBy: 'status', columns: ['booking_number', 'contact_id', 'agreement_value', 'booking_date'] },
      { name: 'Pending KYC', columns: ['booking_number', 'contact_id', 'booking_date', 'kyc_complete', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'kyc_complete', operator: 'is_false' }, { field: 'status', operator: 'not_equals', value: 'Cancelled' }] } },
      { name: 'Awaiting Registration', columns: ['booking_number', 'contact_id', 'property_id', 'agreement_date', 'registration_date'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Agreement Signed' }, { field: 'registration_date', operator: 'is_empty' }] } },
      { name: 'This Month', showMetrics: true, columns: ['booking_number', 'contact_id', 'project_id', 'agreement_value', 'booking_date', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'booking_date', operator: 'this_month' }] } },
    ],
  },

  // =========================================================================
  // PAYMENTS
  // =========================================================================
  {
    name: 'payments',
    label: 'Payments',
    singular: 'Payment',
    table: 'ipy_e_payments',
    icon: 'receipt-indian-rupee',
    color: '#10b981',
    sequence: 90,
    menuGroup: 'Finance',
    // Retired in migration 025 — the business does not use this.
    showInMenu: false,
    labelFields: ['payment_number'],
    pipelineField: 'status',
    blocks: [
      {
        name: 'payment_information',
        label: 'Payment Information',
        fields: [
          F.autonum('payment_number', 'Payment #', 'PAY-'),
          F.ref('booking_id', 'Booking', ['bookings'], { mandatory: true, quickCreate: true }),
          F.ref('contact_id', 'Customer', ['leads'], { quickCreate: true }),
          F.ref('project_id', 'Project', ['projects']),
          F.text('milestone', 'Milestone', { quickCreate: true, help: 'e.g. "On Booking", "On Slab Completion"' }),
          F.num('installment_no', 'Installment #'),
          F.pick('status', 'Status', 'payment_status', { mandatory: true, quickCreate: true }),
          F.owner(),
        ],
      },
      {
        name: 'amounts',
        label: 'Amounts',
        fields: [
          F.money('amount_due', 'Amount Due', { mandatory: true, quickCreate: true }),
          F.money('amount_paid', 'Amount Paid'),
          F.date('due_date', 'Due Date', { quickCreate: true }),
          F.date('paid_on', 'Paid On'),
          F.money('late_fee', 'Late Fee'),
          F.money('tds_amount', 'TDS'),
          F.money('gst_amount', 'GST'),
        ],
      },
      {
        name: 'transaction',
        label: 'Transaction Details',
        fields: [
          F.pick('payment_mode', 'Payment Mode', 'payment_mode'),
          F.text('reference_number', 'Reference / UTR', { searchable: true }),
          F.text('bank_name', 'Bank'),
          F.text('cheque_number', 'Cheque Number'),
          F.date('cheque_date', 'Cheque Date'),
          F.text('receipt_number', 'Receipt Number', { searchable: true }),
        ],
      },
      {
        name: 'reminders',
        label: 'Reminders',
        collapsed: true,
        fields: [
          F.num('reminder_count', 'Reminders Sent', { readonly: true }),
          F.datetime('last_reminder_at', 'Last Reminder', { readonly: true }),
          F.textarea('description', 'Notes'),
        ],
      },
    ],
    views: [
      { name: 'All Payments', isDefault: true, showMetrics: true, columns: ['payment_number', 'booking_id', 'contact_id', 'milestone', 'amount_due', 'amount_paid', 'due_date', 'status'], sortBy: 'due_date' },
      { name: 'Overdue', showMetrics: true, columns: ['payment_number', 'contact_id', 'milestone', 'amount_due', 'due_date', 'reminder_count', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'due_date', operator: 'less_than', value: 'now' }, { field: 'status', operator: 'in', value: ['Pending', 'Due', 'Overdue', 'Partially Paid'] }] }, sortBy: 'due_date', sortDir: 'asc' },
      { name: 'Due This Week', columns: ['payment_number', 'contact_id', 'amount_due', 'due_date', 'status'], filter: { logic: 'AND', conditions: [{ field: 'due_date', operator: 'next_n_days', value: 7 }, { field: 'status', operator: 'not_equals', value: 'Paid' }] }, sortBy: 'due_date', sortDir: 'asc' },
      { name: 'Collections', displayMode: 'kanban', groupBy: 'status', columns: ['payment_number', 'contact_id', 'amount_due', 'due_date'] },
    ],
  },

  // =========================================================================
  // CHANNEL PARTNERS
  // =========================================================================
  {
    name: 'channel_partners',
    label: 'Channel Partners',
    singular: 'Channel Partner',
    table: 'ipy_e_channel_partners',
    icon: 'briefcase',
    color: '#a855f7',
    sequence: 100,
    menuGroup: 'Sales',
    // Retired in migration 025 — the business does not use this.
    showInMenu: false,
    labelFields: ['name'],
    duplicateCheckFields: ['mobile', 'rera_number'],
    blocks: [
      {
        name: 'partner_information',
        label: 'Partner Information',
        fields: [
          F.autonum('partner_number', 'Partner #', 'CP-'),
          F.text('name', 'Partner Name', { mandatory: true, quickCreate: true, searchable: true }),
          F.pick('partner_type', 'Partner Type', 'channel_partner_type', { quickCreate: true }),
          F.text('firm_name', 'Firm Name', { searchable: true }),
          F.text('contact_person', 'Contact Person'),
          F.phone('mobile', 'Mobile', { mandatory: true, quickCreate: true }),
          F.email('email', 'Email', { quickCreate: true }),
          F.phone('whatsapp_number', 'WhatsApp Number'),
          F.pick('city', 'City', 'city'),
          F.pick('status', 'Status', 'partner_status', { quickCreate: true }),
          F.pick('tier', 'Tier', 'partner_tier'),
          F.owner(),
        ],
      },
      {
        name: 'agreement',
        label: 'Agreement & Compliance',
        fields: [
          F.text('rera_number', 'RERA Number'),
          F.text('gstin', 'GSTIN'),
          F.text('pan', 'PAN'),
          F.date('onboarded_on', 'Onboarded On'),
          F.date('agreement_expiry', 'Agreement Expiry'),
          F.pct('commission_percent', 'Commission %'),
          F.json('commission_slab', 'Commission Slabs', { help: 'Volume-based slabs, e.g. [{"min":0,"max":50000000,"pct":2}]' }),
          F.multipick('assigned_projects', 'Assigned Projects', 'project_status', { displayType: 'hidden' }),
          F.bool('portal_access', 'Partner Portal Access'),
        ],
      },
      {
        name: 'performance',
        label: 'Performance',
        fields: [
          F.num('leads_submitted', 'Leads Submitted', { readonly: true }),
          F.num('site_visits_done', 'Site Visits', { readonly: true }),
          F.num('bookings_closed', 'Bookings Closed', { readonly: true }),
          F.money('total_sales_value', 'Total Sales Value', { readonly: true }),
          F.pct('conversion_rate', 'Conversion Rate', { readonly: true }),
          F.money('commission_earned', 'Commission Earned', { readonly: true }),
          F.money('commission_paid', 'Commission Paid', { readonly: true }),
          F.num('rating', 'Rating (1-5)'),
        ],
      },
      {
        name: 'more',
        label: 'More Information',
        collapsed: true,
        fields: [F.address('address', 'Address'), F.json('bank_details', 'Bank Details'), F.textarea('description', 'Notes')],
      },
    ],
    relations: [
      { name: 'partner_leads', label: 'Leads', target: 'leads', type: 'one_to_many', foreignField: 'channel_partner_id' },
      { name: 'partner_bookings', label: 'Bookings', target: 'bookings', type: 'one_to_many', foreignField: 'channel_partner_id' },
      { name: 'partner_site_visits', label: 'Site Visits', target: 'site_visits', type: 'one_to_many', foreignField: 'channel_partner_id' },
    ],
    views: [
      { name: 'All Partners', isDefault: true, columns: ['partner_number', 'name', 'partner_type', 'mobile', 'city', 'status', 'tier', 'bookings_closed', 'total_sales_value'], sortBy: 'created_at' },
      { name: 'Top Performers', columns: ['name', 'firm_name', 'bookings_closed', 'total_sales_value', 'conversion_rate', 'tier'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Active' }] }, sortBy: 'total_sales_value' },
      { name: 'Agreements Expiring', columns: ['name', 'mobile', 'agreement_expiry', 'status'], filter: { logic: 'AND', conditions: [{ field: 'agreement_expiry', operator: 'next_n_days', value: 60 }] }, sortBy: 'agreement_expiry', sortDir: 'asc' },
    ],
  },

  // =========================================================================
  // CAMPAIGNS
  // =========================================================================
  {
    name: 'campaigns',
    label: 'Campaigns',
    singular: 'Campaign',
    table: 'ipy_e_campaigns',
    icon: 'megaphone',
    color: '#ef4444',
    sequence: 110,
    menuGroup: 'Marketing',
    labelFields: ['name'],
    pipelineField: 'status',
    blocks: [
      {
        name: 'campaign_information',
        label: 'Campaign Information',
        fields: [
          F.autonum('campaign_number', 'Campaign #', 'CMP-'),
          F.text('name', 'Campaign Name', { mandatory: true, quickCreate: true, searchable: true }),
          F.pick('campaign_type', 'Type', 'campaign_type', { quickCreate: true }),
          F.pick('status', 'Status', 'campaign_status', { mandatory: true, quickCreate: true }),
          F.text('channel', 'Channel'),
          F.ref('project_id', 'Project', ['projects'], { quickCreate: true }),
          F.date('start_date', 'Start Date', { quickCreate: true }),
          F.date('end_date', 'End Date'),
          F.owner(),
        ],
      },
      {
        name: 'budget',
        label: 'Budget & Targeting',
        fields: [
          F.money('budget', 'Budget', { quickCreate: true }),
          F.money('actual_cost', 'Actual Spend'),
          F.textarea('target_audience', 'Target Audience'),
        ],
      },
      {
        name: 'performance',
        label: 'Performance',
        fields: [
          F.num('impressions', 'Impressions'),
          F.num('clicks', 'Clicks'),
          F.num('leads_generated', 'Leads Generated', { readonly: true }),
          F.num('qualified_leads', 'Qualified Leads', { readonly: true }),
          F.num('site_visits', 'Site Visits', { readonly: true }),
          F.num('bookings', 'Bookings', { readonly: true }),
          F.money('revenue_generated', 'Revenue Generated', { readonly: true }),
          {
            name: 'cost_per_lead', label: 'Cost per Lead', uitype: 'formula', column: 'cost_per_lead',
            readonly: true,
            config: { formula: { expression: 'IF({leads_generated} > 0, {actual_cost} / {leads_generated}, 0)', returnType: 'number' }, currency: 'INR' },
          },
          {
            name: 'roi_percent', label: 'ROI %', uitype: 'formula', column: 'roi_percent',
            readonly: true,
            config: { formula: { expression: 'IF({actual_cost} > 0, (({revenue_generated} - {actual_cost}) / {actual_cost}) * 100, 0)', returnType: 'number' } },
          },
        ],
      },
      {
        name: 'attribution',
        label: 'Attribution Keys',
        collapsed: true,
        fields: [
          F.text('utm_campaign', 'UTM Campaign', { help: 'Inbound leads carrying this UTM auto-attribute here' }),
          F.text('external_id', 'External ID', { help: 'Facebook / Google campaign id' }),
          F.textarea('description', 'Description'),
        ],
      },
    ],
    relations: [
      { name: 'campaign_leads', label: 'Leads', target: 'leads', type: 'one_to_many', foreignField: 'campaign_id' },
      { name: 'campaign_deals', label: 'Deals', target: 'deals', type: 'one_to_many', foreignField: 'campaign_id' },
    ],
    views: [
      { name: 'All Campaigns', isDefault: true, columns: ['campaign_number', 'name', 'campaign_type', 'status', 'start_date', 'budget', 'leads_generated', 'cost_per_lead', 'roi_percent'], sortBy: 'start_date' },
      { name: 'Active Campaigns', showMetrics: true, columns: ['name', 'campaign_type', 'leads_generated', 'qualified_leads', 'actual_cost', 'cost_per_lead'], filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Active' }] } },
      { name: 'ROI Leaderboard', columns: ['name', 'actual_cost', 'revenue_generated', 'roi_percent', 'bookings'], sortBy: 'roi_percent' },
    ],
  },

  // =========================================================================
  // ACTIVITIES
  // =========================================================================
  {
    name: 'activities',
    label: 'Activities',
    singular: 'Activity',
    table: 'ipy_e_activities',
    icon: 'calendar-check',
    color: '#3b82f6',
    sequence: 120,
    menuGroup: 'Productivity',
    // A tab on the lead.
    showInMenu: false,
    labelFields: ['subject'],
    pipelineField: 'status',
    blocks: [
      {
        name: 'activity_information',
        label: 'Activity Information',
        fields: [
          F.autonum('activity_number', 'Activity #', 'ACT-'),
          F.text('subject', 'Subject', { mandatory: true, quickCreate: true, searchable: true }),
          F.pick('activity_type', 'Type', 'activity_type', { mandatory: true, quickCreate: true }),
          F.pick('status', 'Status', 'activity_status', { mandatory: true, quickCreate: true }),
          F.pick('priority', 'Priority', 'priority', { quickCreate: true }),
          F.owner(),
        ],
      },
      {
        name: 'scheduling',
        label: 'Scheduling',
        fields: [
          F.datetime('start_at', 'Start', { quickCreate: true }),
          F.datetime('end_at', 'End'),
          F.date('due_date', 'Due Date', { quickCreate: true }),
          F.bool('all_day', 'All Day'),
          F.text('location', 'Location'),
          F.num('reminder_minutes', 'Reminder (min before)'),
          F.bool('is_recurring', 'Recurring'),
          F.json('recurrence', 'Recurrence Rule', { displayType: 'detail_only' }),
        ],
      },
      {
        name: 'related',
        label: 'Related To',
        fields: [
          F.ref('related_to', 'Related Record', ['leads', 'deals', 'projects', 'properties', 'bookings', 'channel_partners'], { quickCreate: true }),
          F.text('related_module', 'Related Module', { displayType: 'hidden' }),
          F.ref('contact_id', 'Buyer', ['leads']),
          F.json('participants', 'Participants'),
        ],
      },
      {
        name: 'outcome',
        label: 'Outcome',
        fields: [
          F.datetime('completed_at', 'Completed At', { readonly: true }),
          F.textarea('outcome', 'Outcome'),
          F.bool('is_ai_generated', 'Created by AI', { readonly: true }),
          F.textarea('description', 'Description', { searchable: true }),
        ],
      },
    ],
    views: [
      { name: 'All Activities', isDefault: true, columns: ['subject', 'activity_type', 'status', 'priority', 'due_date', 'related_to', 'owner_id'], sortBy: 'due_date' },
      { name: 'My Tasks Today', showMetrics: true, columns: ['subject', 'activity_type', 'priority', 'due_date', 'related_to'], filter: { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_me' }, { field: 'due_date', operator: 'today' }, { field: 'status', operator: 'not_equals', value: 'Completed' }] }, sortBy: 'priority' },
      { name: 'Overdue', showMetrics: true, columns: ['subject', 'activity_type', 'due_date', 'related_to', 'owner_id'], filter: { logic: 'AND', conditions: [{ field: 'due_date', operator: 'less_than', value: 'now' }, { field: 'status', operator: 'not_in', value: ['Completed', 'Cancelled'] }] }, sortBy: 'due_date', sortDir: 'asc' },
      { name: 'Calendar', displayMode: 'calendar', columns: ['subject', 'start_at', 'end_at', 'activity_type'], sortBy: 'start_at', sortDir: 'asc' },
      { name: 'By Status', displayMode: 'kanban', groupBy: 'status', columns: ['subject', 'activity_type', 'due_date', 'owner_id'] },
    ],
  },

  // =========================================================================
  // DOCUMENTS
  // =========================================================================
  {
    name: 'documents',
    label: 'Documents',
    singular: 'Document',
    table: 'ipy_e_documents',
    icon: 'folder-open',
    color: '#64748b',
    sequence: 130,
    menuGroup: 'Productivity',
    // Retired in migration 025 — the business does not use this.
    showInMenu: false,
    labelFields: ['title'],
    blocks: [
      {
        name: 'document_information',
        label: 'Document Information',
        fields: [
          F.autonum('document_number', 'Document #', 'DOC-'),
          F.text('title', 'Title', { mandatory: true, quickCreate: true, searchable: true }),
          F.pick('document_type', 'Document Type', 'document_type', { quickCreate: true }),
          F.text('category', 'Category'),
          F.ref('related_to', 'Related Record', ['leads', 'deals', 'bookings', 'projects', 'properties', 'organizations'], { quickCreate: true }),
          F.text('related_module', 'Related Module', { displayType: 'hidden' }),
          F.ref('project_id', 'Project', ['projects']),
          F.owner(),
        ],
      },
      {
        name: 'file',
        label: 'File',
        fields: [
          F.text('file_name', 'File Name'),
          F.url('file_url', 'File URL'),
          F.text('storage_key', 'Storage Key', { displayType: 'hidden' }),
          F.text('mime_type', 'MIME Type', { readonly: true }),
          F.num('file_size', 'Size (bytes)', { readonly: true }),
          F.text('version', 'Version', { default: '1.0' }),
          F.date('expiry_date', 'Expiry Date'),
        ],
      },
      {
        name: 'sharing',
        label: 'Sharing',
        collapsed: true,
        fields: [
          F.bool('is_public', 'Publicly Shareable'),
          F.text('share_token', 'Share Token', { readonly: true, displayType: 'hidden' }),
          F.datetime('share_expires_at', 'Share Link Expires'),
          F.num('download_count', 'Downloads', { readonly: true }),
        ],
      },
      {
        name: 'ai',
        label: 'AI Extraction',
        collapsed: true,
        fields: [
          F.textarea('ai_summary', 'AI Summary', { readonly: true }),
          F.textarea('extracted_text', 'Extracted Text', { readonly: true, displayType: 'detail_only', searchable: true }),
          F.textarea('description', 'Description'),
        ],
      },
    ],
    views: [
      { name: 'All Documents', isDefault: true, columns: ['document_number', 'title', 'document_type', 'related_to', 'file_size', 'created_at', 'owner_id'], sortBy: 'created_at' },
      { name: 'Expiring Soon', columns: ['title', 'document_type', 'expiry_date', 'related_to'], filter: { logic: 'AND', conditions: [{ field: 'expiry_date', operator: 'next_n_days', value: 30 }] }, sortBy: 'expiry_date', sortDir: 'asc' },
      { name: 'KYC Documents', columns: ['title', 'document_type', 'related_to', 'created_at'], filter: { logic: 'AND', conditions: [{ field: 'document_type', operator: 'contains', value: 'KYC' }] } },
    ],
  },

  // =========================================================================
  // Blog — written here, published to the public website.
  //
  // An ordinary module rather than a bolted-on CMS, so posts get list views,
  // roles, sharing rules, workflows and custom fields for free, and the
  // website keeps reading everything from one API.
  // =========================================================================
  {
    name: 'blog_posts',
    label: 'Blog',
    singular: 'Post',
    table: 'ipy_e_blog_posts',
    icon: 'newspaper',
    color: '#0ea5e9',
    sequence: 115,
    menuGroup: 'Marketing',
    // Retired in migration 025 — the business does not use this.
    showInMenu: false,
    labelFields: ['title'],
    pipelineField: 'status',
    blocks: [
      {
        name: 'post',
        label: 'Post',
        fields: [
          F.autonum('post_number', 'Post #', 'BLOG-'),
          F.text('title', 'Title', { mandatory: true, quickCreate: true, searchable: true }),
          // Left blank the publish hook derives it from the title; stored, not
          // derived on read, so renaming a post never breaks a live URL.
          F.text('slug', 'URL slug', { help: 'Leave blank to generate from the title. Changing this breaks existing links.' }),
          F.pick('status', 'Status', 'blog_status', { mandatory: true, quickCreate: true }),
          F.pick('category', 'Category', 'blog_category', { quickCreate: true }),
          F.textarea('excerpt', 'Excerpt', { searchable: true, help: 'One or two sentences. Used on cards, in search results and as the fallback meta description.' }),
          F.textarea('body', 'Body (Markdown)', { searchable: true }),
          F.image('cover_image_url', 'Cover image'),
          F.ref('project_id', 'Related project', ['projects']),
          F.datetime('published_at', 'Publish at', { help: 'Set a future time and the post goes live by itself.' }),
          F.owner(),
        ],
      },
      {
        name: 'seo',
        label: 'Search & AI visibility',
        collapsed: true,
        fields: [
          F.text('seo_title', 'SEO title', { help: 'Falls back to the post title. Aim for under 60 characters.' }),
          F.textarea('seo_description', 'Meta description', { help: 'Falls back to the excerpt. Aim for 150–160 characters.' }),
          F.text('seo_keywords', 'Focus keywords', { help: 'Comma-separated. Used by the daily SEO audit to check the post actually covers them.' }),
          F.text('canonical_url', 'Canonical URL', { help: 'Only if this was published somewhere else first.' }),
          // The answer-engine half: a quotable answer and FAQ pairs are what
          // AI assistants and rich results actually lift.
          F.textarea('key_takeaway', 'Key takeaway', { help: 'One self-contained sentence answering the reader’s question — this is what AI assistants quote.' }),
          F.bool('noindex', 'Hide from search engines'),
        ],
      },
      {
        name: 'stats',
        label: 'Stats',
        collapsed: true,
        fields: [
          F.num('word_count', 'Word count', { readonly: true }),
          F.num('reading_minutes', 'Reading time (min)', { readonly: true }),
          F.num('view_count', 'Views', { readonly: true }),
        ],
      },
    ],
    views: [
      { name: 'All Posts', isDefault: true, columns: ['post_number', 'title', 'status', 'category', 'published_at', 'owner_id'], sortBy: 'published_at', sortDir: 'desc' },
      { name: 'Drafts', columns: ['title', 'category', 'owner_id', 'updated_at'], sortBy: 'updated_at', sortDir: 'desc', filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Draft' }] } },
      { name: 'Published', columns: ['title', 'category', 'published_at', 'view_count'], sortBy: 'published_at', sortDir: 'desc', filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Published' }] } },
      { name: 'Scheduled', columns: ['title', 'published_at', 'owner_id'], sortBy: 'published_at', sortDir: 'asc', filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Scheduled' }] } },
    ],
  },

];
