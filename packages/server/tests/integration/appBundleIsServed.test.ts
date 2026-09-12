/**
 * The app's screens, offered as something it can fetch without being
 * reinstalled.
 *
 * This is the route that decides whether a change pushed to production reaches
 * the phones. If it stops answering, nothing breaks loudly: the app keeps
 * running the bundle it shipped with and quietly falls further behind the
 * website every deploy, which is the state this was built to end.
 *
 * Unauthenticated on purpose, like the APK download beside it — the app checks
 * before anybody has signed in, and the bundle is the same public JavaScript
 * any browser already downloads from this origin.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { asBytes } from './fixtures.js';

let app: ReturnType<typeof createApp>;

beforeAll(() => { app = createApp(); });

describe('the app bundle endpoint', () => {
  it('answers without a token, because the app asks before anyone signs in', async () => {
    const res = await request(app).get('/api/public/app/bundle');
    expect(res.status, `it answered ${res.status}: ${res.text}`).toBe(200);
  });

  /*
    An API-only server has no built web app, and that is a normal state rather
    than a fault — it must say "nothing to offer" instead of failing, or every
    launch logs an error nobody can act on.
  */
  it('says plainly whether it has a bundle to offer', async () => {
    const res = await request(app).get('/api/public/app/bundle').expect(200);
    expect(typeof res.body.available).toBe('boolean');
    if (res.body.available) {
      expect(res.body.version, 'a bundle on offer must have a version to compare').toBeTruthy();
      expect(res.body.url).toBe('/api/public/app/bundle.zip');
    } else {
      expect(res.body.version).toBeNull();
      expect(res.body.url).toBeNull();
    }
  });

  /*
    The version has to change when the bundle does and not otherwise — it is
    the whole comparison the app makes. Vite fingerprints asset filenames, so
    index.html names a different set after any change.
  */
  it('gives the same version twice for the same bundle', async () => {
    const first = await request(app).get('/api/public/app/bundle').expect(200);
    const second = await request(app).get('/api/public/app/bundle').expect(200);
    expect(second.body.version).toBe(first.body.version);
  });

  it('hands over a zip when it has one, and a 404 when it does not', async () => {
    const manifest = await request(app).get('/api/public/app/bundle').expect(200);
    const res = await asBytes(request(app).get('/api/public/app/bundle.zip'));

    if (!manifest.body.available) {
      expect(res.status, 'no bundle must be a 404, not a 500').toBe(404);
      return;
    }

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('zip');
    /*
      `PK` — the zip magic number. The app unpacks this blindly, so an HTML
      error page served with a zip content type would be unpacked as one and
      leave a blank screen with nothing logged.
    */
    expect(Buffer.from(res.body).subarray(0, 2).toString()).toBe('PK');
  });
});
