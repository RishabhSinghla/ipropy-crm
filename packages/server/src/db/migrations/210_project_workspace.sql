-- A purpose-built Project workspace. Project-only lists, hierarchy, plans,
-- accommodation, inventory links and share links live here rather than in
-- Leads/Associates/Inventory picklists, layouts, quick filters or tag setup.

CREATE TABLE IF NOT EXISTS ipy_project_master_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_key TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (master_key, value)
);
CREATE INDEX IF NOT EXISTS idx_project_master_values_order
  ON ipy_project_master_values (master_key, is_active, sort_order, label);

CREATE TABLE IF NOT EXISTS ipy_project_profiles (
  project_id UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  project_code TEXT,
  developer TEXT,
  category TEXT,
  project_type TEXT,
  rera_number TEXT,
  rera_expiry DATE,
  state TEXT,
  city TEXT,
  sector TEXT,
  locality TEXT,
  address TEXT,
  pincode TEXT,
  landmark TEXT,
  google_maps_url TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  project_status TEXT,
  launch_date DATE,
  possession_date DATE,
  construction_progress NUMERIC(5,2),
  total_land_area NUMERIC(14,2),
  area_unit TEXT NOT NULL DEFAULT 'sqft',
  tower_count INTEGER,
  block_count INTEGER,
  floor_count INTEGER,
  unit_count INTEGER,
  starting_price NUMERIC(16,2),
  maximum_price NUMERIC(16,2),
  booking_amount NUMERIC(16,2),
  payment_plans JSONB NOT NULL DEFAULT '[]'::jsonb,
  approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
  amenities JSONB NOT NULL DEFAULT '[]'::jsonb,
  highlights TEXT,
  description TEXT,
  assigned_agent_id UUID,
  project_manager_id UUID,
  lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft','published','archived')),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_profiles_status_location
  ON ipy_project_profiles (project_status, city, locality);
CREATE INDEX IF NOT EXISTS idx_project_profiles_developer
  ON ipy_project_profiles (developer);
CREATE TABLE IF NOT EXISTS ipy_project_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  user_id UUID,
  action TEXT NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_audit_record_time
  ON ipy_project_audit (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ipy_project_accommodations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  configuration TEXT NOT NULL,
  bedrooms NUMERIC(4,1),
  bathrooms INTEGER,
  balconies INTEGER,
  kitchens INTEGER,
  study_rooms INTEGER,
  servant_rooms INTEGER,
  parking_spaces INTEGER,
  facing TEXT,
  furnishing TEXT,
  floor_preference TEXT,
  carpet_area NUMERIC(14,2),
  built_up_area NUMERIC(14,2),
  super_built_up_area NUMERIC(14,2),
  plot_area NUMERIC(14,2),
  area_unit TEXT NOT NULL DEFAULT 'sqft',
  price_min NUMERIC(16,2),
  price_max NUMERIC(16,2),
  linked_floor_plan_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, configuration, area_unit, carpet_area, built_up_area, super_built_up_area, plot_area)
);
CREATE INDEX IF NOT EXISTS idx_project_accommodation_project
  ON ipy_project_accommodations (project_id, configuration);

CREATE TABLE IF NOT EXISTS ipy_project_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES ipy_project_nodes(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (node_type IN ('phase','tower','block','floor','unit','plot')),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  availability TEXT CHECK (availability IS NULL OR availability IN ('available','reserved','booked','sold','not_for_sale')),
  price NUMERIC(16,2),
  area NUMERIC(14,2),
  area_unit TEXT,
  inventory_record_id UUID REFERENCES ipy_e_properties(record_id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_nodes_tree
  ON ipy_project_nodes (project_id, parent_id, node_type, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_nodes_inventory
  ON ipy_project_nodes (inventory_record_id) WHERE inventory_record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ipy_project_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('layout_plan','floor_plan','cluster_plan','elevation','gallery','video','document','brochure','virtual_tour')),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  mime_type TEXT,
  caption TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_assets_project
  ON ipy_project_assets (project_id, category, sort_order);

CREATE TABLE IF NOT EXISTS ipy_project_hotspots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES ipy_project_assets(id) ON DELETE CASCADE,
  node_id UUID REFERENCES ipy_project_nodes(id) ON DELETE SET NULL,
  x NUMERIC(8,6) NOT NULL CHECK (x >= 0 AND x <= 1),
  y NUMERIC(8,6) NOT NULL CHECK (y >= 0 AND y <= 1),
  width NUMERIC(8,6) NOT NULL CHECK (width > 0 AND width <= 1),
  height NUMERIC(8,6) NOT NULL CHECK (height > 0 AND height <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_hotspots_asset ON ipy_project_hotspots (asset_id);

-- Explicit link table keeps project stock in sync with permanent Inventory IDs;
-- it prevents duplicate unit copies and makes availability changes observable.
CREATE TABLE IF NOT EXISTS ipy_project_inventory_links (
  project_id UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  inventory_record_id UUID NOT NULL REFERENCES ipy_e_properties(record_id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, inventory_record_id),
  UNIQUE (inventory_record_id)
);

CREATE TABLE IF NOT EXISTS ipy_project_share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  recipient TEXT,
  hide_prices BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ipy_project_share_items (
  share_id UUID NOT NULL REFERENCES ipy_project_share_links(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, project_id)
);
CREATE TABLE IF NOT EXISTS ipy_project_share_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL REFERENCES ipy_project_share_links(id) ON DELETE CASCADE,
  project_id UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('open','project_view','enquiry','site_visit_request')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_project_share_events_time
  ON ipy_project_share_events (share_id, created_at DESC);

-- Seed only project-owned dropdown values. Admins may edit these without
-- changing any global picklist used by other CRM modules.
INSERT INTO ipy_project_master_values (master_key, value, label, sort_order) VALUES
  ('category','residential','Residential',10),
  ('category','commercial','Commercial',20),
  ('category','mixed_use','Mixed Use',30),
  ('category','plotted','Plotted Development',40),
  ('project_status','upcoming','Upcoming',10),
  ('project_status','pre_launch','Pre-Launch',20),
  ('project_status','under_construction','Under Construction',30),
  ('project_status','ready_to_move','Ready to Move',40),
  ('project_status','completed','Completed',50),
  ('project_status','sold_out','Sold Out',60),
  ('project_type','builder_floors','Builder Floors',10),
  ('project_type','apartments','Apartments',20),
  ('project_type','villas','Villas',30),
  ('project_type','independent_houses','Independent Houses',40),
  ('project_type','plots','Plots',50),
  ('project_type','shops','Shops',60),
  ('project_type','offices','Offices',70),
  ('area_unit','sqft','Sq. Ft.',10),
  ('area_unit','sqyd','Sq. Yds.',20),
  ('area_unit','sqm','Sq. Mtr.',30),
  ('area_unit','acre','Acres',40),
  ('area_unit','bigha','Bigha',50),
  ('area_unit','marla','Marla',60),
  ('area_unit','kanal','Kanal',70),
  ('area_unit','hectare','Hectares',80)
ON CONFLICT (master_key, value) DO NOTHING;
