/**
 * Domain constants for the real-estate vertical. These seed the default
 * picklists but remain fully editable by admins at runtime — nothing here is
 * hard-coded into business logic.
 */

export const LEAD_STATUSES = [
  { value: 'New', label: 'New', color: '#64748b' },
  { value: 'Attempted Contact', label: 'Attempted Contact', color: '#94a3b8' },
  { value: 'Contacted', label: 'Contacted', color: '#0ea5e9' },
  { value: 'Qualified', label: 'Qualified', color: '#8b5cf6' },
  { value: 'Site Visit Scheduled', label: 'Site Visit Scheduled', color: '#f59e0b' },
  { value: 'Site Visit Done', label: 'Site Visit Done', color: '#f97316' },
  { value: 'Negotiation', label: 'Negotiation', color: '#ec4899' },
  { value: 'Converted', label: 'Converted', color: '#22c55e' },
  { value: 'Junk', label: 'Junk', color: '#a1a1aa' },
  { value: 'Lost', label: 'Lost', color: '#ef4444' },
] as const;

export const LEAD_SOURCES = [
  { value: 'Website', label: 'Website', color: '#3b82f6' },
  { value: 'Facebook Lead Ad', label: 'Facebook Lead Ad', color: '#1877f2' },
  { value: 'Instagram', label: 'Instagram', color: '#e1306c' },
  { value: 'Google Ads', label: 'Google Ads', color: '#ea4335' },
  { value: '99acres', label: '99acres', color: '#c8102e' },
  { value: 'MagicBricks', label: 'MagicBricks', color: '#d5182f' },
  { value: 'Housing.com', label: 'Housing.com', color: '#00a5ec' },
  { value: 'NoBroker', label: 'NoBroker', color: '#d62d20' },
  { value: 'Walk-in', label: 'Walk-in', color: '#10b981' },
  { value: 'Referral', label: 'Referral', color: '#8b5cf6' },
  { value: 'Channel Partner', label: 'Channel Partner', color: '#f59e0b' },
  { value: 'Cold Call', label: 'Cold Call', color: '#64748b' },
  { value: 'Exhibition', label: 'Exhibition / Expo', color: '#14b8a6' },
  { value: 'WhatsApp', label: 'WhatsApp', color: '#25d366' },
  { value: 'Newspaper', label: 'Newspaper', color: '#78716c' },
  { value: 'Hoarding', label: 'Hoarding / OOH', color: '#a855f7' },
] as const;

export const DEAL_STAGES = [
  { value: 'Enquiry', label: 'Enquiry', color: '#64748b', probability: 10 },
  { value: 'Site Visit', label: 'Site Visit', color: '#0ea5e9', probability: 25 },
  { value: 'Revisit', label: 'Revisit', color: '#6366f1', probability: 40 },
  { value: 'Negotiation', label: 'Negotiation', color: '#f59e0b', probability: 60 },
  { value: 'Token Received', label: 'Token Received', color: '#f97316', probability: 80 },
  { value: 'Agreement', label: 'Agreement', color: '#a855f7', probability: 90 },
  { value: 'Booked', label: 'Booked / Won', color: '#22c55e', probability: 100 },
  { value: 'Lost', label: 'Lost', color: '#ef4444', probability: 0 },
] as const;

export const PROPERTY_STATUSES = [
  { value: 'Available', label: 'Available', color: '#22c55e' },
  { value: 'Held', label: 'Temporarily Held', color: '#f59e0b' },
  { value: 'Blocked', label: 'Blocked', color: '#f97316' },
  { value: 'Booked', label: 'Booked', color: '#3b82f6' },
  { value: 'Agreement Done', label: 'Agreement Done', color: '#8b5cf6' },
  { value: 'Registered', label: 'Registered', color: '#14b8a6' },
  { value: 'Sold', label: 'Sold', color: '#64748b' },
  { value: 'Not For Sale', label: 'Not For Sale', color: '#a1a1aa' },
] as const;

export const PROPERTY_TYPES = [
  'Apartment', 'Villa', 'Row House', 'Penthouse', 'Studio', 'Duplex',
  'Plot', 'Farmhouse', 'Independent House', 'Builder Floor',
  'Office Space', 'Retail Shop', 'Showroom', 'Warehouse', 'Industrial Land', 'Co-working',
] as const;

export const CONFIGURATIONS = [
  '1 RK', '1 BHK', '1.5 BHK', '2 BHK', '2.5 BHK', '3 BHK', '3.5 BHK',
  '4 BHK', '4+ BHK', '5 BHK', 'Duplex', 'Plot', 'Commercial',
] as const;

export const FACING_OPTIONS = [
  'North', 'South', 'East', 'West',
  'North-East', 'North-West', 'South-East', 'South-West',
] as const;

export const FURNISHING = ['Unfurnished', 'Semi Furnished', 'Fully Furnished'] as const;

export const POSSESSION_STATUS = [
  'Ready To Move', 'Under Construction', 'New Launch', 'Pre Launch', 'Resale',
] as const;

export const PROJECT_STATUS = [
  { value: 'Pre Launch', label: 'Pre Launch', color: '#a855f7' },
  { value: 'New Launch', label: 'New Launch', color: '#3b82f6' },
  { value: 'Under Construction', label: 'Under Construction', color: '#f59e0b' },
  { value: 'Nearing Possession', label: 'Nearing Possession', color: '#f97316' },
  { value: 'Ready To Move', label: 'Ready To Move', color: '#22c55e' },
  { value: 'Completed', label: 'Completed', color: '#14b8a6' },
  { value: 'On Hold', label: 'On Hold', color: '#ef4444' },
] as const;

export const PURPOSE = ['Buy', 'Rent', 'Lease', 'Investment', 'Sell'] as const;

export const BUDGET_BANDS = [
  'Under 25 L', '25 L - 50 L', '50 L - 75 L', '75 L - 1 Cr',
  '1 Cr - 1.5 Cr', '1.5 Cr - 2 Cr', '2 Cr - 3 Cr', '3 Cr - 5 Cr', 'Above 5 Cr',
] as const;

export const TIMELINE_OPTIONS = [
  'Immediate', 'Within 1 Month', '1-3 Months', '3-6 Months', '6-12 Months', 'Just Exploring',
] as const;

export const FUNDING_TYPE = ['Self Funded', 'Home Loan', 'Loan Pre-Approved', 'Partial Loan', 'Company Funded'] as const;

export const SITE_VISIT_STATUS = [
  { value: 'Scheduled', label: 'Scheduled', color: '#3b82f6' },
  { value: 'Confirmed', label: 'Confirmed', color: '#0ea5e9' },
  { value: 'In Progress', label: 'In Progress', color: '#f59e0b' },
  { value: 'Completed', label: 'Completed', color: '#22c55e' },
  { value: 'No Show', label: 'No Show', color: '#ef4444' },
  { value: 'Rescheduled', label: 'Rescheduled', color: '#a855f7' },
  { value: 'Cancelled', label: 'Cancelled', color: '#64748b' },
] as const;

export const BOOKING_STATUS = [
  { value: 'Token', label: 'Token Received', color: '#f59e0b' },
  { value: 'Booked', label: 'Booked', color: '#3b82f6' },
  { value: 'Agreement Signed', label: 'Agreement Signed', color: '#8b5cf6' },
  { value: 'Registered', label: 'Registered', color: '#22c55e' },
  { value: 'Possession Given', label: 'Possession Given', color: '#14b8a6' },
  { value: 'Cancelled', label: 'Cancelled', color: '#ef4444' },
] as const;

export const PAYMENT_STATUS = [
  { value: 'Pending', label: 'Pending', color: '#94a3b8' },
  { value: 'Due', label: 'Due', color: '#f59e0b' },
  { value: 'Overdue', label: 'Overdue', color: '#ef4444' },
  { value: 'Partially Paid', label: 'Partially Paid', color: '#f97316' },
  { value: 'Paid', label: 'Paid', color: '#22c55e' },
  { value: 'Waived', label: 'Waived', color: '#64748b' },
] as const;

export const PAYMENT_MODES = [
  'Cheque', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'Cash', 'Demand Draft', 'Home Loan Disbursement', 'Credit Card',
] as const;

export const AMENITIES = [
  'Swimming Pool', 'Gymnasium', 'Clubhouse', 'Children Play Area', 'Landscaped Garden',
  'Jogging Track', 'Indoor Games', 'Multipurpose Hall', 'Amphitheatre', 'Yoga Deck',
  'Power Backup', 'Lift', 'Covered Parking', 'Visitor Parking', '24x7 Security',
  'CCTV Surveillance', 'Intercom', 'Fire Safety', 'Rainwater Harvesting', 'Sewage Treatment Plant',
  'Solar Panels', 'EV Charging', 'Concierge', 'Cafeteria', 'Business Centre',
  'Senior Citizen Deck', 'Pet Park', 'Sports Court', 'Library', 'Spa',
] as const;

export const ACTIVITY_TYPES = [
  { value: 'Call', label: 'Call', color: '#3b82f6' },
  { value: 'Meeting', label: 'Meeting', color: '#8b5cf6' },
  { value: 'Site Visit', label: 'Site Visit', color: '#f59e0b' },
  { value: 'Follow Up', label: 'Follow Up', color: '#0ea5e9' },
  { value: 'Email', label: 'Email', color: '#14b8a6' },
  { value: 'WhatsApp', label: 'WhatsApp', color: '#25d366' },
  { value: 'Task', label: 'Task', color: '#64748b' },
  { value: 'Documentation', label: 'Documentation', color: '#a855f7' },
] as const;

export const CALL_DISPOSITIONS = [
  'Interested', 'Not Interested', 'Call Back Later', 'Site Visit Scheduled',
  'Budget Mismatch', 'Location Mismatch', 'Already Purchased', 'Wrong Number',
  'Not Reachable', 'Switched Off', 'Busy', 'Language Barrier', 'Do Not Call',
] as const;

export const CHANNEL_PARTNER_TYPES = [
  'Individual Broker', 'Brokerage Firm', 'Referral Partner', 'Digital Marketer', 'Corporate Tie-up', 'NRI Desk',
] as const;

export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Puducherry',
  'Chandigarh', 'Andaman and Nicobar Islands', 'Dadra and Nagar Haveli and Daman and Diu', 'Lakshadweep',
] as const;

/** Capability keys used by the profile permission system. */
export const CAPABILITIES = [
  'admin.access',
  'admin.modules',
  'admin.fields',
  'admin.layouts',
  'admin.picklists',
  'admin.users',
  'admin.roles',
  'admin.profiles',
  'admin.sharing',
  'admin.workflows',
  'admin.integrations',
  'admin.templates',
  'admin.numbering',
  'admin.audit',
  'records.export',
  'records.import',
  'records.mass_delete',
  'records.mass_edit',
  'records.transfer_ownership',
  'records.view_all',
  'dashboards.share',
  'ai.use',
  'ai.configure',
  'telephony.call',
  'telephony.listen_recordings',
  'whatsapp.send',
  'whatsapp.templates',
  'inventory.block_unit',
  'inventory.change_price',
  'bookings.approve_discount',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const DEFAULT_CURRENCY = 'INR';

/** Indian numbering helpers — lakhs and crores are the working unit here. */
export const LAKH = 100_000;
export const CRORE = 10_000_000;
