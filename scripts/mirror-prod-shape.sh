#!/usr/bin/env bash
# Make the local database the same *shape* as production.
#
# `db-pull-prod.sh` is the real thing and copies the rows too, but it needs
# PROD_DATABASE_URL. This is the half that can be done without a credential:
# production's field set, its renames and its tombstones, applied to a local
# database that was seeded from the template.
#
# Why it exists: a fresh seed gives leads and properties ~60 fields each whose
# name and column are the same string. Production has 18 and 17, several
# renamed, and the rest permanently deleted (which drops the column). Every
# bug this project keeps rediscovering — 42703 on a deleted column, a mapping
# keyed on a name that moved — is invisible on the seeded shape and obvious on
# this one.
#
# The shape below is read from `.github/workflows/probe-prod-schema.yml`'s
# output, which is read-only and prints field *names* only. Re-run that probe
# and update these lists when production changes.
#
#   npm run db:seed && bash scripts/mirror-prod-shape.sh
set -euo pipefail

DB_CONTAINER="${IPROPY_DB_CONTAINER:-ipropy-db}"
DB_USER="${POSTGRES_USER:-ipropy}"
DB_NAME="${POSTGRES_DB:-ipropy}"

# Production's payload columns, verbatim from the probe.
PROP_COLUMNS="amenities,area_unit,base_price,carpet_area,configuration,custom_fields,facing,floor_plan_url,latitude,locality,longitude,name,possession_status,property_code,record_id,status,tower,unit_number"
PROP_TOMBSTONES="age_of_property,area,balconies,balcony_area,bathrooms,bedrooms,blocked_by,blocked_for_lead_id,blocked_until,built_up_area,carpet_area,category,city,club_membership,configuration,corner_unit,demand,demand_unit,description,floor,floor_rise_charge,furnishing,gallery,gst_percent,is_resale,locality,maintenance_deposit,maintenance_monthly,market_price,monthly_rent,offer_price,other_charges,owner_contact_id,parking_charge,parking_slots,plc_charge,plot_area,possession_date,price_compare,project_name,property_type,rate_per_sqft,registration_charge,security_deposit,stamp_duty_percent,super_built_up_area,terrace_area,total_price,vastu_compliant,video_url,view_description,virtual_tour_url,wing"
LEAD_TOMBSTONES="aadhaar_masked,address,ai_grade,ai_score,ai_score_reasons,ai_scored_at,anniversary,annual_income,bedroom,bedrooms,budget_band,budget_max,budget_min,category,company,contact_attempts,converted_at,country_code,date_of_birth,description,designation,do_not_call,do_not_whatsapp,email_opt_out,engagement_score,fbclid,first_name,first_response_secs,funding_type,gclid,gender,interested_project,ip_address,is_converted,is_nri,junk_reason,kyc_status,landing_page,last_name,lead_status,lifecycle_stage,lifetime_value,loan_required,nationality,occupation,owner_id,pan,passport_number,portrait_url,possession_timeline,preferred_contact,preferred_language,property_type,purpose,qualification_notes,rating,referred_by,requirement,salutation,secondary_email,source,sub_source,utm_campaign,utm_content,utm_medium,utm_source,utm_term,whatsapp_number"
LEAD_COLUMNS="alternate_phone,area,area_unit,budget,budget_unit,configuration,contact_type,custom_fields,email,full_name,last_contacted_at,lead_number,lead_source,lost_reason,mobile,next_followup_at,preferred_locations,record_id,status"

psql() { docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

echo "→ mirroring production's field shape onto $DB_NAME"

psql -v ON_ERROR_STOP=1 <<SQL
BEGIN;

-- Production carries these two columns; a fresh seed does not.
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS carpet_area NUMERIC;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS configuration TEXT;

-- 1. Production's tombstone list, verbatim — not "whatever this database
--    happens to be missing". A field the template still defines and this
--    database has already lost has nothing here to tombstone, so the next
--    seed puts it straight back and the mirror drifts on its first re-seed.
--    That is how `view_description` returned, and it is the same reason
--    production's own `bedrooms` survives: it is tombstoned there.
INSERT INTO ipy_field_tombstone (module_name, field_name)
SELECT 'properties', unnest(string_to_array('$PROP_TOMBSTONES', ','))
ON CONFLICT DO NOTHING;
INSERT INTO ipy_field_tombstone (module_name, field_name)
SELECT 'leads', unnest(string_to_array('$LEAD_TOMBSTONES', ','))
ON CONFLICT DO NOTHING;

DELETE FROM ipy_field f USING ipy_module m
 WHERE m.id = f.module_id
   AND ((m.name = 'properties' AND f.column_name <> ALL (string_to_array('$PROP_COLUMNS', ',') || ARRAY['owner_id']))
     OR (m.name = 'leads'      AND f.column_name <> ALL (string_to_array('$LEAD_COLUMNS', ',') || ARRAY['owner_id'])));

-- 2. The renames. Name moves, column never does — that is the whole point.
UPDATE ipy_field f SET name = v.new_name, is_customised = true
  FROM (VALUES
    ('properties','base_price','demand'),
    ('properties','locality','preferred_locations'),
    ('properties','carpet_area','area_size'),
    ('properties','configuration','bedrooms'),
    ('properties','tower','block_tower'),
    ('properties','name','full_name'),
    ('properties','owner_id','assigned_to'),
    ('leads','status','lead_status'),
    ('leads','owner_id','assigned_to')
  ) AS v(module_name, col, new_name)
  JOIN ipy_module m ON m.name = v.module_name
 WHERE f.module_id = m.id AND f.column_name = v.col AND f.name <> v.new_name;

-- 3. Fields production keeps but hides.
UPDATE ipy_field f SET is_active = false, display_type = 'hidden'
  FROM ipy_module m
 WHERE m.id = f.module_id
   AND ((m.name = 'properties' AND f.column_name IN ('amenities','latitude','longitude'))
     OR (m.name = 'leads'      AND f.column_name IN ('last_contacted_at')));

COMMIT;
SQL

# 3b. Production has these two fields; a local seed does not create them,
#     because the template's originals were deleted here long ago.
psql -v ON_ERROR_STOP=1 <<'SQL'
--     The config matters as much as the row. An `area` field with no
--     `unitMaster` has no Sq Ft / Sq Yd list, its companion `area_unit` is not
--     offered to the importer, and the mirror quietly tells you the CRM is
--     broken in a way production is not.
INSERT INTO ipy_field (module_id, block_id, name, label, uitype, storage, column_name, sequence, is_customised, config)
SELECT m.id,
       (SELECT id FROM ipy_block WHERE module_id = m.id ORDER BY sequence LIMIT 1),
       v.name, v.label, v.uitype, 'column', v.col, 900 + v.seq, true, v.config::jsonb
  FROM ipy_module m
 CROSS JOIN (VALUES ('area_size','Area / Size','area','carpet_area',1,
                       '{"min":0,"unit":"sqft","unitField":"area_unit","unitMaster":"area"}'),
                    ('bedrooms','Bedrooms','picklist','configuration',2,
                       '{"picklist":"bedrooms"}'))
              AS v(name, label, uitype, col, seq, config)
 WHERE m.name = 'properties'
   AND NOT EXISTS (SELECT 1 FROM ipy_field f WHERE f.module_id = m.id AND f.column_name = v.col);
DELETE FROM ipy_field_tombstone WHERE module_name='properties' AND field_name IN ('area_size');
SQL

# 4. Drop the payload columns nothing owns any more, so a query that names one
#    fails here exactly as it fails there.
for spec in "ipy_e_properties:$PROP_COLUMNS" "ipy_e_leads:$LEAD_COLUMNS"; do
  table="${spec%%:*}"; keep="${spec#*:}"
  # The list is read into an array first: `psql` inside a `while read` loop
  # reads the loop's own stdin and swallows the remaining column names, so a
  # pipeline here drops one column and silently skips the rest.
  # Collected up front rather than piped: `psql` inside a `while read` loop
  # reads the loop's own stdin and swallows the remaining names, so the
  # pipeline version dropped one column and silently skipped the rest. And
  # `mapfile` is bash 4; macOS ships 3.2.
  dead=$(psql -tAc "SELECT column_name FROM information_schema.columns
              WHERE table_name = '$table'
                AND column_name <> ALL (string_to_array('$keep', ','))" </dev/null)
  for col in $dead; do
    [ -n "$col" ] || continue
    psql -c "ALTER TABLE $table DROP COLUMN IF EXISTS \"$col\" CASCADE" </dev/null >/dev/null
    echo "   dropped $table.$col"
  done
done

echo "→ done. Field counts now:"
psql -tAc "SELECT m.name || ': ' || count(*) FROM ipy_field f JOIN ipy_module m ON m.id=f.module_id
            WHERE m.name IN ('leads','properties') GROUP BY m.name ORDER BY 1"
