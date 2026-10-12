/**
 * Real broker messages, as the FEAWA group writes them, through the whole import.
 *
 * The first listings release passed every unit test and still left the live page empty, because the
 * tests used tidy sentences and production does not. These are the messy ones — decimals in sizes,
 * rates per yard, a size in feet, keycap digits, crore in the thousands, twenty plots to a message,
 * a dispute notice — with the phone numbers made up. The promise is the plain one: nothing is
 * refused, and every message that is a listing becomes one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { importGroupExport } from '../../src/core/market/feed.js';

const marker = `itestreal${Date.now()}`;
let adminId = '';
const day = (() => {
  const now = new Date();
  return `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
})();

const MESSAGES: Array<{ sender: string; text: string }> = [
  { sender: '~ Sachin kumar Tyagi', text: `🏡 *AVAILABLE FOR SALE | HUDA PLOTS & KOTHIS*
📍 *Premium Locations | Faridabad*
🔹 *SECTOR 15A*
• 160 Sq. Yrd | North Facing | ₹3.25 Cr
🔹 *SECTOR 16*
• 160 Sq. Yrd | West Facing | ₹3.95 Cr
• 160 Sq. Yrd | West Facing | ₹3.80 Cr
🔹 *SECTOR 28*
• 552 Sq. Yrd | 52' × 95.6' | Park Facing | ₹8.50 Cr
• 173 Sq. Yrd | West Facing | Double Storey | Near Park | ₹3.60 Cr
• 250 Sq. Yrd | North Facing | Single Storey | Livable Kothi | Market Price
🔹 *SECTOR 65*
• Approx. 250 Sq. Yrd | From ₹3.65 Cr
• Approx. 500 Sq. Yrd | From ₹5.45 Cr
📞 *Sachin Kumar Tyagi*
📱 *9800000001*` },
  { sender: '~ Sachin kumar Tyagi', text: `AVAILABLE FOR SALE – PREMIUM BUILDER PROJECTS | FARIDABAD
📍 BPTP Parkland – Sector 85
• Sizes: 250, 350, 362 & 381 Sq. Yds.
📍 Honour Homes – Sector 89
• Sizes: 132.45 & 137 Sq. Yds.
📍 Neal City – Sector 98
• Size: 160 Sq. Yds.
Malik Squares 📞 9800000001` },
  { sender: 'Amar Pal Tomar DS21', text: `1.For Sale 1050 Sq Yd Plot Main 30 Mtr Wide Sector  Deviding Road Sector-21A Faridabad Demand 25 Cr.
3.For Sale 11 Acre  Agriculture Land 66 Ft Wide Road With Industrial CLU Village-Dudhola Distt-Palwal Demand 7.50 Cr. Per Acre
5.For Sale 200 Sq Yd SF Builder's Floor With Lift/ Stilt Car Parking North Facing Rajauri Garden New Delhi Demand 3.50 Cr.
6.To-let Double Storey 500 Sq Yd Kothi Sector-21A Faridabad Total 8 Bedrooms Rent 1.50 Lac Per Month.
Available Floor Wise Also 75000/-75000/- Per Month.
Contact
Amarpal Singh Tomar
# 9800000002
# 9800000003` },
  { sender: '~ Vishwas Properties', text: `*Confirmed inventory*
1. B-4/? 250 Sq.yd. West Facing @5.20 Cr.
2. PC -250 Sq.yd. West With NOC @4 Cr.
*TDI Coral Plot Sec-84A 154 Sq.yd. West Facing @1.35/Per Sq.yd.*
*Anushree Greens Sec-97 Plot 157 Sq.yd. Park Facing @1.22/Sq.yd. & 125 Sq.yd. North @1.24/Sq.yd.*
*Amolik Blossomwood Sec-97 Plot 139 Sq.yd. East @1.22/Sq.yd. Reg. & 140 Sq.yd. East+Corner @1.27/Sq.yd.*
*Bptp Discovery Flat 3+2Bhk 1570 Sq.ft. Below Top @1.75 Cr. Reg.*
Call:Amar - 9800000004
*VISHWAS PROPERTIES*` },
  { sender: '~ Deepak Sharma', text: `🔴🔴🔴 VERY URGENT REQUIREMENT — RUNNING STEEL PLANT 🔴🔴🔴
💰 BUDGET — UP TO ₹1,200 CRORE
📍 PAN INDIA — ANY LOCATION
Meeting first, documents after.
*CONTACT:-* *DEEPAK SHARMA* *9800000005*` },
  { sender: '~ sanjay dhamija', text: `For sale Huda plot....
Sector -75
👍208 sq yd.... 4 cr.
👍204 sq yd....3.40 cr
Sector 76......
👍169 sq yd....2.90 cr
Corner 24 mt. Road
👍538 sq yd ....6.50cr
👍 540 sq yd....6.80 cr
Corner park facing
Call me
👍Sanjay Dhamija
9800000006
Bhoomi Associates........👍` },
  { sender: 'Devender Anand DS64', text: `✨Plots for sale:-🔊
👉🏾1. Plot no. 2205 sector 65 (west facing )
👉🏾2. Plot no. 2483 sector 62 (south facing)
🌟Other more plots are available
"ANAND REAL ESTATES"🏤
📱9️⃣8️⃣0️⃣0️⃣0️⃣0️⃣0️⃣0️⃣0️⃣7️⃣` },
  { sender: 'Neeraj Joshi DS15', text: 'Sector 25  Industry f or sale 2200 sq yds old construction  build up factory  asking 20 cr if any confirmation requirement  pls cont 9800000008 kamal Joshi properties  sector 15a' },
  { sender: '~ Saurav Narang (Monu)', text: `Available for Sale – Greater Faridabad
🏠 Adore Presidential – 3rd Floor
💰 Demand: ₹57 Lakhs
🏠 Elite – Ground Floor, 180 Sq. Yds., A Block, North Facing
💰 Demand: ₹93 Lakhs
Available for Rent
🏠 Vashisht Heights – 2 BHK
💵 Rent: ₹13,000/month
📞 For Sale, Purchase & Rental Enquiries
SAURAV RAJ PROPERTIES Mob.: 9800000009` },
  { sender: 'Dp Gaba DS21', text: `🚨IMMEDIATE ATTENTION NEEDED🚨
Subject: Dispute against Plot No. 1047 sector-46, Huda plot
• Total Area: 160 Sq. Yards
WARNING: the aforementioned property is currently under dispute. All concerned parties are hereby cautioned.
D.P. Gaba 9800000010` },
  { sender: '~ Arvinder Singh Sandhu', text: `Required Plot For Purchase
250 Sq yd
Sector 15A/16
With NOC
SANDHU PROPERTY 9800000011` },
  { sender: '~ Akshey Vashisht', text: `Required for Purchase
250-300 sq yard Plot
In Sector 75-76-77-78
Budget 1.25L to 1.35L per Sq yard
Non South Facing
Payment Time 20-30 Days` },
  { sender: '~ Mukesh Bhatnagar', text: `AVAILABLE FOR SALE
SCO size 200 sy world street basement with ground Raw rate 3.25 cr
OMAXESUN 79
Vipul Plaza office space shop size 451 sqrfit 1st floor 8k per sqrfit
PURI HUB size 502 sqrfit 7th semi Rate 55 lac
ROYAL RESIDENCY SEC-79 4TH FLOOR 3 BHK SEMI FURNISHED 1925 SQRFIT RATE 2.65 CR` },
];

beforeAll(async () => {
  await registry.warmup();
  adminId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com'`))!.id;
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%${marker}%'`);
  await db.query(`DELETE FROM ipy_market_group WHERE name = 'ITESTREAL Group'`);
});
afterAll(async () => { await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%${marker}%'`); });

describe('real messages through the whole import', () => {
  it('refuses none, and finds the properties in each', async () => {
    const text = MESSAGES.map((m, i) => {
      const [first, ...rest] = `${m.text}\n(${marker} ${i})`.split('\n');
      return `${day}, ${String(9 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')} am - ${m.sender}: ${first}\n${rest.join('\n')}`;
    }).join('\n');
    const outcome = await importGroupExport('ITESTREAL Group', text, adminId);
    expect(outcome.refused).toBe(0);
    expect(outcome.newDeals).toBe(MESSAGES.length);

    const rows = await db.query<{ n: number; sizes: Array<number | null>; is_noise: boolean; body: string }>(
      `SELECT (SELECT count(*)::int FROM ipy_market_listing l WHERE l.post_id = p.id) AS n,
              (SELECT array_agg(l.size_sqyd ORDER BY l.ord) FROM ipy_market_listing l WHERE l.post_id = p.id) AS sizes,
              p.is_noise, p.body
         FROM ipy_market_post p WHERE p.body ILIKE '%${marker}%' ORDER BY p.first_posted_at`,
    );
    expect(rows.rows).toHaveLength(MESSAGES.length);
    const by = (needle: string) => rows.rows.find((row) => row.body.includes(needle))!;

    // Twenty plots to a message are as many rows, each with its own size.
    expect(by('552 Sq. Yrd').sizes).toEqual(expect.arrayContaining([160, 552, 173, 250, 500]));
    expect(by('552 Sq. Yrd').n).toBeGreaterThanOrEqual(8);
    // Decimals are whole yards, and a list of sizes is a property each.
    expect(by('132.45').sizes).toEqual(expect.arrayContaining([132, 137, 160]));
    expect(by('Sizes: 250, 350, 362').sizes).toEqual(expect.arrayContaining([250, 350, 362, 381]));
    // The dispute notice is nobody's listing.
    expect(by('Dispute against').n).toBe(0);
    expect(by('Dispute against').is_noise).toBe(true);
    // Everything else that is a property is at least one.
    for (const needle of ['Confirmed inventory', 'Sector -75', 'Industry f or sale', 'Required Plot For Purchase', 'Available for Sale – Greater Faridabad', '1.For Sale 1050']) {
      expect(by(needle).n, needle).toBeGreaterThanOrEqual(1);
    }
  });

  it('prices a rate per yard as a total, and never reads a rate as the price', async () => {
    const rows = await db.query<{ size_sqyd: number; price_min_lakh: number | null; summary: string }>(
      `SELECT l.size_sqyd, l.price_min_lakh, l.summary FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id
        WHERE p.body ILIKE '%${marker}%' AND p.body ILIKE '%Confirmed inventory%' ORDER BY l.ord`,
    );
    const coral = rows.rows.find((row) => row.size_sqyd === 154);
    // 1.35 lakh a yard on 154 yards.
    expect(Number(coral?.price_min_lakh)).toBeCloseTo(207.9, 1);
    expect(rows.rows.find((row) => row.size_sqyd === 250 && /5\.20/.test(row.summary))?.price_min_lakh).toBe(520);
  });

  it('a second read of the same export reads nothing new and refuses nothing', async () => {
    const again = await importGroupExport('ITESTREAL Group', MESSAGES.map((m, i) => `${day}, 09:00 am - ${m.sender}: ${m.text.split('\n')[0]} (${marker} ${i})`).join('\n'), adminId);
    expect(again.refused).toBe(0);
    expect(again.newDeals).toBe(0);
  });
});
