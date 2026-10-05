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
/** One builder, two plots — the case Inventories cannot hold. */
const ONE_MOBILE = '9910534500';

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
    Its own floors with its own marker. This suite asserts on which records come
    back and in what order, which is never a question to ask of whatever the
    seed or another suite happened to leave behind — the rule this repo already
    applies to the dashboard and reachability suites.
  */
  const plotA = `${MARK}A`;
  const plotB = `${MARK}B`;
  for (const [plot, floor, price, status] of [
    [plotA, '1st', 255, 'Available'],
    [plotA, '2nd', 250, 'Available'],
    [plotA, '4th', null, 'Sold'],
    [plotB, '1st', 500, 'Available'],
  ] as const) {
    const res = await makeFloor({
      building_code: plot,
      floor,
      accommodation: '4 BHK',
      floor_status: status,
      owner_name: `${MARK} Chauhan`,
      owner_mobile: ONE_MOBILE,
      plot_size: plot === plotA ? 435.74 : 635.25,
      facing: 'East',
      construction_stage: 'Start',
      ...(price === null ? {} : { demand: price }),
      remarks: MARK,
    });
    expect(res.status, `could not create ${plot} ${floor}: ${res.status} ${res.text}`).toBe(201);
    ids[`${plot}-${floor}`] = res.body.id as string;
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record WHERE label LIKE $1`, [`${MARK}%`]);
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
    // invisible to every profile, which reads as the feature not being built.
    expect(mod!.permissions.view).toBe(true);
    expect(mod!.permissions.create).toBe(true);
  });

  it('names a floor by its plot and its floor, because neither alone identifies one', async () => {
    const res = await request(app)
      .get(`/api/records/builder_floors/${ids[`${MARK}A-2nd`]}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.label).toBe(`${MARK}A 2nd`);
  });
});

describe('one builder, many buildings', () => {
  it('takes four floors on one mobile across two plots', async () => {
    /*
      The reason this is not the Inventories module. There `mobile` is `unique`,
      so the second of these four would be refused and the other three with it.
    */
    const rows = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_e_builder_floors WHERE owner_mobile = $1 AND remarks = $2`,
      [ONE_MOBILE, MARK],
    );
    expect(rows.rows[0]!.count).toBe(4);
  });

  it('refuses the same floor of the same building twice', async () => {
    const again = await makeFloor({
      building_code: `${MARK}A`,
      floor: '2nd',
      accommodation: '3 BHK',
      floor_status: 'Available',
    });
    expect(again.status, again.text).toBe(409);
  });

  it('allows a different floor of the same building', async () => {
    const third = await makeFloor({
      building_code: `${MARK}A`,
      floor: '3rd',
      accommodation: '4 BHK',
      floor_status: 'Available',
      remarks: MARK,
    });
    expect(third.status, third.text).toBe(201);
    ids[`${MARK}A-3rd`] = third.body.id as string;
  });
});

describe('the filters he asked for', () => {
  it('floor wise', async () => {
    const only1st = await listed({ logic: 'AND', conditions: [{ field: 'floor', operator: 'in', value: ['1st'] }] });
    expect(only1st.sort()).toEqual([`${MARK}A 1st`, `${MARK}B 1st`]);
  });

  it('size wise', async () => {
    const big = await listed({ logic: 'AND', conditions: [{ field: 'plot_size', operator: 'greater_than', value: 500 }] });
    expect(big).toEqual([`${MARK}B 1st`]);
  });

  it('price wise, which is per floor and not per building', async () => {
    /*
      `between` reads `value` and `value2`, never an array — an array answers
      zero rows with no error, which reads as "no floors in that budget".
    */
    const band = await listed({
      logic: 'AND',
      conditions: [{ field: 'demand', operator: 'between', value: 240, value2: 260 }],
    });
    // 255 and 250 are two floors of ONE building, at different prices. A record
    // per building could not express this, let alone filter on it.
    expect(band.sort()).toEqual([`${MARK}A 1st`, `${MARK}A 2nd`]);
  });

  it('accommodation wise', async () => {
    const bhk4 = await listed({ logic: 'AND', conditions: [{ field: 'accommodation', operator: 'in', value: ['4 BHK'] }] });
    expect(bhk4.length).toBeGreaterThanOrEqual(4);
  });

  it('and all of them at once', async () => {
    const narrowed = await listed({
      logic: 'AND',
      conditions: [
        { field: 'floor', operator: 'in', value: ['1st', '2nd'] },
        { field: 'accommodation', operator: 'in', value: ['4 BHK'] },
        { field: 'floor_status', operator: 'not_in', value: ['Sold'] },
        { field: 'demand', operator: 'less_than', value: 300 },
      ],
    });
    expect(narrowed.sort()).toEqual([`${MARK}A 1st`, `${MARK}A 2nd`]);
  });
});

describe('a sold floor leaves the list without leaving the CRM', () => {
  it('is out of "On the Market" and in "Sold"', async () => {
    const onMarket = await listed({
      logic: 'AND',
      conditions: [{ field: 'floor_status', operator: 'not_in', value: ['Sold', 'Not for Sale'] }],
    });
    expect(onMarket).not.toContain(`${MARK}A 4th`);

    const sold = await listed({ logic: 'AND', conditions: [{ field: 'floor_status', operator: 'in', value: ['Sold'] }] });
    expect(sold).toEqual([`${MARK}A 4th`]);
  });

  it('and is still openable, with its history, because the row never moved', async () => {
    /*
      "Move on separate folder" is a saved view, not a second table. A sold floor
      keeps its calls, its notes, its photos and its buyer — a record that
      changes table when its status changes is one nobody can find again.
    */
    const res = await request(app)
      .get(`/api/records/builder_floors/${ids[`${MARK}A-4th`]}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.values.floor_status).toBe('Sold');
  });
});

describe('everything a rep already does to a record works on a floor', () => {
  it('takes a note, and the timeline shows it', async () => {
    const id = ids[`${MARK}A-1st`];
    const posted = await request(app)
      .post(`/api/records/builder_floors/${id}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'Builder will take 240 for this floor.' });
    expect(posted.status, posted.text).toBe(201);

    const feed = await request(app)
      .get(`/api/records/builder_floors/${id}/timeline`)
      .set('Authorization', `Bearer ${token}`);
    expect(feed.status).toBe(200);
    expect((feed.body as { type: string }[]).some((e) => e.type === 'comment')).toBe(true);
  });

  it('takes a tag', async () => {
    const res = await request(app)
      .post(`/api/records/builder_floors/${ids[`${MARK}A-1st`]}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tags: ['hot'] });
    expect(res.status, res.text).toBe(200);
  });
});

describe('the brochure a buyer opens', () => {
  it('renders for a floor at all', async () => {
    /*
      `/share/:token` called `loadSharedProperty`, which looks the id up in
      `ipy_e_properties` — so a link minted on any other module answered the same
      404 a revoked link does, saying nothing about why. It reads the link's own
      module now.
    */
    const minted = await request(app)
      .post(`/api/records/builder_floors/${ids[`${MARK}A-2nd`]}/share-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'For a buyer' });
    expect(minted.status, minted.text).toBe(201);

    const page = await request(app).get(`/api/public/share/${minted.body.token}`);
    expect(page.status, page.text).toBe(200);
    expect(page.body.title).toBe(`${MARK}A 2nd`);
  });

  it('never carries the builder\'s bottom price, what the last buyer paid, or an internal note', async () => {
    const minted = await request(app)
      .post(`/api/records/builder_floors/${ids[`${MARK}A-1st`]}/share-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const page = await request(app).get(`/api/public/share/${minted.body.token}`);
    expect(page.status).toBe(200);

    const shared = new Set((page.body.fields as { name: string }[]).map((f) => f.name));
    for (const secret of [
      'expected_price', 'sold_price', 'sold_on', 'floor_status', 'remarks',
      'owner_mobile', 'owner_name', 'price_updated_on',
    ]) {
      expect(shared.has(secret), `${secret} is on the brochure — add it to NEVER_SHARE`).toBe(false);
      expect(page.body.property?.[secret], `${secret}'s value reached the brochure`).toBeUndefined();
    }

    // And it still says the things a brochure is for.
    for (const wanted of ['demand', 'floor', 'accommodation', 'plot_size', 'facing']) {
      expect(shared.has(wanted), `${wanted} should be on the brochure`).toBe(true);
    }
  });
});
