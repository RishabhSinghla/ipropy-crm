-- Dropdowns read in alphabetical order, unless the order is the meaning.
--
-- The owner's words: "the whole dropdown isn't very properly arranged like it
-- should be arranged alphabetical order. I'm talking about whole of CRM,
-- wherever dropdown are being used."
--
-- He is right about nearly all of them. A picklist's values come out in the
-- sequence they were seeded or added in, which for Locality means a hundred
-- and thirty entries in the order somebody happened to think of them — there
-- is no way to find one except to read the whole list. Alphabetical is the
-- only order a reader can navigate without being told what it is.
--
-- The exception is the lists where the sequence *is* information: New →
-- Contacted → Qualified → Negotiation is a pipeline, ₹25 L–₹50 L → ₹50 L–₹1 Cr
-- is a scale, Hot → Warm → Cold is a ranking. Sorting those alphabetically
-- would put "Booked" before "Available" on the board and read as damage.
--
-- So it is a property of the list, set here and editable afterwards in
-- Admin → Dropdowns, and the registry sorts on the way out — which means every
-- dropdown in the CRM follows it at once: forms, inline editors, filters,
-- list views, the kanban, imports and exports.

ALTER TABLE ipy_picklist ADD COLUMN IF NOT EXISTS is_ordered BOOLEAN NOT NULL DEFAULT false;

/*
  A sort key that reads numbers as numbers.

  Plain alphabetical puts "Sector 10" between "Sector 1" and "Sector 2", and
  "10 BHK" before "2 BHK" — which is the sort being wrong in exactly the way
  people notice, and this is Faridabad, where most of the localities are a
  word and a number. Every run of digits is left-padded to a fixed width so
  the text comparison orders them the way a reader would.
*/
CREATE OR REPLACE FUNCTION ipy_natural_key(t text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE out text := ''; part text;
BEGIN
  FOR part IN SELECT (regexp_matches(lower(t), '(\d+|\D+)', 'g'))[1] LOOP
    IF part ~ '^\d+$' THEN out := out || lpad(part, 12, '0');
    ELSE out := out || part; END IF;
  END LOOP;
  RETURN out;
END $$;

COMMENT ON COLUMN ipy_picklist.is_ordered IS
  'true when the values are a progression or a scale and must keep the sequence an admin arranged; false sorts them A–Z everywhere.';

UPDATE ipy_picklist SET is_ordered = true
 WHERE name IN (
   -- Pipelines and progressions.
   'lead_status', 'deal_stage', 'property_status', 'possession_status',
   'project_status', 'site_visit_status', 'booking_status', 'payment_status',
   'loan_status', 'activity_status', 'partner_status', 'commission_status',
   'kyc_status',
   -- Scales and rankings.
   'budget_band', 'purchase_timeline', 'interest_level', 'priority', 'rating',
   'partner_tier',
   -- Unit qualifiers, where the first value is the sensible default and the
   -- list is three entries long — alphabetising them helps nobody.
   'area_unit', 'price_unit'
 );
