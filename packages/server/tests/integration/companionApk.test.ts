/**
 * Handing the Android app to a phone.
 *
 * Two things here are worth a test rather than a look.
 *
 * **The file has to be found.** The path is anchored to this module rather than
 * to the working directory, because the container starts the server from the
 * repository root and a developer starts it from `packages/server`. A
 * cwd-relative path is right in one of those and silently wrong in the other,
 * and being wrong looks like "no build published" with nothing in the log to
 * say why. That already happened once.
 *
 * **It has to be reachable without signing in.** A rep installs this before the
 * handset has ever seen the CRM, usually by following a link, and a browser
 * following a plain link sends no bearer token. If this route ever drifts
 * behind `requireAuth` the download becomes a 401 that nobody on a phone can
 * diagnose.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';

let app: Express;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
});

describe('the published build', () => {
  it('is found on disk and described', async () => {
    const res = await request(app).get('/api/public/companion');
    expect(res.status).toBe(200);
    // A published APK is committed, so this is not conditional. If it ever
    // fails, either the file went missing or the path broke again.
    expect(res.body.available).toBe(true);
    expect(res.body.build.versionName).toMatch(/^\d+\.\d+\.\d+$/);
    expect(res.body.build.versionCode).toBeGreaterThan(0);
    expect(res.body.build.sizeBytes).toBeGreaterThan(1_000_000);
    expect(res.body.build.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("points at the CRM's own download while no other address is set", async () => {
    const res = await request(app).get('/api/public/companion');
    expect(res.body.url).toBe('/api/public/companion/download');
  });
});

describe('the download', () => {
  it('needs no sign-in, and sends a real APK', async () => {
    const res = await request(app)
      .get('/api/public/companion/download')
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="ipropy-companion-[\d.]+\.apk"/);

    const body = res.body as Buffer;
    // An APK is a zip. Anything else here means an error page was served with a
    // 200, which a phone would happily save and then refuse to install.
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK');

    const meta = await request(app).get('/api/public/companion');
    expect(body.length).toBe(meta.body.build.sizeBytes);
  });

  /*
    The two cases above this used to be three. `companion.apk_url` let an
    administrator redirect the download to a storage bucket; it was empty from
    the day it was added (071) to the day it was removed (143), and the whole
    Companion section of the settings screen existed to ask for it.

    What the third test pinned is worth keeping as a note rather than a test:
    it checked that a value which was not an http(s) address — a typo, or a
    `javascript:` line pasted in by somebody who should not have been pasting —
    could not become a redirect the CRM performed on a public route. There is
    no setting to paste into now, so there is nothing to validate; if the
    bucket day ever comes and this is rebuilt, that check comes back with it.
  */
  it('serves the build it shipped with, whatever is in settings', async () => {
    const res = await request(app).get('/api/public/companion/download').redirects(0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');

    // And the metadata route agrees, rather than naming somewhere else.
    const meta = await request(app).get('/api/public/companion');
    expect(meta.body.url).toBe('/api/public/companion/download');
  });
});
