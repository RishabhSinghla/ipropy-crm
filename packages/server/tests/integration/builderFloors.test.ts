/**
 * Builder Floors — the module behind the owner's own spreadsheet.
 *
 * **5 October 2026**, with "Builder Floors 2026 - Single.pdf": 130 floors across
 * 60 buildings. *"Can you build a new module for builder floor inventory … all
 * floor, building price are not same … if the unit sold then the move on
 * separate folder and we need all filter i.e floor wise, accommodation wise size
 * wise, price wise."*
 *
 * **This suite exists because almost none of it can be caught anywhere else.**
 * A module is seed data and SQL strings: typecheck reads neither, and a unit test
 * with a mocked `db.query` accepts any statement at all. What is asserted here is
 * first that Postgres and the record engine accept the module, then that it keeps
 * the three promises the design turns on:
 *
 * * **One builder's mobile owns many plots.** This is the whole reason the module
 *   exists rather than reusing Inventories, where `mobile` is `unique` — one
 *   number in his sheet owns five buildings, nineteen of whose floors that column
 *   would refuse.
 * * **One floor per building, once.** Plot 2708 has four floors and they are not
 *   duplicates; a second "2708 — 2nd" is the same floor typed twice.
 * * **Nothing internal reaches a brochure.** `defaultShareFields` shares
 *   everything it is not told to withhold, so every new money field is public
 *   until it is named — and `expected_price` is what the builder will actually
 *   take.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

const MARK = `zzbf${Date.now()}`;
/** One builder, three houses — the case Inventories cannot hold. */
const ONE_MOBILE = '9910534500';
/** This suite's own locality, so it asserts on its own rows and nobody else's. */
const LOCALITY = 'Adyar';

let app: ReturnType<typeof createApp>;
let token: string;
const ids: Record<string, string> = {};

async function makeFloor(body: Record<string, unknown>): Promise<request.Response> {
  return request(app)
    .post('/api/records/builder_floors')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

/** How many of this suite's own floors a filter returns, and which. */
async function listed(filter: unknown): Promise<string[]> {
  const res = await request(app)
    .post('/api/records/builder_floors/search')
    .set('Authorization', `Bearer ${token}`)
    .send({ pageSize: 100, search: MARK, filter });
  expect(res.status, `the list answered ${res.status}: ${res.text}`).toBe(200);
  return (res.body.rows as { label: string }[]).map((row) => row.label);
}

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');

  /*
    Its own houses with its own marker — three houses, two builders, one
    locality. This suite asserts on which records come back and in what order,
    which is never a question to ask of whatever the seed or another suite left
    behind.
  */
  const houses = [
    { house_no: `${MARK}-A`, builder_name: `${MARK} Chauhan`, mobile: ONE_MOBILE,
      first_floor_price: 255, second_floor_price: 250, floor_status: 'Available', bedrooms: 4,
      accommodation: '4 BHK', size: 435.74 },
    // The second house on the SAME mobile — nineteen of these would be refused
    // by the Inventories module, which is why this one exists.
    { house_no: `${MARK}-B`, builder_name: `${MARK} Chauhan`, mobile: ONE_MOBILE,
      first_floor_price: 500, top_floor_price: 500, floor_status: 'Available', bedrooms: 4,
      accommodation: '4 BHK', size: 635.25 },
    { house_no: `${MARK}-C`, builder_name: `${MARK} Bindal`, mobile: '9899423088',
      first_floor_price: 245, floor_status: 'Sold', bedrooms: 3, accommodation: '3 BHK', size: 281.83 },
  ];
  for (const house of houses) {
    const res = await makeFloor({ locality: LOCALITY, facing: 'East', remarks: MARK, ...house });
    expect(res.status, `could not create ${house.house_no}: ${res.status} ${res.text}`).toBe(201);
    ids[house.house_no] = res.body.id as string;
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record WHERE label LIKE $1`, [`%${MARK}%`]);
});

describe('the module itself', () => {
  it('is an entity module the client can see and create in', async () => {
    const res = await request(app).get('/api/meta/modules').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const mod = (res.body as { name: string; isEntity: boolean; permissions: { view: boolean; create: boolean } }[])
      .find((m) => m.name === 'builder_floors');
    expect(mod, 'builder_floors is missing from the describe — check ALL in seed/rbac.ts').toBeTruthy();
    expect(mod!.isEntity).toBe(true);
    // A module absent from `ALL` in rbac.ts gets no grant at all and is
    // invisible to every profile including the admin's, which reads as the
    // feature not having been built.
    expect(mod!.permissions.view).toBe(true);
    expect(mod!.permissions.create).toBe(true);
  });

  it('groups all matching houses into one locality even with a one-row page', async () => {
    const res = await request(app).post('/api/records/builder_floors/search')
      .set('Authorization', `Bearer ${token}`)
      .send({ search: MARK, groupBy: 'locality', pageSize: 1, columns: ['locality'] });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.groups.filter((group: { count: number }) => group.count > 0))
      .toEqual([expect.objectContaining({ key: LOCALITY, count: 3 })]);
    expect(res.body.total).toBe(3);
  });

  it('names a house by its locality and house number, because neither alone identifies one', async () => {
    const res = await request(app)
      .get(`/api/records/builder_floors/${ids[`${MARK}-A`]}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.label).toBe(`${LOCALITY} ${MARK}-A`);
  });

  it('carries his table’s columns and none of the retired ones', async () => {
    /*
      The table in the middle pane draws the module's own fields, so a field
      quietly missing is a column quietly missing. And the nine fields the first
      build had are tombstoned *and* deleted — a tombstone alone only stops
      `upsertModule` re-creating one, which is how the module kept a second
      Mobile and a second Size through the first attempt at this.
    */
    const res = await request(app).get('/api/meta/modules/builder_floors').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const names = new Set((res.body.fields as { name: string }[]).map((f) => f.name));
    for (const wanted of [
      'locality', 'house_no', 'builder_name', 'mobile', 'facing', 'size', 'bedrooms',
      'floor_status', 'amenities',
      'first_floor_price', 'second_floor_price', 'third_floor_price', 'fourth_floor_price', 'top_floor_price',
    ]) {
      expect(names.has(wanted), `${wanted} is missing from the table`).toBe(true);
    }
    for (const retired of ['building_code', 'floor', 'owner_mobile', 'owner_name', 'demand', 'plot_size']) {
      expect(names.has(retired), `${retired} came back — check the tombstone AND the delete`).toBe(false);
    }
  });
});

describe('locality is the identity, not the mobile', () => {
  it('takes three houses on two builders in one locality', async () => {
    /*
      The reason this is not the Inventories module. There `mobile` is `unique`,
      so the second house on one builder's number is refused outright.
    */
    const rows = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_e_builder_floors WHERE remarks = $1`,
      [MARK],
    );
    expect(rows.rows[0]!.count).toBe(3);

    const sameMobile = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_e_builder_floors WHERE remarks = $1 AND mobile = $2`,
      [MARK, ONE_MOBILE],
    );
    expect(sameMobile.rows[0]!.count).toBe(2);
  });

  it('refuses the same house in the same locality twice', async () => {
    const again = await makeFloor({
      locality: LOCALITY, house_no: `${MARK}-A`, builder_name: 'Somebody Else',
      mobile: '9999999999', floor_status: 'Available',
    });
    expect(again.status, again.text).toBe(409);
  });

  it('allows the same house number in a different locality', async () => {
    /*
      A house number is only unique *inside* a colony — B-114 exists in half the
      localities in Faridabad. The key is the pair, which is the only reading of
      "duplicate restriction for Locality" that also allows what he asked for in
      the same sentence: multiple units of multiple builders under one locality.
    */
    const elsewhere = await makeFloor({
      locality: 'Baner', house_no: `${MARK}-A`, builder_name: `${MARK} Elsewhere`,
      mobile: '9811000111', floor_status: 'Available', remarks: MARK,
    });
    expect(elsewhere.status, elsewhere.text).toBe(201);
    ids.elsewhere = elsewhere.body.id as string;
  });
});

describe('a price per floor, which is what the table is for', () => {
  it('filters on one floor', async () => {
    const under = await listed({
      logic: 'AND',
      conditions: [{ field: 'second_floor_price', operator: 'less_than', value: 300 }],
    });
    expect(under).toEqual([`${LOCALITY} ${MARK}-A`]);
  });

  it('filters on any floor, which is an OR across the five', async () => {
    /*
      The question the first build claimed this shape could not answer. It can:
      the filter grammar has had OR all along, and each floor is its own column.
    */
    const band = await listed({
      logic: 'OR',
      conditions: ['first', 'second', 'third', 'fourth', 'top'].map((floor) => ({
        field: `${floor}_floor_price`, operator: 'between' as const, value: 240, value2: 260,
      })),
    });
    expect(band.sort()).toEqual([`${LOCALITY} ${MARK}-A`, `${LOCALITY} ${MARK}-C`]);
  });

  it('knows which floors are not for sale, because an empty price says so', async () => {
    // His sheet writes `-`. Nothing is stored, so "floors under 3 crore" cannot
    // count a floor nobody is selling.
    const topFloor = await listed({
      logic: 'AND',
      conditions: [{ field: 'top_floor_price', operator: 'is_not_empty' }],
    });
    expect(topFloor).toEqual([`${LOCALITY} ${MARK}-B`]);
  });
});

describe('the filters he asked for', () => {
  it('one locality, which is the table the middle pane draws', async () => {
    const here = await listed({
      logic: 'AND',
      conditions: [{ field: 'locality', operator: 'equals', value: LOCALITY }],
    });
    expect(here).toHaveLength(3);
  });

  it('size wise', async () => {
    const big = await listed({ logic: 'AND', conditions: [{ field: 'size', operator: 'greater_than', value: 500 }] });
    expect(big).toEqual([`${LOCALITY} ${MARK}-B`]);
  });

  it('accommodation and bedrooms', async () => {
    const bhk4 = await listed({ logic: 'AND', conditions: [{ field: 'accommodation', operator: 'in', value: ['4 BHK'] }] });
    expect(bhk4).toHaveLength(2);
    const beds = await listed({ logic: 'AND', conditions: [{ field: 'bedrooms', operator: 'equals', value: 3 }] });
    expect(beds).toEqual([`${LOCALITY} ${MARK}-C`]);
  });

  it('one builder, every house he owns', async () => {
    const his = await listed({ logic: 'AND', conditions: [{ field: 'mobile', operator: 'contains', value: ONE_MOBILE }] });
    expect(his).toHaveLength(2);
  });
});

describe('a sold house leaves the list without leaving the CRM', () => {
  it('is out of "On the Market" and in "Sold"', async () => {
    const onMarket = await listed({
      logic: 'AND',
      conditions: [{ field: 'floor_status', operator: 'not_in', value: ['Sold', 'Not for Sale'] }],
    });
    expect(onMarket).not.toContain(`${LOCALITY} ${MARK}-C`);

    const sold = await listed({ logic: 'AND', conditions: [{ field: 'floor_status', operator: 'in', value: ['Sold'] }] });
    expect(sold).toEqual([`${LOCALITY} ${MARK}-C`]);
  });

  it('and is still openable, with its history, because the row never moved', async () => {
    const res = await request(app)
      .get(`/api/records/builder_floors/${ids[`${MARK}-C`]}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.values.floor_status).toBe('Sold');
  });
});

describe('everything a rep already does to a record works on a house', () => {
  it('takes a note, and the timeline shows it', async () => {
    const id = ids[`${MARK}-A`];
    const posted = await request(app)
      .post(`/api/records/builder_floors/${id}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'Builder will take 240 for the first floor.' });
    expect(posted.status, posted.text).toBe(201);

    const feed = await request(app)
      .get(`/api/records/builder_floors/${id}/timeline`)
      .set('Authorization', `Bearer ${token}`);
    expect(feed.status).toBe(200);
    expect((feed.body as { type: string }[]).some((e) => e.type === 'comment')).toBe(true);
  });

  it('takes a tag', async () => {
    const res = await request(app)
      .post(`/api/records/builder_floors/${ids[`${MARK}-A`]}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tags: ['hot'] });
    expect(res.status, res.text).toBe(200);
  });
});

describe('the brochure a buyer opens', () => {
  it('renders for a house at all', async () => {
    /*
      `/share/:token` called a Properties-only wrapper, which looks the id up in
      `ipy_e_properties` — so a link minted on any other module answered the same
      404 a revoked link does. It reads the link's own module now.
    */
    const minted = await request(app)
      .post(`/api/records/builder_floors/${ids[`${MARK}-A`]}/share-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'For a buyer' });
    expect(minted.status, minted.text).toBe(201);

    const page = await request(app).get(`/api/public/share/${minted.body.token}`);
    expect(page.status, page.text).toBe(200);
    /*
      **The house number alone, and that is right.** `locality` is in
      `WITHHELD_BY_DEFAULT` — "who and exactly where, the two things a rep sells
      on knowing" — so the colony does not reach a brochure and the title falls
      back to the half of `labelFields` that is shared. Asserted rather than
      corrected: a buyer who has the exact address does not need the agent, and
      an admin who wants it shown can tick Locality in Share settings.
    */
    expect(page.body.title).toBe(`${MARK}-A`);
  });

  it('never carries the bottom price, what the last buyer paid, or an internal note', async () => {
    const minted = await request(app)
      .post(`/api/records/builder_floors/${ids[`${MARK}-B`]}/share-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const page = await request(app).get(`/api/public/share/${minted.body.token}`);
    expect(page.status).toBe(200);

    const shared = new Set((page.body.fields as { name: string }[]).map((f) => f.name));
    for (const secret of [
      'expected_price', 'sold_price', 'sold_on', 'floor_status', 'remarks',
      'mobile', 'builder_name', 'price_updated_on',
    ]) {
      expect(shared.has(secret), `${secret} is on the brochure — add it to NEVER_SHARE`).toBe(false);
      expect(page.body.property?.[secret], `${secret}'s value reached the brochure`).toBeUndefined();
    }

    // And it still says the things a brochure is for — including every floor's price.
    for (const wanted of ['first_floor_price', 'top_floor_price', 'house_no', 'size', 'facing']) {
      expect(shared.has(wanted), `${wanted} should be on the brochure`).toBe(true);
    }
  });
});
