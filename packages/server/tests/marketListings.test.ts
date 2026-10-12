import { describe, expect, it } from 'vitest';
import { draftsFromAi, listingLines, splitListings } from '../src/core/market/listings.js';
import { readPost } from '../src/core/market/readPost.js';

// Real messages from the FEAWA dealer group, as they stand on the owner's call sheet.
const TYAGI = 'AVAILABLE FOR SALE | HUDA PLOTS – FARIDABAD 🚨\n🎯 PRIME PROPERTIES | SERIOUS BUYERS ONLY\n📍 SECTOR 15A\n160 Sq. Yds | North Facing\n💰 ₹3.25 Cr\n📍 SECTOR 16\n160 Sq. Yds | West Facing\n💰 ₹3.80–3.95 Cr\n📍 SECTOR 19\n350 Sq. Yds | South Facing | Near Park\n💰 ₹6.50 Cr\n📍 SECTOR 28\n350 Sq. Yds | North Facing\n💰 ₹6.50 Cr\n⭐ Two-Side Open Option\n📍 SECTOR 65\n250 / 350 / 500 Sq. Yds\n💰 ₹3.65 Cr / ₹4.75 Cr / ₹5.45 Cr approx.\n📍 SECTOR 62\n160 Sq. Yds | Double Storey | Without Stilt\n💰 ₹2.95 Cr\n━━━━━━━━━━━━━━━━━━\n📲 Looking to Buy?\nSend “HUDA” + Budget + Preferred Sector\nfor exact details & site visit.\nMALIK SQUARES\n Sachin Kumar Tyagi\n📞 9810517238';
const TOMAR = "1.For Sale 1050 Sq Yd Plot Main 30 Mtr Wide Sector  Deviding Road Sector-21A Faridabad Demand 25 Cr.\n2.For Sale Plot 360 Sq Yd Sector-2 Faridabad Demand 4.75 Cr.\n3.For Sale 11 Acre  Agriculture Land 66 Ft Wide Road With Industrial CLU Village-Dudhola Distt-Palwal Demand 7.50 Cr. Per Acre\n4.For Sale Basement & G.F 273 Sq Yd SCO Capital Sector-79 Faridabad Demand 3.30 Cr.\n5.For Sale 200 Sq Yd SF Builder's Floor With Lift/ Stilt Car Parking North Facing Rajauri Garden New Delhi Demand 3.50 Cr.\n6.To-let Double Storey 500 Sq Yd Kothi Sector-21A Faridabad Total 8 Bedrooms Rent 1.50 Lac Per Month.\n7.To-let 502 Sq Yd Double Storey Kothi Sector-21C Faridabad Total 8 Bedrooms Rent 1.50 Lac Per Month \nAvailable Floor Wise Also 75000/-75000/- Per Month.\nContact\nChaudhary Properties\nSector-21C Market Faridabad\nAmarpal Singh Tomar \n# 9899395600\n# 9899305600";
const DHAMIJA = 'For sale Huda plot....\nSector -75\n👍208 sq yd.... 4 cr.\n👍204 sq yd....3.40 cr\nSector 76......\n👍169 sq yd....2.90 cr\n👍204 sq yd....4cr.\nSector 77........\n👍111 sq yd....1.90 cr\nCorner 24 mt. Road\n👍538 sq yd ....6.50cr\nCall me\n👍Sanjay Dhamija\n8527863281\nBhoomi Associates........👍';
const SAURAV = 'Available for Sale – Greater Faridabad\n🏠 Adore Presidential – 3rd Floor\n💰 Demand: ₹57 Lakhs\n🏠 Elite – Ground Floor, 180 Sq. Yds., A Block, North Facing\n💰 Demand: ₹93 Lakhs\nAvailable for Rent\n🏠 Vashisht Heights – 2 BHK\n💵 Rent: ₹13,000/month\n🏠 RPS Palm Drive Builder Floor – 1st Floor\n💵 Rent: ₹25,000/month\nHUDA Properties\n📍 Plot – Sector 16, 250 Sq. Yds.\n💰 Demand: ₹4.75 Crore\n📞 For Sale, Purchase & Rental Enquiries\nSAURAV RAJ PROPERTIES\nMob.: 9999216988';
const DISPUTE = '🚨IMMEDIATE ATTENTION NEEDED🚨\nSubject: Dispute against Plot No. 1047 sector-46, Huda plot\nThis is to inform all Dealer brothers and any potential buyers regarding the property described below:\n• Property Address: Plot No. 1047 Sector-46 Huda plot\n• Total Area: 160 Sq. Yards\nWARNING:\nPlease be advised that the aforementioned property is currently under dispute';
const REQ = '✨🌴🏡URGENT REQUIREMENT 🏡🌴✨\n🛣️ 500 Sq. Yard Plot – Sector 64, Faridabad\n🏠 250 Sq. Yard Plot – Sector 62 / 64 / 65, Faridabad\n📞 Contact: Rohtash Chahal & Associates\n📲 9810047767 - 9910347767';
const ONE = '3 BHK available in Greenfields Colony, ₹1.45 Cr, call 9811012345';
const RATE = 'Required for Purchase 250-300 sq yard Plot In Sector 75-76-77-78 Budget 1.25L to 1.35L per Sq yard Non South Facing';

const known = ['Greenfields Colony', 'Faridabad', 'Delhi'];

describe('one message, many properties', () => {
  it('a broker\'s sector-by-sector list is one listing per property, each with its own sector, size and price', () => {
    const listings = splitListings(TYAGI, known);
    expect(listings.map((l) => [l.placeKeys[0], l.sizeSqYd, l.priceMinLakh])).toEqual([
      ['sector 15a', 160, 325],
      ['sector 16', 160, 380],
      ['sector 19', 350, 650],
      ['sector 28', 350, 650],
      // "250 / 350 / 500 Sq. Yds" beside three prices is three properties.
      ['sector 65', 250, 365],
      ['sector 65', 350, 475],
      ['sector 65', 500, 545],
      ['sector 62', 160, 295],
    ]);
    // Everything in it is a sale, and they are all the dealer's to sell.
    expect(listings.every((l) => l.kind === 'have' && l.purpose === 'sale')).toBe(true);
    // The contact footer is not part of any listing.
    expect(listings.some((l) => /9810517238|MALIK SQUARES/.test(l.summary))).toBe(false);
  });

  it('numbered one-liners are each their own property, and a rental in the same list is a rental', () => {
    const listings = splitListings(TOMAR, known);
    const bySector = (sector: string) => listings.filter((l) => l.placeKeys.includes(sector));
    expect(bySector('sector 21a').map((l) => [l.sizeSqYd, l.purpose])).toEqual([[1050, 'sale'], [500, 'rent']]);
    expect(bySector('sector 21c')[0]).toMatchObject({ sizeSqYd: 502, purpose: 'rent' });
    // Farmland by the acre is nobody's plot in yards; it is left out, not priced at ₹7.5 Cr a yard.
    expect(listings.find((l) => /Acre/i.test(l.summary))).toBeUndefined();
    expect(listings.find((l) => l.sizeSqYd === 200)?.category).toBe('Builder Floor');
    // "Faridabad" on its own is no place.
    expect(listings.every((l) => !l.placeKeys.includes('faridabad'))).toBe(true);
  });

  it('a sector heading carries down onto the lines under it', () => {
    const listings = splitListings(DHAMIJA, known);
    expect(listings.map((l) => [l.placeKeys[0], l.sizeSqYd, l.priceMinLakh])).toEqual([
      ['sector 75', 208, 400], ['sector 75', 204, 340], ['sector 76', 169, 290],
      ['sector 76', 204, 400], ['sector 77', 111, 190], ['sector 77', 538, 650],
    ]);
  });

  it('knows sale from rent by the section a line sits under', () => {
    const listings = splitListings(SAURAV, known);
    const rent = listings.filter((l) => l.purpose === 'rent');
    expect(rent).toHaveLength(2);
    expect(rent[0]!.priceMinLakh).toBeCloseTo(0.13, 2);
    expect(listings.find((l) => l.placeKeys.includes('sector 16'))).toMatchObject({ purpose: 'sale', sizeSqYd: 250, priceMinLakh: 475 });
  });

  it('a requirement for several places names every one of them, in its own listing', () => {
    const listings = splitListings(REQ, known);
    expect(listings).toHaveLength(2);
    expect(listings.every((l) => l.kind === 'want')).toBe(true);
    expect(listings[1]!.placeKeys.sort()).toEqual(['sector 62', 'sector 64', 'sector 65']);
  });

  it('a plain one-line post is one listing, as before', () => {
    expect(splitListings(ONE, known)).toHaveLength(1);
    expect(listingLines(ONE, known)).toBe(1);
  });

  it('a rate per yard on a stated size is a total, and a list of sectors is every one of them', () => {
    const [listing] = splitListings(RATE, known);
    expect(listing!.placeKeys).toEqual(['sector 75', 'sector 76', 'sector 77', 'sector 78']);
    // 1.25 lakh a yard on 275 yards (the middle of 250-300).
    expect(listing!.priceMinLakh).toBeCloseTo(343.75, 1);
  });

  it('a dispute notice is nobody wanting to buy', () => {
    // It has a plot number and a size, and "needed" in its headline; the word lists called it a buyer.
    expect(splitListings(DISPUTE, known)).toEqual([]);
  });
});

describe('the AI model\'s answer is checked before it is trusted', () => {
  it('turns a valid answer into listings and drops anything malformed', () => {
    const drafts = draftsFromAi({
      is_property_post: true,
      listings: [
        { kind: 'have', purpose: 'sale', category: 'Residential Plot', size_sqyd: 160, price_lakh_min: 325, sectors: ['Sector 15A'], summary: '160 yd Sector 15A' },
        { kind: 'maybe', purpose: 'sale' },
        { kind: 'want', purpose: 'rent', category: 'Spaceship', size_sqyd: -5, price_lakh_min: 'free' as unknown as number, sectors: ['21 B'] },
      ],
    }, known)!;
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ kind: 'have', sizeSqYd: 160, priceMinLakh: 325, placeKeys: ['sector 15a'], category: 'Residential Plot' });
    expect(drafts[1]).toMatchObject({ kind: 'want', purpose: 'rent', category: null, sizeSqYd: null, priceMinLakh: null, placeKeys: ['sector 21b'] });
  });

  it('a dispute notice the model calls not-a-listing has none', () => {
    expect(draftsFromAi({ is_property_post: false, listings: [{ kind: 'want' }] }, known)).toEqual([]);
  });

  it('answers null when there is no usable answer, so the rules stand', () => {
    expect(draftsFromAi(null, known)).toBeNull();
    expect(draftsFromAi({}, known)).toBeNull();
  });
});
