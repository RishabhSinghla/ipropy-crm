/**
 * The seed never prints a real password into a production log.
 *
 * It did, on every deploy. The last line of the seed read
 * `Password: ${config.seed.adminPassword}`, which in development is the demo
 * password published in this repository and on a live server is the owner's
 * actual one.
 *
 * Render keeps deploy logs, anyone with dashboard access can read them, and a
 * deploy log is the single most copied-and-pasted artefact there is — it goes
 * into chat windows, support tickets and screenshots whenever a build looks
 * wrong. This one had a working login at the bottom of it.
 *
 * Nothing needed the line. It was convenience code that followed the seed from
 * a laptop onto a live server, which is how most of these get there.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SEED = new URL('../src/db/seed/index.ts', import.meta.url).pathname;

describe('the seed', () => {
  it('only prints a password when it is not a live one', () => {
    const source = readFileSync(SEED, 'utf8');

    // The interpolation must sit behind a production check, whatever the
    // surrounding code looks like.
    const printsPassword = /Password: \$\{[^}]*adminPassword[^}]*\}/.test(source);
    if (printsPassword) {
      expect(
        /config\.isProd/.test(source),
        'the password is interpolated into a log line with no production guard '
        + 'anywhere in the file — on a live server that writes a working login '
        + 'into the deploy log',
      ).toBe(true);
    }
  });

  it('says where the password came from instead of what it is', () => {
    // The line is still useful in production: somebody reading the log wants to
    // know the account exists and where its password was set, not the value.
    const source = readFileSync(SEED, 'utf8');
    expect(source).toMatch(/ADMIN_PASSWORD/);
    expect(source).toMatch(/not printed on a live server/i);
  });

  it('keeps printing it in development, where it is the published demo one', () => {
    /*
      Removing it outright would be the wrong fix. Locally the password is
      Admin@123, committed to this repo and printed in the README, and having it
      on screen after a reset saves looking it up. The problem was never the
      line; it was the line running somewhere it should not.
    */
    const source = readFileSync(SEED, 'utf8');
    const elseBranch = source.slice(source.indexOf('} else {'));
    expect(elseBranch).toMatch(/Password: \$\{config\.seed\.adminPassword\}/);
  });
});
