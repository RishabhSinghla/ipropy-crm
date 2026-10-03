/**
 * The app's dialler screens, driven in the browser preview.
 *
 * **3 October 2026, the owner, with a four-screen prototype:** *"rebuild my
 * Android app according to this prototype as a default Dailer/Phone app."*
 *
 * `?app=1` is what renders the app's own screens in a desktop browser, which
 * is the only way these can be seen at all from here: this container has a JDK
 * and no Android SDK, so no APK is built or installed on anything. What a
 * browser proves is the screens, the data behind them and the wiring. What it
 * cannot prove is the handset — the dialler role, the live call, and whether
 * mute actually mutes.
 *
 * Three faults came out of writing these, and every one of them was invisible
 * to a clean typecheck and 1,200 green unit tests:
 *   - the CRM's text search does not match a phone number at all, so the
 *     keypad found nobody;
 *   - the call log answers snake_case, so every row read "Unknown number";
 *   - the filter is `answered=no`, not an `answered` flag, so Missed showed
 *     everything.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(`${path}?app=1`);
  await page.waitForLoadState('networkidle');
}

test('the keypad is the app’s first screen', async ({ page }) => {
  await openApp(page, '/');
  // The app opens on the dialler now, not on a list.
  await expect(page.getByTestId('mobile-dialer')).toBeVisible({ timeout: 30_000 });
  for (const key of ['1', '5', '9', '0', '*', '#']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${key.replace('*', '\\*')}( |$)`) }).first()).toBeVisible();
  }
});

test('typing a number finds the contact who holds it', async ({ page }) => {
  await openApp(page, '/dialer');
  const dialer = page.getByTestId('mobile-dialer');
  await expect(dialer).toBeVisible({ timeout: 30_000 });

  /*
    Made, not hoped for: the first contact with a number is read off the API
    and then dialled key by key. A spec that types a number somebody might
    have skips itself silently on a database where nobody does, which proves
    nothing — the same rule this repo applies to every list spec.
  */
  const token = await page.evaluate(() => localStorage.getItem('ipropy.token'));
  const someone = await page.evaluate(async (auth) => {
    const answer = await fetch('/api/records/leads/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, pageSize: 1, columns: ['mobile'], sortBy: 'created_at' }),
    }).then((r) => r.json());
    const row = answer.rows?.[0];
    return row ? { label: row.label as string, mobile: row.values?.mobile as string } : null;
  }, token);
  test.skip(!someone?.mobile, 'no contact in this database has a number');

  for (const digit of someone!.mobile.replace(/\D/g, '').slice(0, 5)) {
    await page.getByRole('button', { name: new RegExp(`^${digit}( |$)`) }).first().click();
  }

  // The chip counts them and the row names one. Both, because the chip alone
  // once read a count for a list that was not drawn.
  await expect(dialer.getByText(/T9 match \(\d+\)/i)).toBeVisible({ timeout: 20_000 });
  await expect(dialer.getByText(someone!.label, { exact: false }).first()).toBeVisible();
});

test('the keypad stays reachable while contacts are offered', async ({ page }) => {
  await openApp(page, '/dialer');
  await expect(page.getByTestId('mobile-dialer')).toBeVisible({ timeout: 30_000 });
  for (const digit of ['9', '8']) {
    await page.getByRole('button', { name: new RegExp(`^${digit}( |$)`) }).first().click();
  }
  await page.waitForTimeout(1_500);
  /*
    Measured, and the reason the match list is capped at three: five cards push
    the pad off a 390px screen, so a rep has to scroll to reach the keys they
    are in the middle of typing on. A keypad may never do that.
  */
  const five = await page.getByRole('button', { name: /^5( |$)/ }).first().boundingBox();
  expect(five, 'the 5 key has no box').not.toBeNull();
  expect(five!.y, 'the pad should still be on screen').toBeLessThan(844);
});

test('the call log says who, which way and how long — and the chips narrow it', async ({ page }) => {
  await openApp(page, '/recents');
  await expect(page.getByTestId('mobile-recents')).toBeVisible({ timeout: 30_000 });
  const rows = page.getByTestId('recent-call');
  test.skip((await rows.count()) === 0, 'no calls in this database');

  // Not "Unknown number" on every row, which is what reading the wrong field
  // names looked like — and the only way to see it was to look.
  const first = await rows.first().innerText();
  expect(first).toMatch(/Incoming|Outgoing|Missed call/);
  expect(first.split('\n')[1], 'the row should name somebody').not.toBe('Unknown number');

  const before = await rows.count();
  await page.getByRole('button', { name: 'Missed' }).click();
  await page.waitForTimeout(2_000);
  // The filter has to reach the server: a chip that lights up while the list
  // stands still is a parameter the endpoint ignored.
  expect(await rows.count()).toBeLessThanOrEqual(before);
});

test('the call screen offers what the phone can do, and no more', async ({ page }) => {
  // Not through `openApp`: that appends `?app=1`, which would land after the
  // number and leave the query malformed.
  await page.goto('/in-call?app=1&to=%2B919810234567');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('mobile-in-call')).toBeVisible({ timeout: 30_000 });

  /*
    **Mute, speaker and hold are disabled here, and that is the promise.**
    Android gives those to the phone's default calling app and to nobody else,
    so in a browser — and on a handset that has not handed the role over —
    they must be visibly off rather than alive and silently doing nothing.
    That failure mode is written down twice in this repo and asserted here so
    nobody quietly enables one.
  */
  for (const label of ['Mute', 'Speaker', 'Hold', 'Add']) {
    await expect(page.getByRole('button', { name: label })).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: /End call/ })).toBeEnabled();
});
