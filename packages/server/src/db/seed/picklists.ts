import {
  ACTIVITY_TYPES, AMENITIES, BOOKING_STATUS, BUDGET_BANDS, CALL_DISPOSITIONS,
  CHANNEL_PARTNER_TYPES, CONFIGURATIONS, DEAL_STAGES, FACING_OPTIONS, FUNDING_TYPE,
  FURNISHING, INDIAN_STATES, LEAD_SOURCES, LEAD_STATUSES, PAYMENT_MODES, PAYMENT_STATUS,
  POSSESSION_STATUS, PROJECT_STATUS, PROPERTY_STATUSES, PROPERTY_TYPES, PURPOSE,
  SITE_VISIT_STATUS, TIMELINE_OPTIONS,
} from '@ipropy/shared';
import type { Tx } from '../pool.js';
import { upsertPicklist, type PicklistDef } from './helpers.js';

/** Every dropdown in the CRM, seeded once and then fully admin-editable. */
export const PICKLISTS: PicklistDef[] = [
  { name: 'lead_status', ordered: true, label: 'Lead Status', values: LEAD_STATUSES.map((s) => ({ ...s, isDefault: s.value === 'New' })) },
  { name: 'lead_source', label: 'Lead Source', values: [...LEAD_SOURCES] },
  { name: 'lead_sub_source', label: 'Lead Sub Source', values: ['Organic', 'Paid', 'Retargeting', 'Email Blast', 'SMS Blast', 'Broker Network', 'Existing Customer', 'Employee Referral'] },
  {
    name: 'deal_stage', ordered: true, label: 'Deal Stage',
    values: DEAL_STAGES.map((s) => ({ value: s.value, label: s.label, color: s.color, isDefault: s.value === 'Enquiry', meta: { probability: s.probability, isWon: s.value === 'Booked', isLost: s.value === 'Lost' } })),
  },
  { name: 'property_status', ordered: true, label: 'Property Status', values: PROPERTY_STATUSES.map((s) => ({ ...s, isDefault: s.value === 'Available' })) },
  { name: 'property_type', label: 'Property Type', values: [...PROPERTY_TYPES] },
  // Kept for the Contacts side — what BHK(s) a buyer wants. The name stays
  // 'configuration' (buyer matching reads it by that key; see
  // FIELDS_USED_IN_CODE), but the label carries no trace of the word: this
  // business calls it "Bedrooms Wanted" and there is no equivalent field left
  // on Properties to disambiguate it from.
  { name: 'configuration', label: 'Bedroom Type', values: [...CONFIGURATIONS] },
  { name: 'facing', label: 'Facing', values: [...FACING_OPTIONS] },
  { name: 'furnishing', label: 'Furnishing', values: [...FURNISHING] },
  { name: 'possession_status', ordered: true, label: 'Possession Status', values: [...POSSESSION_STATUS] },
  { name: 'project_status', ordered: true, label: 'Project Status', values: PROJECT_STATUS.map((s) => ({ ...s })) },
  { name: 'project_type', label: 'Project Type', values: ['Residential', 'Commercial', 'Mixed Use', 'Plotted Development', 'Township', 'Industrial', 'Hospitality'] },
  { name: 'purpose', label: 'Purpose', values: [...PURPOSE] },
  // The unit half of an Area field. A picklist rather than free text so it
  // groups, filters and reports — but rendered inside the area control, not as
  // a dropdown of its own.
  { name: 'area_unit', ordered: true, label: 'Area Unit', values: [
    { value: 'sqft', label: 'Sq.ft.', isDefault: true },
    { value: 'sqyd', label: 'Sq.yd.' },
  ] },
  // The qualifier half of a Budget/Demand field: is the price per Sq.ft., per
  // Sq.yd., or the whole thing? Same shape as `area_unit` — rendered inside
  // the price control, not a dropdown of its own.
  { name: 'price_unit', ordered: true, label: 'Price Unit', values: [
    { value: 'sqft', label: 'Sq. ft.', isDefault: true },
    { value: 'sqyd', label: 'Sq. yd.' },
    { value: 'total', label: 'Total' },
  ] },
  { name: 'budget_band', ordered: true, label: 'Budget Band', values: [...BUDGET_BANDS] },
  { name: 'purchase_timeline', ordered: true, label: 'Purchase Timeline', values: [...TIMELINE_OPTIONS] },
  { name: 'funding_type', label: 'Funding Type', values: [...FUNDING_TYPE] },
  { name: 'site_visit_status', ordered: true, label: 'Site Visit Status', values: SITE_VISIT_STATUS.map((s) => ({ ...s, isDefault: s.value === 'Scheduled' })) },
  { name: 'site_visit_type', label: 'Site Visit Type', values: ['First Visit', 'Revisit', 'Virtual Tour', 'Sample Flat', 'Site Walkthrough', 'Possession Visit'] },
  { name: 'interest_level', ordered: true, label: 'Interest Level', values: [
    { value: 'Very High', label: 'Very High', color: '#22c55e' },
    { value: 'High', label: 'High', color: '#84cc16' },
    { value: 'Medium', label: 'Medium', color: '#f59e0b' },
    { value: 'Low', label: 'Low', color: '#f97316' },
    { value: 'Not Interested', label: 'Not Interested', color: '#ef4444' },
  ] },
  { name: 'booking_status', ordered: true, label: 'Booking Status', values: BOOKING_STATUS.map((s) => ({ ...s })) },
  { name: 'payment_status', ordered: true, label: 'Payment Status', values: PAYMENT_STATUS.map((s) => ({ ...s, isDefault: s.value === 'Pending' })) },
  { name: 'payment_mode', label: 'Payment Mode', values: [...PAYMENT_MODES] },
  { name: 'payment_plan', label: 'Payment Plan', values: ['Construction Linked Plan (CLP)', 'Down Payment Plan', 'Flexi Payment Plan', 'Subvention Scheme', 'Possession Linked Plan', 'Time Linked Plan', 'Custom'] },
  { name: 'loan_status', ordered: true, label: 'Loan Status', values: [
    { value: 'Not Applied', label: 'Not Applied', color: '#94a3b8' },
    { value: 'Applied', label: 'Applied', color: '#0ea5e9' },
    { value: 'Under Process', label: 'Under Process', color: '#f59e0b' },
    { value: 'Sanctioned', label: 'Sanctioned', color: '#22c55e' },
    { value: 'Disbursed', label: 'Disbursed', color: '#14b8a6' },
    { value: 'Rejected', label: 'Rejected', color: '#ef4444' },
  ] },
  { name: 'amenities', label: 'Amenities', values: [...AMENITIES] },
  { name: 'activity_type', label: 'Activity Type', values: ACTIVITY_TYPES.map((s) => ({ ...s })) },
  { name: 'activity_status', ordered: true, label: 'Activity Status', values: [
    { value: 'Not Started', label: 'Not Started', color: '#94a3b8', isDefault: true },
    { value: 'In Progress', label: 'In Progress', color: '#0ea5e9' },
    { value: 'Completed', label: 'Completed', color: '#22c55e' },
    { value: 'Deferred', label: 'Deferred', color: '#f59e0b' },
    { value: 'Cancelled', label: 'Cancelled', color: '#ef4444' },
  ] },
  { name: 'priority', ordered: true, label: 'Priority', values: [
    { value: 'Urgent', label: 'Urgent', color: '#dc2626' },
    { value: 'High', label: 'High', color: '#f97316' },
    { value: 'Medium', label: 'Medium', color: '#0ea5e9', isDefault: true },
    { value: 'Low', label: 'Low', color: '#94a3b8' },
  ] },
  { name: 'call_disposition', label: 'Call Disposition', values: [...CALL_DISPOSITIONS] },
  { name: 'rating', ordered: true, label: 'Rating', values: [
    { value: 'Hot', label: 'Hot', color: '#ef4444' },
    { value: 'Warm', label: 'Warm', color: '#f59e0b' },
    { value: 'Cold', label: 'Cold', color: '#3b82f6' },
  ] },
  { name: 'lost_reason', label: 'Lost Reason', values: [
    'Budget Mismatch', 'Location Not Suitable', 'Bought Elsewhere', 'Loan Rejected',
    'Postponed Purchase', 'Possession Timeline', 'Unit Not Available', 'Price Too High',
    'Competitor Offered Better', 'Legal/RERA Concerns', 'Vastu Concerns', 'No Response',
  ] },
  { name: 'junk_reason', label: 'Junk Reason', values: ['Wrong Number', 'Duplicate', 'Test Entry', 'Broker Enquiry', 'Job Seeker', 'Out of Service Area', 'Spam'] },
  /*
    Buyer is the default, and it has to be one. `contact_type` is mandatory, and
    with no default not one automated source could create a lead — the website
    form, Facebook, Google, the portals and inbound email all failed validation
    on it. The website form answered "Thanks — our team will call you shortly"
    and threw every enquiry away, leaving only a failed row in a table nobody
    opens.

    It belongs here rather than only in a migration: migrations run before the
    seed exists, so a migration updating this picklist matches nothing on a
    fresh database — which is exactly how the first attempt at this fix passed
    on a developer's machine and failed on a clean one.
  */
  { name: 'contact_type', label: 'Contact Type', values: ['Buyer', 'Seller', 'Tenant', 'Landlord', 'Investor', 'Broker', 'Consultant', 'Vendor', 'Other'].map((value) => ({ value, isDefault: value === 'Buyer' })) },
  { name: 'org_type', label: 'Organisation Type', values: ['Developer', 'Builder', 'Corporate Client', 'Investor Group', 'Financial Institution', 'Vendor', 'Contractor', 'Law Firm', 'Marketing Agency'] },
  { name: 'channel_partner_type', label: 'Channel Partner Type', values: [...CHANNEL_PARTNER_TYPES] },
  { name: 'partner_status', ordered: true, label: 'Partner Status', values: [
    { value: 'Active', label: 'Active', color: '#22c55e', isDefault: true },
    { value: 'Onboarding', label: 'Onboarding', color: '#0ea5e9' },
    { value: 'Inactive', label: 'Inactive', color: '#94a3b8' },
    { value: 'Blacklisted', label: 'Blacklisted', color: '#ef4444' },
  ] },
  { name: 'partner_tier', ordered: true, label: 'Partner Tier', values: [
    { value: 'Platinum', label: 'Platinum', color: '#8b5cf6' },
    { value: 'Gold', label: 'Gold', color: '#f59e0b' },
    { value: 'Silver', label: 'Silver', color: '#94a3b8' },
    { value: 'Bronze', label: 'Bronze', color: '#b45309' },
  ] },
  { name: 'document_type', label: 'Document Type', values: [
    'Brochure', 'Floor Plan', 'Master Plan', 'Price List', 'Cost Sheet', 'Payment Plan',
    'Allotment Letter', 'Agreement to Sale', 'Sale Deed', 'RERA Certificate', 'Approval',
    'KYC — PAN', 'KYC — Aadhaar', 'KYC — Passport', 'Bank Statement', 'Salary Slip',
    'Loan Sanction Letter', 'Payment Receipt', 'NOC', 'Possession Letter', 'Other',
  ] },
  { name: 'kyc_status', ordered: true, label: 'KYC Status', values: [
    { value: 'Not Started', label: 'Not Started', color: '#94a3b8', isDefault: true },
    { value: 'Documents Requested', label: 'Documents Requested', color: '#0ea5e9' },
    { value: 'Partially Submitted', label: 'Partially Submitted', color: '#f59e0b' },
    { value: 'Under Verification', label: 'Under Verification', color: '#a855f7' },
    { value: 'Verified', label: 'Verified', color: '#22c55e' },
    { value: 'Rejected', label: 'Rejected', color: '#ef4444' },
  ] },
  { name: 'salutation', label: 'Salutation', values: ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Er.', 'CA'] },
  { name: 'gender', label: 'Gender', values: ['Male', 'Female', 'Other', 'Prefer not to say'] },
  { name: 'preferred_contact', label: 'Preferred Contact Method', values: ['Phone Call', 'WhatsApp', 'Email', 'SMS', 'In Person'] },
  { name: 'language', label: 'Preferred Language', values: ['English', 'Hindi', 'Marathi', 'Gujarati', 'Kannada', 'Tamil', 'Telugu', 'Bengali', 'Punjabi', 'Malayalam', 'Odia'] },
  { name: 'state', label: 'State', values: [...INDIAN_STATES] },
  {
    name: 'city', label: 'City',
    values: [
      'Mumbai', 'Navi Mumbai', 'Thane', 'Pune', 'Bengaluru', 'Hyderabad', 'Chennai',
      'Delhi', 'Gurugram', 'Noida', 'Ghaziabad', 'Faridabad', 'Ahmedabad', 'Surat',
      'Kolkata', 'Jaipur', 'Lucknow', 'Indore', 'Nagpur', 'Kochi', 'Chandigarh',
      'Bhubaneswar', 'Coimbatore', 'Visakhapatnam', 'Goa', 'Dehradun', 'Mysuru',
    ],
  },
  { name: 'micro_market', label: 'Micro Market', values: ['Prime', 'Emerging', 'Established', 'Peripheral', 'CBD', 'Suburban', 'IT Corridor', 'Industrial Belt'] },
  { name: 'occupation', label: 'Occupation', values: ['Salaried — IT', 'Salaried — Non IT', 'Business Owner', 'Self Employed Professional', 'Doctor', 'Chartered Accountant', 'Lawyer', 'Government Service', 'Defence', 'Retired', 'NRI Professional', 'Student', 'Homemaker'] },
  { name: 'commission_status', ordered: true, label: 'Commission Status', values: [
    { value: 'Not Due', label: 'Not Due', color: '#94a3b8', isDefault: true },
    { value: 'Due', label: 'Due', color: '#f59e0b' },
    { value: 'Invoice Raised', label: 'Invoice Raised', color: '#0ea5e9' },
    { value: 'Partially Paid', label: 'Partially Paid', color: '#f97316' },
    { value: 'Paid', label: 'Paid', color: '#22c55e' },
    { value: 'On Hold', label: 'On Hold', color: '#ef4444' },
  ] },
  { name: 'sentiment', label: 'Sentiment', values: [
    { value: 'positive', label: 'Positive', color: '#22c55e' },
    { value: 'neutral', label: 'Neutral', color: '#94a3b8' },
    { value: 'negative', label: 'Negative', color: '#ef4444' },
  ] },
];

/** Cascading dropdowns: picking a City narrows the Locality options. */
export const CITY_LOCALITIES: Record<string, string[]> = {
  Mumbai: ['Andheri West', 'Andheri East', 'Bandra West', 'Borivali', 'Chembur', 'Dadar', 'Goregaon', 'Juhu', 'Kandivali', 'Lower Parel', 'Malad', 'Mulund', 'Powai', 'Worli'],
  'Navi Mumbai': ['Airoli', 'Belapur', 'Kharghar', 'Nerul', 'Panvel', 'Sanpada', 'Seawoods', 'Vashi', 'Ulwe', 'Taloja'],
  Thane: ['Ghodbunder Road', 'Kolshet', 'Majiwada', 'Manpada', 'Vartak Nagar', 'Wagle Estate', 'Kalwa', 'Dombivli'],
  Pune: ['Baner', 'Hinjewadi', 'Kharadi', 'Koregaon Park', 'Magarpatta', 'Wakad', 'Viman Nagar', 'Undri', 'Hadapsar', 'Bavdhan', 'Ravet', 'Kalyani Nagar'],
  Bengaluru: ['Whitefield', 'Sarjapur Road', 'Electronic City', 'Hebbal', 'Indiranagar', 'Koramangala', 'JP Nagar', 'Yelahanka', 'Devanahalli', 'Bannerghatta Road', 'Marathahalli', 'Kanakapura Road', 'Jayanagar', 'HSR Layout'],
  Hyderabad: ['Gachibowli', 'Kondapur', 'Kokapet', 'Madhapur', 'Kukatpally', 'Miyapur', 'Banjara Hills', 'Jubilee Hills', 'Narsingi', 'Tellapur', 'Shamshabad'],
  Chennai: ['OMR', 'Adyar', 'Anna Nagar', 'Velachery', 'Porur', 'Sholinganallur', 'Perungudi', 'Thoraipakkam', 'Guindy', 'Medavakkam'],
  Delhi: ['Dwarka', 'Rohini', 'Saket', 'Vasant Kunj', 'Pitampura', 'Janakpuri', 'Mayur Vihar', 'Greater Kailash'],
  Gurugram: ['Golf Course Road', 'Sohna Road', 'Dwarka Expressway', 'MG Road', 'Sector 57', 'New Gurgaon', 'Golf Course Ext Road', 'Southern Peripheral Road'],
  Noida: ['Sector 62', 'Sector 150', 'Sector 137', 'Noida Extension', 'Sector 128', 'Greater Noida West', 'Sector 78'],
  Ahmedabad: ['SG Highway', 'Satellite', 'Bopal', 'Prahlad Nagar', 'Vastrapur', 'Shela', 'Gota', 'Chandkheda'],
  Kolkata: ['New Town', 'Rajarhat', 'Salt Lake', 'Ballygunge', 'Behala', 'Tollygunge', 'EM Bypass', 'Howrah'],
  Jaipur: ['Vaishali Nagar', 'Mansarovar', 'Jagatpura', 'Ajmer Road', 'Tonk Road', 'Malviya Nagar'],
  Kochi: ['Kakkanad', 'Edappally', 'Marine Drive', 'Panampilly Nagar', 'Aluva', 'Vyttila'],
};

export async function seedPicklists(conn: Tx): Promise<void> {
  for (const def of PICKLISTS) {
    await upsertPicklist(conn, def);
  }
  // Locality is derived from the city map so both stay in sync.
  const localities = [...new Set(Object.values(CITY_LOCALITIES).flat())].sort();
  await upsertPicklist(conn, { name: 'locality', label: 'Locality', values: localities });
}

/** Wire the City → Locality dependency for every module that has both fields. */
export async function seedPicklistDependencies(conn: Tx): Promise<void> {
  const modules = ['properties', 'leads'];
  for (const moduleName of modules) {
    const mod = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [moduleName]);
    if (!mod) continue;
    const hasBoth = await conn.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_field WHERE module_id = $1 AND name IN ('city','locality')`,
      [mod.id],
    );
    if ((hasBoth?.count ?? 0) < 2) continue;
    await conn.query(
      `INSERT INTO ipy_picklist_dependency (module_id, source_field, target_field, mapping)
       VALUES ($1,'city','locality',$2)
       ON CONFLICT (module_id, source_field, target_field) DO UPDATE SET mapping = EXCLUDED.mapping`,
      [mod.id, JSON.stringify(CITY_LOCALITIES)],
    );
  }
}
