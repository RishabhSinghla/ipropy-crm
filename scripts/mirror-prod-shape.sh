#!/usr/bin/env bash
# Make the local database the same *shape* as production.
#
# `db-pull-prod.sh` is the real thing and copies the rows too, but it needs
# PROD_DATABASE_URL. This is the half that can be done without a credential:
# production's field set, its renames, its tombstones and its admin-created
# fields, applied to a local database that was seeded from the template.
#
# Why it exists: a fresh seed gives leads and properties ~60 fields each whose
# name and column are the same string, and not one field in JSONB storage.
# Production has 15 and 16 real columns, several renamed, the rest permanently
# deleted (which drops the column), and 25 admin-created fields that live in
# `custom_fields`. Every bug this project keeps rediscovering — 42703 on a
# deleted column, a mapping keyed on a name that moved, config keyed by a field
# id that was re-created — is invisible on the seeded shape and obvious on this
# one.
#
# The shape below is read from the `Probe prod schema` workflow's output, which
# is read-only. Re-run that probe and update these lists when production moves;
# it prints every value this file needs, including each json field's uitype and
# config, because a picklist with no `picklist` config has no list and an area
# field with no `unitMaster` has no Sq Ft / Sq Yd — a mirror built from names
# alone reports the CRM broken in ways production is not.
#
#   npm run db:seed && bash scripts/mirror-prod-shape.sh
#
# Last reconciled against production: 2026-09-11 (run 34620360371).
set -euo pipefail

DB_CONTAINER="${IPROPY_DB_CONTAINER:-ipropy-db}"
DB_USER="${POSTGRES_USER:-ipropy}"
DB_NAME="${POSTGRES_DB:-ipropy}"

# Production's payload columns, verbatim from the probe. `owner_id` is not here
# and must not be: it lives on `ipy_record`, and creating a same-named column on
# the payload table shadows the real one so every record reads as unassigned.
PROP_COLUMNS="amenities,configuration,custom_fields,facing,floor_plan_url,full_name,latitude,locality,longitude,mobile,possession_status,property_code,record_id,status,tower,unit_number"
LEAD_COLUMNS="alternate_phone,budget,configuration,contact_type,custom_fields,email,full_name,lead_number,lead_source,lost_reason,mobile,next_followup_at,preferred_locations,record_id,status"

PROP_TOMBSTONES="age_of_property,area,area_size,area_unit,balconies,balcony_area,base_price,bathrooms,bedrooms,blocked_by,blocked_for_lead_id,blocked_until,built_up_area,carpet_area,category,city,club_membership,configuration,corner_unit,demand,demand_unit,description,floor,floor_rise_charge,furnishing,gallery,gst_percent,is_resale,locality,maintenance_deposit,maintenance_monthly,market_price,monthly_rent,name,offer_price,other_charges,owner_contact_id,parking_charge,parking_slots,plc_charge,plot_area,possession_date,price_compare,project_name,property_type,rate_per_sqft,registration_charge,security_deposit,stamp_duty_percent,super_built_up_area,terrace_area,total_price,vastu_compliant,video_url,view_description,virtual_tour_url,wing"
LEAD_TOMBSTONES="aadhaar_masked,address,ai_grade,ai_score,ai_score_reasons,ai_scored_at,anniversary,annual_income,area,area_unit,bedroom,bedrooms,budget_band,budget_max,budget_min,budget_unit,category,company,contact_attempts,converted_at,country_code,date_of_birth,description,designation,do_not_call,do_not_whatsapp,email_opt_out,engagement_score,fbclid,first_name,first_response_secs,funding_type,gclid,gender,interested_project,ip_address,is_converted,is_nri,junk_reason,kyc_status,landing_page,last_contacted_at,last_name,lead_status,lifecycle_stage,lifetime_value,loan_required,nationality,occupation,owner_id,pan,passport_number,portrait_url,possession_timeline,preferred_contact,preferred_language,property_type,purpose,qualification_notes,rating,referred_by,requirement,salutation,secondary_email,source,sub_source,utm_campaign,utm_content,utm_medium,utm_source,utm_term,whatsapp_number"

psql() { docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

echo "→ mirroring production's field shape onto $DB_NAME"

psql -v ON_ERROR_STOP=1 <<SQL
BEGIN;

-- Production carries this column and a fresh seed does not; the field that
-- reads it is renamed to \`bedrooms\` below.
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS configuration TEXT;

-- 1. Production's tombstone list, verbatim — not "whatever this database
--    happens to be missing". A field the template still defines and this
--    database has already lost has nothing here to tombstone, so the next
--    seed puts it straight back and the mirror drifts on its first re-seed.
--    That is how \`view_description\` returned, and it is the same reason
--    production's own \`bedrooms\` survives: it is tombstoned there, and the
--    live field of that name is a rename of \`configuration\`.
INSERT INTO ipy_field_tombstone (module_name, field_name)
SELECT 'properties', unnest(string_to_array('$PROP_TOMBSTONES', ','))
ON CONFLICT DO NOTHING;
INSERT INTO ipy_field_tombstone (module_name, field_name)
SELECT 'leads', unnest(string_to_array('$LEAD_TOMBSTONES', ','))
ON CONFLICT DO NOTHING;

DELETE FROM ipy_field f USING ipy_module m
 WHERE m.id = f.module_id
   AND f.storage = 'column'
   AND ((m.name = 'properties' AND f.column_name <> ALL (string_to_array('$PROP_COLUMNS', ',') || ARRAY['owner_id']))
     OR (m.name = 'leads'      AND f.column_name <> ALL (string_to_array('$LEAD_COLUMNS', ',') || ARRAY['owner_id'])));

-- 2. The renames. Name moves, column never does — that is the whole point, and
--    it is why code keyed on a field *name* breaks here and nowhere else.
UPDATE ipy_field f SET name = v.new_name, is_customised = true
  FROM (VALUES
    ('properties','locality','preferred_locations'),
    ('properties','configuration','bedrooms'),
    ('properties','tower','block_tower'),
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
   AND m.name = 'properties'
   AND f.column_name IN ('amenities','latitude','longitude');

COMMIT;
SQL

# 3b. Production's admin-created fields, which all live in \`custom_fields\`
#     JSONB. A local seed creates none of them — it has no way to, since they
#     were added through the UI — so localhost had *zero* json-storage fields
#     while production has 25. That is the entire admin-created code path
#     untested, on the field set the team actually uses every day.
#
#     uitype, label and config are copied verbatim from the probe, config
#     included: an \`area\` field without \`unitMaster\` offers no Sq Ft / Sq Yd
#     and no companion unit field to the importer, and a picklist without
#     \`picklist\` has no list at all.
psql -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO ipy_field (module_id, block_id, name, label, uitype, storage, column_name, sequence, is_customised, config)
SELECT m.id,
       (SELECT id FROM ipy_block WHERE module_id = m.id ORDER BY sequence LIMIT 1),
       v.name, v.label, v.uitype, 'json', NULL, 900 + v.seq, true, v.config::jsonb
  FROM (VALUES
    ('properties','alternate_phone','Alternate Phone','phone',1,'{"codePrefix":"+91"}'),
    ('properties','area_size','Area / Size','area',2,'{"sortable":true,"unitField":"area_size_unit","exportable":true,"filterable":true,"importable":true,"unitMaster":"area"}'),
    ('properties','area_size_unit','Area / Size Unit','string',3,'{}'),
    ('properties','asking_price','Asking Price','currency',4,'{"sortable":true,"unitField":"asking_price_unit","exportable":true,"filterable":true,"importable":true,"unitMaster":"budget_demand"}'),
    ('properties','asking_price_unit','Asking Price Unit','string',5,'{}'),
    ('properties','bathrooms','Bathrooms','picklist',6,'{"picklist":"bathroom"}'),
    ('properties','category','Category','picklist',7,'{"picklist":"category"}'),
    ('properties','contact_type','Contact Type','picklist',8,'{"picklist":"contact_type"}'),
    ('properties','email','Email','email',9,'{"sortable":true,"exportable":true,"filterable":true,"importable":true}'),
    ('properties','floor','Floor','picklist',10,'{"picklist":"floor"}'),
    ('properties','lost_reason','Lost Reason','picklist',11,'{"picklist":"lost_reason"}'),
    ('properties','next_follow_up','Next Follow Up','date',12,'{}'),
    ('properties','portion_type','Portion','picklist',13,'{"picklist":"portion_type","sortable":true,"exportable":true,"filterable":true,"importable":true}'),
    ('properties','property_source','Property Source','picklist',14,'{"picklist":"lead_source","sortable":true,"exportable":true,"filterable":true,"importable":true}'),
    ('properties','publish_to_web','Show on Website','boolean',15,'{}'),
    ('leads','area_size','Area / Size','area',16,'{"sortable":true,"unitField":"area_size_unit","exportable":true,"filterable":true,"importable":true,"unitMaster":"area"}'),
    ('leads','area_size_unit','Area / Size Unit','string',17,'{"sortable":true,"exportable":true,"filterable":true,"importable":true}'),
    ('leads','bathrooms','Bathrooms','picklist',18,'{"picklist":"bathroom","sortable":true,"exportable":true,"filterable":true,"importable":true}'),
    ('leads','block_tower','Block / Tower','picklist',19,'{"picklist":"tower"}'),
    ('leads','category','Category','picklist',20,'{"picklist":"category","sortable":true,"exportable":true,"filterable":true,"importable":true}'),
    ('leads','facing','Facing','picklist',21,'{"picklist":"facing"}'),
    ('leads','floor','Floor','picklist',22,'{"picklist":"floor","referenceModules":["properties"]}'),
    ('leads','portion','Portion','picklist',23,'{"picklist":"portion_type"}'),
    ('leads','possession_status','Possession Status','picklist',24,'{"picklist":"possession_status"}'),
    ('leads','unit_no','Unit Number','string',25,'{"sortable":true,"exportable":true,"filterable":true,"importable":true}')
  ) AS v(module_name, name, label, uitype, seq, config)
  JOIN ipy_module m ON m.name = v.module_name
 WHERE NOT EXISTS (SELECT 1 FROM ipy_field f WHERE f.module_id = m.id AND f.name = v.name);
SQL

# 4. Drop the payload columns nothing owns any more, so a query that names one
#    fails here exactly as it fails there.
for spec in "ipy_e_properties:$PROP_COLUMNS" "ipy_e_leads:$LEAD_COLUMNS"; do
  table="${spec%%:*}"; keep="${spec#*:}"
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
psql -tAc "SELECT m.name || ': ' || count(*) || ' (' || count(*) FILTER (WHERE f.storage='json') || ' json)'
             FROM ipy_field f JOIN ipy_module m ON m.id=f.module_id
            WHERE m.name IN ('leads','properties') GROUP BY m.name ORDER BY 1"
