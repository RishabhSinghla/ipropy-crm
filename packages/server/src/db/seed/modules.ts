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
      { name: 'project_campaigns', label: 'Campaigns', target: 'campaigns', type: 'one_to_many', foreignField: 'project_id' },
    ],
    views: [
      { name: 'All Projects', isDefault: true, columns: ['project_code', 'name', 'status', 'city', 'locality', 'price_min', 'price_max', 'available_units', 'possession_date'], sortBy: 'created_at' },
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
          F.ref('related_to', 'Related Record', ['leads', 'properties', 'projects'], { quickCreate: true }),
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

  // =========================================================================
  // Blog — written here, published to the public website.
  //
  // An ordinary module rather than a bolted-on CMS, so posts get list views,
  // roles, sharing rules, workflows and custom fields for free, and the
  // website keeps reading everything from one API.
  // =========================================================================

];
