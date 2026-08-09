import type { Tx } from '../pool.js';
import type { SeededUser } from './rbac.js';
import { nextNumber } from '../../core/entity/numbering.js';

/**
 * Demo dataset — a plausible mid-size developer with three live projects.
 * Written directly against the tables (rather than through the record service)
 * so seeding stays fast and does not depend on an authenticated context.
 */

const CRORE = 10_000_000;
const LAKH = 100_000;

interface InsertOpts {
  module: string;
  label: string;
  ownerId: string;
  createdBy: string;
  values: Record<string, unknown>;
  numberField?: string;
  createdAt?: Date;
  searchText?: string;
}

async function insertRecord(conn: Tx, opts: InsertOpts): Promise<string> {
  const mod = await conn.queryOne<{ id: string; table_name: string }>(
    `SELECT id, table_name FROM ipy_module WHERE name = $1`, [opts.module],
  );
  if (!mod) throw new Error(`module ${opts.module} not seeded`);

  let recordNumber: string | null = null;
  const values = { ...opts.values };
  if (opts.numberField) {
    const field = await conn.queryOne<{ config: { numbering?: { prefix?: string; digits?: number } } }>(
      `SELECT config FROM ipy_field WHERE module_id = $1 AND name = $2`, [mod.id, opts.numberField],
    );
    recordNumber = await nextNumber(opts.module, opts.numberField, field?.config?.numbering ?? {}, conn);
    values[opts.numberField] = recordNumber;
  }

  const rec = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_record
       (module_id, module_name, record_number, label, owner_id, created_by, modified_by,
        search_text, created_at, updated_at, last_activity_at, source)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$8,$8,'seed')
     RETURNING id`,
    [
      mod.id, opts.module, recordNumber, opts.label, opts.ownerId, opts.createdBy,
      opts.searchText ?? opts.label,
      opts.createdAt ?? new Date(),
    ],
  );
  const recordId = rec!.id;

  // Split into declared columns vs custom_fields using the seeded metadata.
  const fields = await conn.query<{ name: string; storage: string; column_name: string; uitype: string }>(
    `SELECT name, storage, column_name, uitype FROM ipy_field WHERE module_id = $1`, [mod.id],
  );
  const byName = new Map(fields.rows.map((f) => [f.name, f]));

  const cols: string[] = ['record_id'];
  const vals: unknown[] = [recordId];
  const custom: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined) continue;
    const meta = byName.get(key);
    if (!meta) continue;
    const jsonish = ['multipicklist', 'multireference', 'tags', 'address', 'geolocation', 'file', 'image', 'json'];
    const value = jsonish.includes(meta.uitype) && raw !== null ? JSON.stringify(raw) : raw;
    if (meta.storage === 'column') {
      cols.push(`"${meta.column_name}"`);
      vals.push(value);
    } else {
      custom[meta.column_name] = raw;
    }
  }
  if (Object.keys(custom).length) {
    cols.push('custom_fields');
    vals.push(JSON.stringify(custom));
  }

  await conn.query(
    `INSERT INTO ${mod.table_name} (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  );
  return recordId;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}
function daysAhead(n: number): Date {
  return new Date(Date.now() + n * 86_400_000);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length];
}
/** Deterministic pseudo-random so repeated seeds produce the same demo set. */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
function randInt(seed: number, min: number, max: number): number {
  return min + Math.floor(rand(seed) * (max - min + 1));
}

const FIRST_NAMES = ['Aarav', 'Vivaan', 'Aditya', 'Ananya', 'Diya', 'Ishaan', 'Kavya', 'Rohan', 'Meera', 'Arjun',
  'Saanvi', 'Kabir', 'Riya', 'Aryan', 'Nisha', 'Karthik', 'Pooja', 'Siddharth', 'Tanvi', 'Manish',
  'Deepika', 'Rajesh', 'Sneha', 'Amit', 'Preeti', 'Vikas', 'Anjali', 'Suresh', 'Ritu', 'Nikhil'];
const LAST_NAMES = ['Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Singh', 'Gupta', 'Mehta', 'Joshi',
  'Kulkarni', 'Rao', 'Desai', 'Kapoor', 'Malhotra', 'Bose', 'Chopra', 'Shetty', 'Pillai', 'Bhat'];

export async function seedDemoData(conn: Tx, users: SeededUser[]): Promise<void> {
  if (users.length === 0) return;
  const admin = users[0];
  const salesUsers = users.slice(1).length ? users.slice(1) : users;
  const ownerAt = (i: number): string => salesUsers[i % salesUsers.length].id;

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  const projectDefs = [
    {
      name: 'Skyline Aurum', dev: 0, city: 'Mumbai', locality: 'Powai', status: 'Under Construction',
      type: 'Residential', towers: 4, floors: 32, units: 448, priceMin: 2.1 * CRORE, priceMax: 5.8 * CRORE,
      rate: 28500, possession: daysAhead(540), launch: daysAgo(420), completion: 46,
      configs: ['2 BHK', '3 BHK', '4 BHK'], rera: 'P51800012345',
      usps: ['Direct lake view from 60% of units', '3-acre podium garden', '8 minutes to Powai IT park', 'Grade-A construction by Skyline'],
      amenities: ['Swimming Pool', 'Gymnasium', 'Clubhouse', 'Landscaped Garden', 'Jogging Track', '24x7 Security', 'CCTV Surveillance', 'Power Backup', 'Covered Parking', 'EV Charging', 'Children Play Area', 'Amphitheatre'],
      lat: 19.1176, lng: 72.9060,
      connectivity: [{ place: 'Powai Lake', distance: '0.4 km' }, { place: 'Hiranandani Business Park', distance: '2.1 km' }, { place: 'Chhatrapati Shivaji Airport', distance: '8.5 km' }, { place: 'Kanjurmarg Station', distance: '3.2 km' }],
    },
    {
      name: 'Verdant Greens', dev: 1, city: 'Bengaluru', locality: 'Sarjapur Road', status: 'New Launch',
      type: 'Residential', towers: 6, floors: 18, units: 612, priceMin: 85 * LAKH, priceMax: 2.4 * CRORE,
      rate: 9800, possession: daysAhead(900), launch: daysAgo(60), completion: 8,
      configs: ['1 BHK', '2 BHK', '3 BHK'], rera: 'PRM/KA/RERA/1251/446',
      usps: ['IGBC Platinum pre-certified', '72% open space', 'Walk to Wipro SEZ', 'Pre-launch pricing until quarter end'],
      amenities: ['Swimming Pool', 'Gymnasium', 'Clubhouse', 'Yoga Deck', 'Indoor Games', 'Rainwater Harvesting', 'Solar Panels', 'Sewage Treatment Plant', 'Pet Park', 'Sports Court', 'Co-working'],
      lat: 12.9010, lng: 77.6874,
      connectivity: [{ place: 'Wipro SEZ', distance: '3.0 km' }, { place: 'RGA Tech Park', distance: '4.5 km' }, { place: 'Sarjapur Junction', distance: '1.2 km' }, { place: 'Kempegowda Airport', distance: '52 km' }],
    },
    {
      name: 'Meridian Crest', dev: 2, city: 'Pune', locality: 'Kharadi', status: 'Nearing Possession',
      type: 'Mixed Use', towers: 3, floors: 24, units: 288, priceMin: 1.15 * CRORE, priceMax: 3.2 * CRORE,
      rate: 14200, possession: daysAhead(120), launch: daysAgo(1080), completion: 88,
      configs: ['2 BHK', '3 BHK', 'Commercial'], rera: 'P52100019876',
      usps: ['Possession in 4 months', 'Retail high street on ground floor', 'Adjacent to EON IT Park', 'OC expected next quarter'],
      amenities: ['Swimming Pool', 'Gymnasium', 'Clubhouse', 'Business Centre', 'Cafeteria', 'Multipurpose Hall', 'Covered Parking', 'Visitor Parking', 'Intercom', 'Fire Safety', 'Concierge'],
      lat: 18.5515, lng: 73.9490,
      connectivity: [{ place: 'EON IT Park', distance: '1.1 km' }, { place: 'Pune Airport', distance: '7.8 km' }, { place: 'Magarpatta City', distance: '5.4 km' }],
    },
  ];

  const projectIds: string[] = [];
  for (const [i, p] of projectDefs.entries()) {
    const id = await insertRecord(conn, {
      module: 'projects', label: p.name, ownerId: ownerAt(i), createdBy: admin.id,
      numberField: 'project_code', createdAt: p.launch,
      searchText: `${p.name} ${p.city} ${p.locality} ${p.configs.join(' ')}`,
      values: {
        name: p.name, status: p.status, project_type: p.type,
        city: p.city, locality: p.locality, state: p.city === 'Bengaluru' ? 'Karnataka' : 'Maharashtra',
        country: 'India', latitude: p.lat, longitude: p.lng, micro_market: i === 1 ? 'IT Corridor' : 'Prime',
        rera_number: p.rera, rera_expiry: isoDate(daysAhead(700)),
        total_towers: p.towers, total_floors: p.floors, total_units: p.units,
        total_land_area: 4.2 + i, land_area_unit: 'acre', open_area_percent: 62 + i * 4,
        price_min: p.priceMin, price_max: p.priceMax, rate_per_sqft: p.rate,
        configurations: p.configs, amenities: p.amenities, usps: p.usps,
        connectivity: p.connectivity,
        launch_date: isoDate(p.launch), possession_date: isoDate(p.possession),
        completion_percent: p.completion, broker_commission_pct: 2,
        description: `${p.name} — a ${p.type.toLowerCase()} development in ${p.locality}, ${p.city}. ${p.usps[0]}.`,
      },
    });
    projectIds.push(id);
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------
  const propertyIds: { id: string; projectIdx: number; price: number; config: string; status: string }[] = [];
  const facings = ['North', 'East', 'West', 'North-East', 'South-East'];
  let unitSeed = 1;

  for (const [pi, p] of projectDefs.entries()) {
    const perProject = 22;
    for (let u = 0; u < perProject; u++) {
      unitSeed++;
      const config = pick(p.configs, u);
      const tower = String.fromCharCode(65 + (u % p.towers));
      const floor = 2 + (u % (p.floors - 2));
      const unitNo = `${floor}${String((u % 4) + 1).padStart(2, '0')}`;
      const carpet = config.startsWith('1 ') ? randInt(unitSeed, 420, 520)
        : config.startsWith('2 ') ? randInt(unitSeed, 640, 830)
        : config.startsWith('3 ') ? randInt(unitSeed, 980, 1320)
        : config === 'Commercial' ? randInt(unitSeed, 500, 2200)
        : randInt(unitSeed, 1600, 2400);
      const basePrice = Math.round((carpet * p.rate * (1 + floor * 0.004)) / 10000) * 10000;
      const floorRise = Math.round(carpet * floor * 25);
      const plc = ['North-East', 'East'].includes(pick(facings, u)) ? Math.round(basePrice * 0.02) : 0;
      const parking = 350_000;
      const club = 250_000;
      const maint = Math.round(carpet * 60);
      const total = basePrice + floorRise + plc + parking + club + maint;

      // A realistic mix: mostly available, some blocked, some sold.
      const r = rand(unitSeed * 3.7);
      const status = r < 0.58 ? 'Available' : r < 0.68 ? 'Held' : r < 0.74 ? 'Blocked' : r < 0.88 ? 'Booked' : 'Sold';

      const id = await insertRecord(conn, {
        module: 'properties', label: `${p.name} — ${tower}-${unitNo}`, ownerId: ownerAt(pi), createdBy: admin.id,
        numberField: 'property_code', createdAt: daysAgo(300 - u),
        searchText: `${p.name} ${tower} ${unitNo} ${config} ${p.locality}`,
        values: {
          name: `${p.name} — Tower ${tower}, Unit ${unitNo}`,
          project_id: projectIds[pi], status, property_type: config === 'Commercial' ? 'Office Space' : 'Apartment',
          configuration: config, tower: `Tower ${tower}`, floor, unit_number: unitNo,
          facing: pick(facings, u), corner_unit: u % 7 === 0, vastu_compliant: u % 3 !== 0,
          carpet_area: carpet, built_up_area: Math.round(carpet * 1.18),
          super_built_up_area: Math.round(carpet * 1.42), balcony_area: Math.round(carpet * 0.08),
          area_unit: 'sqft',
          bedrooms: config.startsWith('1') ? 1 : config.startsWith('2') ? 2 : config.startsWith('3') ? 3 : config === 'Commercial' ? 0 : 4,
          bathrooms: config.startsWith('1') ? 1 : config.startsWith('2') ? 2 : 3,
          balconies: config.startsWith('1') ? 1 : 2,
          parking_slots: config.startsWith('1') ? 1 : 2,
          furnishing: 'Unfurnished',
          base_price: basePrice, rate_per_sqft: p.rate, floor_rise_charge: floorRise,
          plc_charge: plc, parking_charge: parking, club_membership: club,
          maintenance_deposit: maint, gst_percent: 5, stamp_duty_percent: 6,
          total_price: total,
          possession_status: p.status === 'Nearing Possession' ? 'Under Construction' : p.status === 'New Launch' ? 'New Launch' : 'Under Construction',
          possession_date: isoDate(p.possession),
          city: p.city, locality: p.locality, latitude: p.lat, longitude: p.lng,
          amenities: p.amenities.slice(0, 6),
          blocked_until: status === 'Held' || status === 'Blocked' ? daysAhead(randInt(unitSeed, 1, 9)) : null,
          description: `${config} in ${p.name}, Tower ${tower} on floor ${floor}. ${pick(facings, u)} facing with ${carpet} sq.ft carpet area.`,
        },
      });
      propertyIds.push({ id, projectIdx: pi, price: total, config, status });
    }

    // Keep the project rollups honest with the inventory we just created.
    const counts = propertyIds.filter((x) => x.projectIdx === pi);
    await conn.query(
      `UPDATE ipy_e_projects SET available_units = $2, booked_units = $3 WHERE record_id = $1`,
      [projectIds[pi], counts.filter((c) => c.status === 'Available').length, counts.filter((c) => c.status === 'Booked' || c.status === 'Sold').length],
    );
  }

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------
  const campaigns = [
    { name: 'Aurum Launch — Meta Ads', type: 'Digital Ads', project: 0, budget: 18 * LAKH, spend: 14.2 * LAKH, impressions: 2_840_000, clicks: 51_200, leads: 640, qualified: 188, visits: 96, bookings: 11, revenue: 31 * CRORE, utm: 'aurum_meta_q3' },
    { name: 'Verdant Pre-Launch — Google Search', type: 'Digital Ads', project: 1, budget: 12 * LAKH, spend: 9.8 * LAKH, impressions: 980_000, clicks: 33_400, leads: 412, qualified: 121, visits: 58, bookings: 7, revenue: 11 * CRORE, utm: 'verdant_gads_launch' },
    { name: 'Crest Possession Drive — WhatsApp', type: 'WhatsApp', project: 2, budget: 3 * LAKH, spend: 2.1 * LAKH, impressions: 42_000, clicks: 8_900, leads: 187, qualified: 74, visits: 41, bookings: 9, revenue: 16 * CRORE, utm: 'crest_wa_possession' },
    { name: 'NRI Roadshow — Dubai', type: 'Event/Expo', project: 0, budget: 22 * LAKH, spend: 21.4 * LAKH, impressions: 0, clicks: 0, leads: 96, qualified: 52, visits: 18, bookings: 6, revenue: 24 * CRORE, utm: 'nri_dubai_expo' },
    { name: 'Channel Partner Meet — Q3', type: 'Channel Partner Meet', project: 1, budget: 6 * LAKH, spend: 5.6 * LAKH, impressions: 0, clicks: 0, leads: 143, qualified: 61, visits: 39, bookings: 8, revenue: 13 * CRORE, utm: 'cp_meet_q3' },
  ];
  const campaignIds: string[] = [];
  for (const [i, c] of campaigns.entries()) {
    const id = await insertRecord(conn, {
      module: 'campaigns', label: c.name, ownerId: ownerAt(6), createdBy: admin.id,
      numberField: 'campaign_number', createdAt: daysAgo(120 - i * 15),
      values: {
        name: c.name, campaign_type: c.type, status: i < 3 ? 'Active' : 'Completed',
        project_id: projectIds[c.project], start_date: isoDate(daysAgo(120 - i * 15)),
        end_date: isoDate(daysAhead(i < 3 ? 45 : -10)),
        budget: c.budget, actual_cost: c.spend,
        impressions: c.impressions, clicks: c.clicks,
        leads_generated: c.leads, qualified_leads: c.qualified,
        site_visits: c.visits, bookings: c.bookings, revenue_generated: c.revenue,
        cost_per_lead: c.leads ? Math.round(c.spend / c.leads) : 0,
        roi_percent: c.spend ? Math.round(((c.revenue - c.spend) / c.spend) * 100) : 0,
        utm_campaign: c.utm, external_id: `ext_${c.utm}`,
        target_audience: 'Working professionals, 30-45, household income above ₹30L, currently renting in the micro-market.',
      },
    });
    campaignIds.push(id);
  }

  // -------------------------------------------------------------------------
  // Leads
  // -------------------------------------------------------------------------
  const statuses = ['New', 'Attempted Contact', 'Contacted', 'Qualified', 'Site Visit Scheduled', 'Site Visit Done', 'Negotiation', 'Junk', 'Lost'];
  const sources = ['Website', 'Facebook Lead Ad', 'Google Ads', '99acres', 'MagicBricks', 'Housing.com', 'Walk-in', 'Referral', 'Channel Partner', 'WhatsApp'];
  const timelines = ['Immediate', 'Within 1 Month', '1-3 Months', '3-6 Months', '6-12 Months', 'Just Exploring'];
  const configs = ['1 BHK', '2 BHK', '3 BHK', '4 BHK'];

  const leadIds: string[] = [];
  for (let i = 0; i < 60; i++) {
    const s = i + 100;
    const first = pick(FIRST_NAMES, i * 3);
    const last = pick(LAST_NAMES, i * 5);
    const status = pick(statuses, i);
    const source = pick(sources, i * 2);
    const projectIdx = i % 3;
    const budgetMin = [50 * LAKH, 80 * LAKH, 1.2 * CRORE, 1.8 * CRORE, 2.5 * CRORE][i % 5];
    const budgetMax = budgetMin * 1.35;
    const createdDaysAgo = randInt(s, 0, 75);
    const timeline = pick(timelines, i);

    // Score correlates with the signals a real model would weigh.
    let score = 35;
    if (['Immediate', 'Within 1 Month'].includes(timeline)) score += 25;
    else if (timeline === '1-3 Months') score += 12;
    else if (timeline === 'Just Exploring') score -= 12;
    if (['Referral', 'Walk-in', 'Channel Partner'].includes(source)) score += 15;
    if (budgetMax >= 2 * CRORE) score += 10;
    if (['Qualified', 'Site Visit Scheduled', 'Site Visit Done', 'Negotiation'].includes(status)) score += 18;
    if (['Junk', 'Lost'].includes(status)) score -= 30;
    score = Math.max(3, Math.min(97, score + randInt(s * 2, -8, 8)));
    const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';

    const reasons: string[] = [];
    if (['Immediate', 'Within 1 Month'].includes(timeline)) reasons.push(`Purchase timeline is "${timeline}" — high urgency`);
    if (['Referral', 'Walk-in'].includes(source)) reasons.push(`${source} leads convert ~3x better than paid channels`);
    if (budgetMax >= 2 * CRORE) reasons.push('Budget comfortably covers available premium inventory');
    if (status === 'Site Visit Done') reasons.push('Already completed a site visit');
    if (['Junk', 'Lost'].includes(status)) reasons.push('Marked as lost/junk by the rep');
    if (!reasons.length) reasons.push('Limited qualification signal captured so far');

    const isConverted = status === 'Negotiation' && i % 4 === 0;
    const mobile = `99${String(10000000 + i * 7919).slice(0, 8)}`;

    const id = await insertRecord(conn, {
      module: 'leads', label: `${first} ${last}`, ownerId: ownerAt(i), createdBy: admin.id,
      numberField: 'lead_number', createdAt: daysAgo(createdDaysAgo),
      searchText: `${first} ${last} ${source} ${projectDefs[projectIdx].name}`,
      values: {
        salutation: i % 3 === 0 ? 'Mr.' : i % 3 === 1 ? 'Ms.' : 'Mrs.',
        first_name: first, last_name: last, full_name: `${first} ${last}`,
        country_code: '+91', mobile,
        email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
        whatsapp_number: `+91${mobile}`,
        status, lead_source: source,
        sub_source: source.includes('Ads') ? 'Paid' : 'Organic',
        campaign_id: source.includes('Ads') || source === 'WhatsApp' ? campaignIds[i % campaignIds.length] : null,
        interested_project_id: projectIds[projectIdx],
        property_type: 'Apartment',
        configuration: [pick(configs, i), pick(configs, i + 1)],
        purpose: i % 5 === 0 ? 'Investment' : 'Buy',
        budget_min: budgetMin, budget_max: budgetMax,
        preferred_locations: [projectDefs[projectIdx].locality],
        carpet_area_min: 650, carpet_area_max: 1400,
        possession_timeline: timeline,
        funding_type: i % 3 === 0 ? 'Self Funded' : i % 3 === 1 ? 'Home Loan' : 'Loan Pre-Approved',
        loan_required: i % 3 !== 0,
        rating: score >= 70 ? 'Hot' : score >= 45 ? 'Warm' : 'Cold',
        ai_score: score, ai_grade: grade, ai_score_reasons: reasons,
        ai_scored_at: daysAgo(createdDaysAgo),
        next_followup_at: ['Junk', 'Lost'].includes(status) ? null : daysAhead(randInt(s * 3, -3, 10)),
        last_contacted_at: status === 'New' ? null : daysAgo(randInt(s * 4, 0, createdDaysAgo)),
        contact_attempts: status === 'New' ? 0 : randInt(s * 5, 1, 6),
        utm_source: source.includes('Facebook') ? 'facebook' : source.includes('Google') ? 'google' : 'direct',
        utm_medium: source.includes('Ads') ? 'cpc' : 'organic',
        utm_campaign: source.includes('Ads') ? campaigns[i % campaigns.length].utm : null,
        is_converted: isConverted,
        lost_reason: status === 'Lost' ? 'Budget Mismatch' : null,
        junk_reason: status === 'Junk' ? 'Broker Enquiry' : null,
        description: `Enquiry for a ${pick(configs, i)} in ${projectDefs[projectIdx].locality}. Timeline: ${timeline}.`,
      },
    });
    leadIds.push(id);
  }

  // -------------------------------------------------------------------------
  // Customers — same module as leads, further along the lifecycle
  // -------------------------------------------------------------------------
  const customerIds: string[] = [];
  for (let i = 0; i < 24; i++) {
    const s = i + 500;
    const first = pick(FIRST_NAMES, i * 7 + 3);
    const last = pick(LAST_NAMES, i * 3 + 1);
    const budgetMin = [80 * LAKH, 1.2 * CRORE, 1.8 * CRORE, 2.6 * CRORE][i % 4];
    const projectIdx = i % 3;
    const mobile = `98${String(30000000 + i * 6317).slice(0, 8)}`;
    const id = await insertRecord(conn, {
      module: 'leads', label: `${first} ${last}`, ownerId: ownerAt(i), createdBy: admin.id,
      numberField: 'lead_number', createdAt: daysAgo(randInt(s, 20, 300)),
      searchText: `${first} ${last} buyer customer ${projectDefs[projectIdx].locality}`,
      values: {
        salutation: i % 2 === 0 ? 'Mr.' : 'Mrs.',
        first_name: first, last_name: last, full_name: `${first} ${last}`,
        country_code: '+91', mobile,
        whatsapp_number: `+91${mobile}`,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
        // Past the enquiry pipeline: these are prospects and customers.
        status: 'Converted',
        lifecycle_stage: i % 3 === 0 ? 'Customer' : 'Prospect',
        is_converted: true,
        converted_at: daysAgo(randInt(s, 10, 200)),
        contact_type: i % 8 === 0 ? 'Investor' : 'Buyer',
        lead_source: pick(sources, i),
        designation: pick(['Product Manager', 'Director', 'Consultant', 'Senior Engineer', 'Founder', 'VP Finance'], i),
        occupation: pick(['Salaried — IT', 'Business Owner', 'Doctor', 'Chartered Accountant', 'Salaried — Non IT'], i),
        annual_income: randInt(s * 2, 25, 90) * LAKH,
        budget_min: budgetMin, budget_max: budgetMin * 1.4,
        preferred_locations: [projectDefs[projectIdx].locality],
        configuration: [pick(configs, i), pick(configs, i + 1)],
        purpose: i % 8 === 0 ? 'Investment' : 'Buy',
        funding_type: i % 3 === 0 ? 'Self Funded' : 'Home Loan',
        possession_timeline: pick(timelines, i),
        is_nri: i % 9 === 0,
        nationality: i % 9 === 0 ? 'Indian (NRI)' : 'Indian',
        preferred_language: pick(['English', 'Hindi', 'Marathi', 'Kannada'], i),
        preferred_contact: pick(['WhatsApp', 'Phone Call', 'Email'], i),
        kyc_status: i % 4 === 0 ? 'Verified' : i % 4 === 1 ? 'Under Verification' : 'Not Started',
        date_of_birth: isoDate(new Date(1980 + (i % 15), i % 12, ((i * 3) % 27) + 1)),
        engagement_score: randInt(s * 3, 30, 95),
        address: { city: projectDefs[projectIdx].city, state: projectDefs[projectIdx].city === 'Bengaluru' ? 'Karnataka' : 'Maharashtra', country: 'India' },
        description: `Buyer profile built from enquiry and site visit history.`,
      },
    });
    customerIds.push(id);
  }

  // -------------------------------------------------------------------------
  // Activities
  // -------------------------------------------------------------------------
  const actTypes = ['Call', 'Follow Up', 'Meeting', 'Site Visit', 'WhatsApp', 'Documentation'];
  for (let i = 0; i < 45; i++) {
    const s = i + 3000;
    const related = leadIds[i % leadIds.length];
    const relatedModule = 'leads';
    const type = pick(actTypes, i);
    const isOverdue = i % 5 === 0;
    const isDone = i % 3 === 0;
    const due = isDone ? daysAgo(randInt(s, 1, 20)) : isOverdue ? daysAgo(randInt(s, 1, 6)) : daysAhead(randInt(s, 0, 10));
    const relLabel = await conn.queryOne<{ label: string }>(`SELECT label FROM ipy_record WHERE id = $1`, [related]);

    await insertRecord(conn, {
      module: 'activities', label: `${type}: ${relLabel?.label ?? ''}`,
      ownerId: ownerAt(i), createdBy: admin.id,
      numberField: 'activity_number', createdAt: daysAgo(randInt(s, 1, 40)),
      values: {
        subject: `${type}: ${relLabel?.label ?? 'Follow up'}`,
        activity_type: type,
        status: isDone ? 'Completed' : isOverdue ? 'Not Started' : 'Not Started',
        priority: isOverdue ? 'High' : pick(['Medium', 'High', 'Low'], i),
        related_to: related, related_module: relatedModule,
        start_at: due, end_at: new Date(due.getTime() + 30 * 60_000),
        due_date: isoDate(due),
        completed_at: isDone ? due : null,
        outcome: isDone ? pick(['Spoke to the buyer, revisit planned', 'Not reachable, will retry', 'Shared cost sheet on WhatsApp', 'Documents collected'], i) : null,
        is_ai_generated: i % 6 === 0,
        description: `Auto-created follow-up for ${relLabel?.label ?? 'the record'}.`,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Conversations, messages and calls
  // -------------------------------------------------------------------------
  await seedConversations(conn, leadIds, customerIds, users);
  await seedCalls(conn, leadIds, users);
  await seedTargets(conn, users);
}

async function seedConversations(conn: Tx, leadIds: string[], customerIds: string[], users: SeededUser[]): Promise<void> {
  const sampleThreads = [
    {
      inbound: 'Hi, I saw your ad for Skyline Aurum. What is the price for a 3 BHK?',
      outbound: 'Hello! Thanks for reaching out. Our 3 BHK units at Skyline Aurum start at ₹3.4 Cr (1,180 sq.ft carpet). Would you like me to share the detailed cost sheet?',
      reply: 'Yes please. Also what is the possession date?',
      intent: 'pricing_enquiry', sentiment: 'positive',
    },
    {
      inbound: 'Is the 2 BHK in Verdant Greens still available? I visited last week.',
      outbound: 'Hi! Yes, we have 2 BHK units available in Tower C and D. Since you have already visited, I can hold a unit for you for 48 hours. Which floor did you prefer?',
      reply: 'Higher floor, above 12th if possible.',
      intent: 'availability_check', sentiment: 'positive',
    },
    {
      inbound: 'The price seems high compared to the project next door. Can you do better?',
      outbound: 'I understand the concern. Our rate includes the club membership and two covered parking slots, which the neighbouring project charges separately. Let me put together a like-for-like comparison for you.',
      reply: 'Ok send it across.',
      intent: 'price_objection', sentiment: 'negative',
    },
    {
      inbound: 'Please share the payment plan for Meridian Crest.',
      outbound: 'Sure! Meridian Crest offers a Construction Linked Plan: 10% on booking, 20% on agreement, and the balance across construction milestones. Possession is expected in 4 months. Sending the detailed schedule now.',
      reply: 'Thanks, and what about home loan tie-ups?',
      intent: 'payment_plan', sentiment: 'neutral',
    },
    {
      inbound: 'I want to book a site visit this Saturday morning.',
      outbound: 'Wonderful! I have 10:30 AM and 12:00 PM slots open on Saturday. Which works better? I will arrange pickup if needed.',
      reply: '10:30 works. Please arrange pickup from Andheri.',
      intent: 'site_visit_request', sentiment: 'positive',
    },
  ];

  for (const [i, thread] of sampleThreads.entries()) {
    const recordId = i < 3 ? leadIds[i * 4] : customerIds[i];
    const rec = await conn.queryOne<{ label: string; module_name: string; owner_id: string }>(
      `SELECT label, module_name, owner_id FROM ipy_record WHERE id = $1`, [recordId],
    );
    if (!rec) continue;
    const handle = `+9199${String(10000000 + i * 7919).slice(0, 8)}`;
    const lastAt = new Date(Date.now() - (i * 3 + 1) * 3_600_000);

    const conv = await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_conversation
        (channel, handle, contact_name, record_id, record_module, assigned_to, status,
         unread_count, last_message_at, last_message_preview, last_inbound_at,
         window_expires_at, ai_intent, sentiment, ai_summary)
       VALUES ('whatsapp',$1,$2,$3,$4,$5,'open',$6,$7,$8,$7,$9,$10,$11,$12)
       ON CONFLICT (channel, handle) DO NOTHING
       RETURNING id`,
      [
        handle, rec.label, recordId, rec.module_name, rec.owner_id,
        i % 2 === 0 ? 1 : 0, lastAt, thread.reply,
        new Date(lastAt.getTime() + 24 * 3_600_000),
        thread.intent, thread.sentiment,
        `Buyer enquiring about ${thread.intent.replace(/_/g, ' ')}. Awaiting a response from the rep.`,
      ],
    );
    if (!conv) continue;

    const msgs = [
      { dir: 'inbound', body: thread.inbound, at: new Date(lastAt.getTime() - 2 * 3_600_000) },
      { dir: 'outbound', body: thread.outbound, at: new Date(lastAt.getTime() - 1.5 * 3_600_000), ai: true },
      { dir: 'inbound', body: thread.reply, at: lastAt },
    ];
    for (const m of msgs) {
      await conn.query(
        `INSERT INTO ipy_message
          (conversation_id, direction, channel, type, body, status, sent_by, is_ai_generated, created_at, delivered_at, read_at)
         VALUES ($1,$2,'whatsapp','text',$3,$4,$5,$6,$7,$7,$7)`,
        [
          conv.id, m.dir, m.body,
          m.dir === 'outbound' ? 'read' : 'delivered',
          m.dir === 'outbound' ? rec.owner_id : null,
          m.ai ?? false, m.at,
        ],
      );
    }
  }
}

async function seedCalls(conn: Tx, leadIds: string[], users: SeededUser[]): Promise<void> {
  const transcriptSamples = [
    {
      summary: 'Buyer is actively looking in Powai with a ₹3-3.5 Cr budget. Liked the lake-facing units. Main objection is the 18-month possession timeline; asked whether a ready-to-move option exists in the same budget.',
      sentiment: 'positive', ratio: 42,
      objections: ['Possession timeline too long', 'Wants ready-to-move alternative'],
      actions: ['Send Meridian Crest options (possession in 4 months)', 'Share lake-facing unit availability sheet', 'Schedule a site visit for Saturday'],
      disposition: 'Interested', duration: 412,
    },
    {
      summary: 'Buyer was in a meeting and asked to call back tomorrow after 6 PM. Confirmed the budget is around ₹1.2 Cr and they are looking in Sarjapur Road.',
      sentiment: 'neutral', ratio: 68,
      objections: [], actions: ['Call back tomorrow after 6 PM', 'Send Verdant Greens 2 BHK pricing on WhatsApp'],
      disposition: 'Call Back Later', duration: 94,
    },
    {
      summary: 'Buyer has already booked in a competing project last month. Politely declined further follow-up but is open to investment options in the future.',
      sentiment: 'negative', ratio: 55,
      objections: ['Already purchased elsewhere'],
      actions: ['Move to long-term nurture list', 'Tag as investment prospect for future launches'],
      disposition: 'Already Purchased', duration: 138,
    },
    {
      summary: 'Strong intent. Buyer wants to block a 3 BHK corner unit and is ready to pay the token this week. Requested the cost sheet and loan desk contact.',
      sentiment: 'positive', ratio: 38,
      objections: ['Needs 3% negotiation on the base rate'],
      actions: ['Block Tower B corner unit for 7 days', 'Send cost sheet today', 'Connect the buyer to the HDFC loan desk', 'Get discount approval from the Sales Head'],
      disposition: 'Site Visit Scheduled', duration: 587,
    },
  ];

  for (let i = 0; i < 18; i++) {
    const sample = transcriptSamples[i % transcriptSamples.length];
    const leadId = leadIds[(i * 3) % leadIds.length];
    const rec = await conn.queryOne<{ owner_id: string; module_name: string }>(
      `SELECT owner_id, module_name FROM ipy_record WHERE id = $1`, [leadId],
    );
    const started = new Date(Date.now() - (i * 7 + 2) * 3_600_000);
    const direction = i % 4 === 0 ? 'inbound' : 'outbound';
    const answered = i % 6 !== 0;

    await conn.query(
      `INSERT INTO ipy_call
        (direction, from_number, to_number, user_id, record_id, record_module, status,
         duration_seconds, ring_seconds, recording_url, provider, provider_call_id,
         disposition, transcript, ai_summary, ai_sentiment, ai_next_actions, ai_objections,
         ai_talk_ratio, ai_score, ai_analysed_at, started_at, answered_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'demo',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        direction,
        direction === 'outbound' ? '+912240000000' : `+9199${String(10000000 + i * 7919).slice(0, 8)}`,
        direction === 'outbound' ? `+9199${String(10000000 + i * 7919).slice(0, 8)}` : '+912240000000',
        rec?.owner_id ?? users[0].id, leadId, rec?.module_name ?? 'leads',
        answered ? 'completed' : 'no_answer',
        answered ? sample.duration : 0, randInt(i + 77, 4, 22),
        answered ? `https://recordings.example.com/demo/call-${i}.mp3` : null,
        `demo-call-${i}`,
        answered ? sample.disposition : 'Not Reachable',
        answered ? `[00:00] Agent: Good afternoon, am I speaking with the right person about the property enquiry?\n[00:06] Customer: Yes, that's right.\n[00:09] Agent: ${sample.summary.slice(0, 80)}...` : null,
        answered ? sample.summary : null,
        answered ? sample.sentiment : null,
        JSON.stringify(answered ? sample.actions : []),
        JSON.stringify(answered ? sample.objections : []),
        answered ? sample.ratio : null,
        answered ? randInt(i + 55, 55, 92) : null,
        answered ? started : null,
        started,
        answered ? new Date(started.getTime() + 8000) : null,
        answered ? new Date(started.getTime() + sample.duration * 1000) : null,
      ],
    );
  }
}

async function seedTargets(conn: Tx, users: SeededUser[]): Promise<void> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  for (const [i, u] of users.entries()) {
    if (i === 0) continue;
    await conn.query(
      `INSERT INTO ipy_target (user_id, period_type, period_start, period_end, metric, target_value, achieved_value)
       VALUES ($1,'month',$2,$3,'booking_value',$4,$5)`,
      [
        u.id, isoDate(start), isoDate(end),
        (3 + (i % 4)) * CRORE,
        Math.round((3 + (i % 4)) * CRORE * (0.35 + rand(i * 11) * 0.7)),
      ],
    );
  }
}
