-- ===========================================================================
-- iPropy CRM — 002 entities: real-estate payload tables
--
-- Every table follows the same contract:
--   record_id      → PK, FK to ipy_record (ownership, audit, soft delete)
--   custom_fields  → JSONB bag for admin-created fields (no DDL at runtime)
-- Hot, queried-often fields get real columns with real indexes; everything an
-- admin adds later lands in custom_fields. The metadata engine resolves which
-- is which via ipy_field.storage.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Organizations (builders, corporates, institutional buyers)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_organizations (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  org_number          TEXT,
  name                TEXT NOT NULL,
  org_type            TEXT,               -- Developer / Corporate / Investor / Vendor
  industry            TEXT,
  website             TEXT,
  phone               TEXT,
  email               TEXT,
  gstin               TEXT,
  pan                 TEXT,
  cin                 TEXT,
  rera_registration   TEXT,
  employees           INT,
  annual_revenue      NUMERIC(18,2),
  billing_address     JSONB NOT NULL DEFAULT '{}'::jsonb,
  shipping_address    JSONB NOT NULL DEFAULT '{}'::jsonb,
  description         TEXT,
  logo_url            TEXT,
  rating              TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_org_name ON ipy_e_organizations USING GIN(name gin_trgm_ops);
CREATE INDEX idx_org_phone ON ipy_e_organizations(phone);
CREATE INDEX idx_org_cf ON ipy_e_organizations USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Contacts (buyers, tenants, owners, brokers-as-people)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_contacts (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  contact_number      TEXT,
  salutation          TEXT,
  first_name          TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  email               TEXT,
  secondary_email     TEXT,
  mobile              TEXT,
  phone               TEXT,
  whatsapp_number     TEXT,
  organization_id     UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  designation         TEXT,
  contact_type        TEXT,              -- Buyer / Seller / Tenant / Investor / Broker
  lead_source         TEXT,
  date_of_birth       DATE,
  anniversary         DATE,
  gender              TEXT,
  occupation          TEXT,
  company_name        TEXT,
  annual_income       NUMERIC(18,2),
  nationality         TEXT,
  is_nri              BOOLEAN NOT NULL DEFAULT false,
  preferred_language  TEXT,
  preferred_contact   TEXT,              -- Call / WhatsApp / Email
  do_not_call         BOOLEAN NOT NULL DEFAULT false,
  do_not_whatsapp     BOOLEAN NOT NULL DEFAULT false,
  email_opt_out       BOOLEAN NOT NULL DEFAULT false,
  mailing_address     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- buyer requirement profile, powers AI property matching
  requirement         JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget_min          NUMERIC(18,2),
  budget_max          NUMERIC(18,2),
  preferred_locations JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_config    JSONB NOT NULL DEFAULT '[]'::jsonb,
  purpose             TEXT,
  funding_type        TEXT,
  purchase_timeline   TEXT,
  -- KYC
  pan                 TEXT,
  aadhaar_masked      TEXT,
  passport_number     TEXT,
  kyc_status          TEXT,
  -- engagement
  engagement_score    INT NOT NULL DEFAULT 0,
  lifetime_value      NUMERIC(18,2) NOT NULL DEFAULT 0,
  portrait_url        TEXT,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_contact_name ON ipy_e_contacts USING GIN((first_name || ' ' || last_name) gin_trgm_ops);
CREATE INDEX idx_contact_mobile ON ipy_e_contacts(mobile);
CREATE INDEX idx_contact_whatsapp ON ipy_e_contacts(whatsapp_number);
CREATE INDEX idx_contact_email ON ipy_e_contacts(lower(email));
CREATE INDEX idx_contact_org ON ipy_e_contacts(organization_id);
CREATE INDEX idx_contact_cf ON ipy_e_contacts USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Leads (unqualified enquiries)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_leads (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  lead_number         TEXT,
  salutation          TEXT,
  first_name          TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  email               TEXT,
  mobile              TEXT,
  alternate_phone     TEXT,
  whatsapp_number     TEXT,
  company             TEXT,
  designation         TEXT,
  status              TEXT NOT NULL DEFAULT 'New',
  lead_source         TEXT,
  sub_source          TEXT,
  campaign_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  channel_partner_id  UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  referred_by         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  -- requirement
  interested_project_id UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  property_type       TEXT,
  configuration       JSONB NOT NULL DEFAULT '[]'::jsonb,
  purpose             TEXT,
  budget_min          NUMERIC(18,2),
  budget_max          NUMERIC(18,2),
  budget_band         TEXT,
  preferred_locations JSONB NOT NULL DEFAULT '[]'::jsonb,
  carpet_area_min     NUMERIC(12,2),
  carpet_area_max     NUMERIC(12,2),
  possession_timeline TEXT,
  funding_type        TEXT,
  loan_required       BOOLEAN NOT NULL DEFAULT false,
  -- qualification / scoring
  rating              TEXT,               -- Hot / Warm / Cold
  ai_score            INT,
  ai_grade            TEXT,
  ai_score_reasons    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_scored_at        TIMESTAMPTZ,
  qualification_notes TEXT,
  -- follow up
  next_followup_at    TIMESTAMPTZ,
  last_contacted_at   TIMESTAMPTZ,
  contact_attempts    INT NOT NULL DEFAULT 0,
  first_response_secs INT,
  -- conversion
  is_converted        BOOLEAN NOT NULL DEFAULT false,
  converted_at        TIMESTAMPTZ,
  converted_contact_id UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  converted_deal_id   UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  converted_org_id    UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  lost_reason         TEXT,
  junk_reason         TEXT,
  -- attribution
  utm_source          TEXT,
  utm_medium          TEXT,
  utm_campaign        TEXT,
  utm_term            TEXT,
  utm_content         TEXT,
  landing_page        TEXT,
  gclid               TEXT,
  fbclid              TEXT,
  ip_address          TEXT,
  address             JSONB NOT NULL DEFAULT '{}'::jsonb,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_lead_status ON ipy_e_leads(status);
CREATE INDEX idx_lead_mobile ON ipy_e_leads(mobile);
CREATE INDEX idx_lead_email ON ipy_e_leads(lower(email));
CREATE INDEX idx_lead_source ON ipy_e_leads(lead_source);
CREATE INDEX idx_lead_followup ON ipy_e_leads(next_followup_at) WHERE is_converted = false;
CREATE INDEX idx_lead_score ON ipy_e_leads(ai_score DESC NULLS LAST);
CREATE INDEX idx_lead_project ON ipy_e_leads(interested_project_id);
CREATE INDEX idx_lead_cf ON ipy_e_leads USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Projects (a development: towers, phases, amenities)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_projects (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  project_code        TEXT,
  name                TEXT NOT NULL,
  developer_id        UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'New Launch',
  project_type        TEXT,               -- Residential / Commercial / Mixed / Plotted
  -- location
  city                TEXT,
  locality            TEXT,
  micro_market        TEXT,
  state               TEXT,
  country             TEXT DEFAULT 'India',
  pincode             TEXT,
  address             JSONB NOT NULL DEFAULT '{}'::jsonb,
  latitude            NUMERIC(10,7),
  longitude           NUMERIC(10,7),
  -- compliance
  rera_number         TEXT,
  rera_expiry         DATE,
  approvals           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- scale
  total_land_area     NUMERIC(12,2),
  land_area_unit      TEXT DEFAULT 'acre',
  total_towers        INT,
  total_floors        INT,
  total_units         INT,
  available_units     INT NOT NULL DEFAULT 0,
  booked_units        INT NOT NULL DEFAULT 0,
  open_area_percent   NUMERIC(5,2),
  -- commercials
  price_min           NUMERIC(18,2),
  price_max           NUMERIC(18,2),
  rate_per_sqft       NUMERIC(12,2),
  configurations      JSONB NOT NULL DEFAULT '[]'::jsonb,
  amenities           JSONB NOT NULL DEFAULT '[]'::jsonb,
  usps                JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- timeline
  launch_date         DATE,
  possession_date     DATE,
  completion_percent  NUMERIC(5,2),
  -- marketing
  brochure_url        TEXT,
  video_url           TEXT,
  virtual_tour_url    TEXT,
  gallery             JSONB NOT NULL DEFAULT '[]'::jsonb,
  master_plan_url     TEXT,
  floor_plans         JSONB NOT NULL DEFAULT '[]'::jsonb,
  connectivity        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- commissions
  broker_commission_pct NUMERIC(5,2),
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_project_name ON ipy_e_projects USING GIN(name gin_trgm_ops);
CREATE INDEX idx_project_status ON ipy_e_projects(status);
CREATE INDEX idx_project_city ON ipy_e_projects(city, locality);
CREATE INDEX idx_project_developer ON ipy_e_projects(developer_id);
CREATE INDEX idx_project_price ON ipy_e_projects(price_min, price_max);
CREATE INDEX idx_project_cf ON ipy_e_projects USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Properties / Units (sellable inventory)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_properties (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  property_code       TEXT,
  name                TEXT NOT NULL,
  project_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'Available',
  property_type       TEXT,
  configuration       TEXT,
  -- physical position
  tower               TEXT,
  wing                TEXT,
  floor               INT,
  unit_number         TEXT,
  facing              TEXT,
  view_description    TEXT,
  corner_unit         BOOLEAN NOT NULL DEFAULT false,
  vastu_compliant     BOOLEAN,
  -- areas
  carpet_area         NUMERIC(12,2),
  built_up_area       NUMERIC(12,2),
  super_built_up_area NUMERIC(12,2),
  plot_area           NUMERIC(12,2),
  balcony_area        NUMERIC(12,2),
  terrace_area        NUMERIC(12,2),
  area_unit           TEXT NOT NULL DEFAULT 'sqft',
  -- rooms
  bedrooms            INT,
  bathrooms           INT,
  balconies           INT,
  parking_slots       INT,
  furnishing          TEXT,
  -- pricing
  base_price          NUMERIC(18,2),
  rate_per_sqft       NUMERIC(12,2),
  floor_rise_charge   NUMERIC(18,2),
  plc_charge          NUMERIC(18,2),      -- preferred location charge
  parking_charge      NUMERIC(18,2),
  club_membership     NUMERIC(18,2),
  maintenance_deposit NUMERIC(18,2),
  other_charges       NUMERIC(18,2),
  gst_percent         NUMERIC(5,2),
  stamp_duty_percent  NUMERIC(5,2),
  registration_charge NUMERIC(18,2),
  total_price         NUMERIC(18,2),
  -- rental (for lease inventory)
  monthly_rent        NUMERIC(18,2),
  security_deposit    NUMERIC(18,2),
  maintenance_monthly NUMERIC(18,2),
  -- availability
  possession_status   TEXT,
  possession_date     DATE,
  blocked_until       TIMESTAMPTZ,
  blocked_by          UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  blocked_for_lead_id UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  -- resale / owner details
  owner_contact_id    UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  is_resale           BOOLEAN NOT NULL DEFAULT false,
  age_of_property     INT,
  -- media
  gallery             JSONB NOT NULL DEFAULT '[]'::jsonb,
  floor_plan_url      TEXT,
  video_url           TEXT,
  virtual_tour_url    TEXT,
  amenities           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- location snapshot (denormalised from project for fast filtering)
  city                TEXT,
  locality            TEXT,
  latitude            NUMERIC(10,7),
  longitude           NUMERIC(10,7),
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_prop_project ON ipy_e_properties(project_id);
CREATE INDEX idx_prop_status ON ipy_e_properties(status);
CREATE INDEX idx_prop_config ON ipy_e_properties(configuration);
CREATE INDEX idx_prop_price ON ipy_e_properties(total_price);
CREATE INDEX idx_prop_area ON ipy_e_properties(carpet_area);
CREATE INDEX idx_prop_city ON ipy_e_properties(city, locality);
CREATE INDEX idx_prop_available ON ipy_e_properties(status, total_price) WHERE status = 'Available';
CREATE INDEX idx_prop_cf ON ipy_e_properties USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Deals (sales pipeline)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_deals (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  deal_number         TEXT,
  name                TEXT NOT NULL,
  contact_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  organization_id     UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  project_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  property_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  source_lead_id      UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  channel_partner_id  UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  campaign_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  stage               TEXT NOT NULL DEFAULT 'Enquiry',
  probability         INT NOT NULL DEFAULT 10,
  amount              NUMERIC(18,2),
  discount_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_percent    NUMERIC(5,2) NOT NULL DEFAULT 0,
  negotiated_price    NUMERIC(18,2),
  expected_close_date DATE,
  actual_close_date   DATE,
  lead_source         TEXT,
  -- pipeline analytics
  stage_changed_at    TIMESTAMPTZ,
  days_in_stage       INT NOT NULL DEFAULT 0,
  -- AI
  ai_risk_score       INT,
  ai_risk_reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_next_action      TEXT,
  ai_forecast_close   DATE,
  ai_analysed_at      TIMESTAMPTZ,
  -- outcome
  is_won              BOOLEAN NOT NULL DEFAULT false,
  is_lost             BOOLEAN NOT NULL DEFAULT false,
  lost_reason         TEXT,
  lost_to_competitor  TEXT,
  next_followup_at    TIMESTAMPTZ,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_deal_stage ON ipy_e_deals(stage);
CREATE INDEX idx_deal_contact ON ipy_e_deals(contact_id);
CREATE INDEX idx_deal_project ON ipy_e_deals(project_id);
CREATE INDEX idx_deal_property ON ipy_e_deals(property_id);
CREATE INDEX idx_deal_close ON ipy_e_deals(expected_close_date);
CREATE INDEX idx_deal_open ON ipy_e_deals(stage, expected_close_date) WHERE is_won = false AND is_lost = false;
CREATE INDEX idx_deal_cf ON ipy_e_deals USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Site visits
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_site_visits (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  visit_number        TEXT,
  subject             TEXT NOT NULL,
  lead_id             UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  contact_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  deal_id             UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  project_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  property_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  channel_partner_id  UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'Scheduled',
  visit_type          TEXT,               -- First Visit / Revisit / Virtual
  scheduled_at        TIMESTAMPTZ NOT NULL,
  duration_minutes    INT NOT NULL DEFAULT 60,
  actual_start        TIMESTAMPTZ,
  actual_end          TIMESTAMPTZ,
  accompanied_by      UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  pickup_required     BOOLEAN NOT NULL DEFAULT false,
  pickup_address      TEXT,
  attendees_count     INT NOT NULL DEFAULT 1,
  units_shown         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- outcome
  feedback            TEXT,
  interest_level      TEXT,               -- Very High / High / Medium / Low
  objections          JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_step           TEXT,
  rating              INT,
  -- AI
  ai_summary          TEXT,
  ai_sentiment        TEXT,
  -- logistics
  reminder_sent       BOOLEAN NOT NULL DEFAULT false,
  confirmation_sent   BOOLEAN NOT NULL DEFAULT false,
  checkin_latitude    NUMERIC(10,7),
  checkin_longitude   NUMERIC(10,7),
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_sv_scheduled ON ipy_e_site_visits(scheduled_at);
CREATE INDEX idx_sv_status ON ipy_e_site_visits(status);
CREATE INDEX idx_sv_lead ON ipy_e_site_visits(lead_id);
CREATE INDEX idx_sv_project ON ipy_e_site_visits(project_id);
CREATE INDEX idx_sv_cf ON ipy_e_site_visits USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Bookings (a won deal becomes a booking with a payment plan)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_bookings (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  booking_number      TEXT,
  deal_id             UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  contact_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  co_applicant_id     UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  project_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  property_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  channel_partner_id  UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'Token',
  booking_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  -- money
  agreement_value     NUMERIC(18,2),
  total_consideration NUMERIC(18,2),
  token_amount        NUMERIC(18,2),
  booking_amount      NUMERIC(18,2),
  amount_received     NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_due          NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  gst_amount          NUMERIC(18,2),
  stamp_duty          NUMERIC(18,2),
  registration_fee    NUMERIC(18,2),
  -- payment plan
  payment_plan        TEXT,               -- CLP / Down Payment / Flexi / Subvention
  payment_schedule    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- loan
  loan_required       BOOLEAN NOT NULL DEFAULT false,
  loan_bank           TEXT,
  loan_amount         NUMERIC(18,2),
  loan_status         TEXT,
  loan_sanctioned_at  DATE,
  -- documents / legal
  agreement_date      DATE,
  registration_date   DATE,
  possession_date     DATE,
  kyc_complete        BOOLEAN NOT NULL DEFAULT false,
  documents_pending   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- commission
  broker_commission   NUMERIC(18,2),
  commission_status   TEXT,
  cancellation_reason TEXT,
  cancelled_at        TIMESTAMPTZ,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_booking_status ON ipy_e_bookings(status);
CREATE INDEX idx_booking_contact ON ipy_e_bookings(contact_id);
CREATE INDEX idx_booking_property ON ipy_e_bookings(property_id);
CREATE INDEX idx_booking_date ON ipy_e_bookings(booking_date DESC);
CREATE INDEX idx_booking_cf ON ipy_e_bookings USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Payments (installments against a booking)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_payments (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  payment_number      TEXT,
  booking_id          UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  contact_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  project_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  milestone           TEXT,               -- "On Booking", "On Foundation", ...
  installment_no      INT,
  status              TEXT NOT NULL DEFAULT 'Pending',
  due_date            DATE,
  amount_due          NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_paid         NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_on             DATE,
  payment_mode        TEXT,
  reference_number    TEXT,
  bank_name           TEXT,
  cheque_number       TEXT,
  cheque_date         DATE,
  receipt_number      TEXT,
  late_fee            NUMERIC(18,2) NOT NULL DEFAULT 0,
  tds_amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
  gst_amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
  reminder_count      INT NOT NULL DEFAULT 0,
  last_reminder_at    TIMESTAMPTZ,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_payment_booking ON ipy_e_payments(booking_id);
CREATE INDEX idx_payment_status ON ipy_e_payments(status);
CREATE INDEX idx_payment_due ON ipy_e_payments(due_date) WHERE status IN ('Pending','Due','Overdue');
CREATE INDEX idx_payment_cf ON ipy_e_payments USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Channel partners (brokers)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_channel_partners (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  partner_number      TEXT,
  name                TEXT NOT NULL,
  partner_type        TEXT,
  firm_name           TEXT,
  contact_person      TEXT,
  mobile              TEXT,
  email               TEXT,
  whatsapp_number     TEXT,
  city                TEXT,
  address             JSONB NOT NULL DEFAULT '{}'::jsonb,
  rera_number         TEXT,
  gstin               TEXT,
  pan                 TEXT,
  -- agreement
  status              TEXT NOT NULL DEFAULT 'Active',
  onboarded_on        DATE,
  agreement_expiry    DATE,
  commission_percent  NUMERIC(5,2),
  commission_slab     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- performance (rollups maintained by the engine)
  leads_submitted     INT NOT NULL DEFAULT 0,
  site_visits_done    INT NOT NULL DEFAULT 0,
  bookings_closed     INT NOT NULL DEFAULT 0,
  total_sales_value   NUMERIC(18,2) NOT NULL DEFAULT 0,
  commission_earned   NUMERIC(18,2) NOT NULL DEFAULT 0,
  commission_paid     NUMERIC(18,2) NOT NULL DEFAULT 0,
  conversion_rate     NUMERIC(5,2) NOT NULL DEFAULT 0,
  tier                TEXT,               -- Platinum / Gold / Silver
  rating              INT,
  bank_details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_projects   JSONB NOT NULL DEFAULT '[]'::jsonb,
  portal_access       BOOLEAN NOT NULL DEFAULT false,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_cp_status ON ipy_e_channel_partners(status);
CREATE INDEX idx_cp_mobile ON ipy_e_channel_partners(mobile);
CREATE INDEX idx_cp_cf ON ipy_e_channel_partners USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_campaigns (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  campaign_number     TEXT,
  name                TEXT NOT NULL,
  campaign_type       TEXT,               -- Digital / Print / Event / Referral / Email / WhatsApp
  channel             TEXT,
  status              TEXT NOT NULL DEFAULT 'Planning',
  project_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  start_date          DATE,
  end_date            DATE,
  budget              NUMERIC(18,2),
  actual_cost         NUMERIC(18,2) NOT NULL DEFAULT 0,
  target_audience     TEXT,
  -- performance
  impressions         BIGINT NOT NULL DEFAULT 0,
  clicks              BIGINT NOT NULL DEFAULT 0,
  leads_generated     INT NOT NULL DEFAULT 0,
  qualified_leads     INT NOT NULL DEFAULT 0,
  site_visits         INT NOT NULL DEFAULT 0,
  bookings            INT NOT NULL DEFAULT 0,
  revenue_generated   NUMERIC(18,2) NOT NULL DEFAULT 0,
  cost_per_lead       NUMERIC(18,2),
  roi_percent         NUMERIC(10,2),
  -- integration keys so inbound leads self-attribute
  external_id         TEXT,
  utm_campaign        TEXT,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_campaign_status ON ipy_e_campaigns(status);
CREATE INDEX idx_campaign_utm ON ipy_e_campaigns(utm_campaign);
CREATE INDEX idx_campaign_external ON ipy_e_campaigns(external_id);
CREATE INDEX idx_campaign_cf ON ipy_e_campaigns USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Activities (tasks, calls, meetings, follow-ups)
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_activities (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  activity_number     TEXT,
  subject             TEXT NOT NULL,
  activity_type       TEXT NOT NULL DEFAULT 'Task',
  status              TEXT NOT NULL DEFAULT 'Not Started',
  priority            TEXT NOT NULL DEFAULT 'Medium',
  -- polymorphic link to any record
  related_to          UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  related_module      TEXT,
  contact_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  start_at            TIMESTAMPTZ,
  end_at              TIMESTAMPTZ,
  due_date            DATE,
  all_day             BOOLEAN NOT NULL DEFAULT false,
  location            TEXT,
  is_recurring        BOOLEAN NOT NULL DEFAULT false,
  recurrence          JSONB,
  reminder_minutes    INT,
  reminder_sent       BOOLEAN NOT NULL DEFAULT false,
  completed_at        TIMESTAMPTZ,
  outcome             TEXT,
  participants        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- AI generated follow-ups get flagged so reps can see what the assistant added
  is_ai_generated     BOOLEAN NOT NULL DEFAULT false,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_activity_related ON ipy_e_activities(related_to);
CREATE INDEX idx_activity_start ON ipy_e_activities(start_at);
CREATE INDEX idx_activity_due ON ipy_e_activities(due_date) WHERE status <> 'Completed';
CREATE INDEX idx_activity_type ON ipy_e_activities(activity_type, status);
CREATE INDEX idx_activity_cf ON ipy_e_activities USING GIN(custom_fields);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
CREATE TABLE ipy_e_documents (
  record_id           UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  document_number     TEXT,
  title               TEXT NOT NULL,
  document_type       TEXT,               -- Brochure / Agreement / KYC / Receipt / Floor Plan
  category            TEXT,
  related_to          UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  related_module      TEXT,
  project_id          UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  file_name           TEXT,
  file_url            TEXT,
  storage_key         TEXT,
  mime_type           TEXT,
  file_size           BIGINT,
  version             TEXT DEFAULT '1.0',
  is_public           BOOLEAN NOT NULL DEFAULT false,
  -- share externally via a signed link
  share_token         TEXT,
  share_expires_at    TIMESTAMPTZ,
  download_count      INT NOT NULL DEFAULT 0,
  expiry_date         DATE,
  extracted_text      TEXT,
  ai_summary          TEXT,
  description         TEXT,
  custom_fields       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_doc_related ON ipy_e_documents(related_to);
CREATE INDEX idx_doc_type ON ipy_e_documents(document_type);
CREATE INDEX idx_doc_share ON ipy_e_documents(share_token);
CREATE INDEX idx_doc_cf ON ipy_e_documents USING GIN(custom_fields);
