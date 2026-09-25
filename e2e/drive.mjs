/**
 * Open the real app in a real browser, signed in, in one line.
 *
 * Not a test suite — `npx playwright test` is that, and it is the right tool
 * for anything worth keeping. This is for the other half: proving a change
 * actually works before saying it does. On 24 September 2026 that method found
 * three bugs nothing else could see — Save & Next had never once rung the next
 * person, the header shoved itself sideways when Call was pressed, and a
 * record link lost its record a heartbeat after arriving. Typecheck, 1,040
 * unit tests and 692 integration tests were green through all three.
 *
 * It lives here rather than being rewritten each time because two details cost
 * a round trip every single session:
 *
 *  * **The browser.** This container's Playwright and its installed Chromium
 *    disagree about version, so `chromium.launch()` alone fails with "Executable
 *    doesn't exist". The path is found rather than assumed.
 *  * **The login.** The field is labelled "Email or mobile number", not
 *    "Email" — an exact match on the wrong one silently matches nothing and
 *    reads as the app being broken.
 */
import { existsSync, readdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BROWSERS = '/opt/pw-browsers';

/** Whichever Chromium is actually installed here, rather than the one Playwright expects. */
export function chromiumPath() {
  if (!existsSync(BROWSERS)) return undefined;
  const dir = readdirSync(BROWSERS).find((name) => /^chromium-\d+$/.test(name));
  const path = dir && `${BROWSERS}/${dir}/chrome-linux/chrome`;
  return path && existsSync(path) ? path : undefined;
}

/**
 * A signed-in page, and the browser to close when you are done.
 *
 * @param {{ web?: string, email?: string, password?: string, width?: number, height?: number }} options
 */
export async function openApp(options = {}) {
  const web = options.web ?? 'http://localhost:5173';
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({
    viewport: { width: options.width ?? 1440, height: options.height ?? 850 },
  });

  // Anything the page complains about, collected rather than lost — a silent
  // console error is how a broken screen passes for a working one.
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message.slice(0, 200)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 200)}`);
  });

  await page.goto(`${web}/login`);
  await page.getByLabel('Email or mobile number', { exact: true }).fill(options.email ?? 'admin@ipropy.com');
  await page.getByLabel('Password', { exact: true }).fill(options.password ?? 'Admin@123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

  return { browser, page, web, problems };
}

/**
 * Say what happened in the three words that are honest.
 *
 * **"Couldn't tell" is the one that earns its place.** An agent that only has
 * pass and fail will call anything it could not observe a pass, which is the
 * whole reason a feature gets reported as finished when it is not.
 */
export function report(label, outcome, detail = '') {
  const word = { pass: 'PASS', fail: 'FAIL', unknown: "COULDN'T TELL" }[outcome] ?? outcome;
  console.log(`${word.padEnd(13)} ${label}${detail ? ` — ${detail}` : ''}`);
  return outcome;
}
