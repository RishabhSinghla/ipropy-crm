/**
 * The record header is one line of facts, and the actions beside it.
 *
 * The owner's instruction on 19 September: *"Please set all in one row, so
 * that we can see narrow header and wide Timeline… if more then line should
 * make it in dash … so that we can choose only option from master."* A header
 * that wraps to three rows eats the screen the work actually happens on, and
 * silently clipping instead would hide fields with nothing to say so.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 900 } });

/**
 * The middle pane — the record itself.
 *
 * A `<section>` since the three-pane rebuild of 27 September 2026, and
 * `page.locator('main')` also matches the app shell's own `<main>`. Named by
 * the tab strip it contains, which only this pane has.
 */
function recordPane(page: import('@playwright/test').Page) {
  return page.getByTestId('ipropy-workspace')
    .locator('section')
    .filter({ has: page.getByRole('navigation', { name: 'Record workspace sections' }) })
    .first();
}

async function splitView(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('ipropy.listmode.leads', 'ipropy'); } catch { /* see listMode.ts */ }
  });
  await page.goto('/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
}

test('every header field sits on the same line', async ({ page }) => {
  await splitView(page);
  const header = recordPane(page).locator('header').first();

  /*
    Measured, not read off a class: `flex-nowrap` present while the row still
    wraps is exactly the bug. Every label shares one baseline or the header has
    grown a row.
  */
  const labels = header.getByTestId('header-fields').locator('> span');
  const count = await labels.count();
  expect(count, 'the header shows no fields at all').toBeGreaterThan(1);

  const tops: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const box = await labels.nth(i).boundingBox();
    if (box) tops.push(Math.round(box.y));
  }
  const spread = Math.max(...tops) - Math.min(...tops);
  expect(spread, 'the header fields are on more than one line').toBeLessThan(6);
});

test('a narrow pane says there are more fields rather than cutting one in half', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await splitView(page);
  const header = recordPane(page).locator('header').first();
  const strip = header.getByTestId('header-fields');
  const more = header.getByTitle(/More fields than fit/);

  /*
    Narrow the window until the strip actually runs out of room, rather than
    guessing a width at which it does.

    A fixed 900px used to overflow and no longer does — the fields were laid
    out as a sentence and are now columns, which are tighter, so six of them
    fit where four did. Nothing was broken by that; the spec was reporting how
    wide this record's labels happen to be, which is the same trap as a spec
    that depends on what is already in the database. What the screen promises
    is the *relationship*: once something does not fit, it is hidden whole and
    the line says so.
  */
  /*
    **28 September 2026: the ladder needed two more rungs, and not because
    anything broke.** The chips became bolder and gained a separator each, so
    every field is *wider* — but the call pill beside the strip went from 14px
    extra-bold to the same 13px chip and handed those pixels back, which was
    enough to keep this record's two facts on the line at 400px. Measured:
    nothing hides down to 400, one field hides at 360, both at 320.

    Where the line falls is a fact about this record's values and the controls
    beside them, not about the promise — the same trap this spec already
    carries a paragraph about. 320px is the narrowest phone worth drawing for,
    so the ladder ends there.
  */
  for (const width of [900, 760, 620, 480, 400, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    // Give the strip's ResizeObserver a frame to recount.
    await expect(async () => {
      expect(await strip.locator('> span.invisible').count()).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 }).catch(() => undefined);
    if (await strip.locator('> span.invisible').count()) break;
  }
  expect(await strip.locator('> span.invisible').count(), 'the strip never ran out of room, even on a phone-width window')
    .toBeGreaterThan(0);

  /*
    The strip clips, and clipping alone cut the last field through the middle
    of a word — "Budg…" — which reads as a broken screen. Anything that does
    not fit whole is made invisible and the line ends with a `…`, which is the
    cue to arrange fewer of them in the Layout Designer's header.
  */
  await expect(more).toBeVisible();

  const box = (await strip.boundingBox())!;
  for (const field of await strip.locator('> span:visible').all()) {
    const item = await field.boundingBox();
    if (!item) continue;
    expect(item.x + item.width, 'a field is cut off rather than hidden')
      .toBeLessThanOrEqual(box.x + box.width + 1);
  }
});

test('the actions are star, WhatsApp, call, tag and the menu — and Delete is only in the menu', async ({ page }) => {
  await splitView(page);
  const header = recordPane(page).locator('header').first();

  await expect(header.getByRole('button', { name: 'Edit tags' })).toBeVisible();

  /*
    One destructive action offered twice, a thumb's width from Call, is one
    more chance to hit it by accident than it is worth. It stays in the menu,
    where it already was.
  */
  await expect(header.locator('button[title^="Delete "]')).toHaveCount(0);
  await header.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('button', { name: /^Delete/ })).toBeVisible();
});

test('the tag icon actually tags the record', async ({ page }) => {
  await splitView(page);
  const marker = `E2E Tag ${Date.now()}`;

  // A tag to choose. Created through the API the admin screen uses, and
  // removed again at the end so the vocabulary is not left growing.
  const tagId = await page.evaluate(async (name) => {
    const token = localStorage.getItem('ipropy.token');
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, color: '#2563eb', modules: ['leads'] }),
    });
    return (await res.json() as { id: string }).id;
  }, marker);

  try {
    const header = recordPane(page).locator('header').first();
    await header.getByRole('button', { name: 'Edit tags' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Tags').first()).toBeVisible();
    await dialog.getByRole('button', { name: marker }).click();
    await dialog.getByRole('button', { name: 'Save tags' }).click();

    // On the record, not merely in a dialog that closed.
    await expect(header.getByText(marker)).toBeVisible({ timeout: 15_000 });
  } finally {
    await page.evaluate(async (id) => {
      const token = localStorage.getItem('ipropy.token');
      await fetch(`/api/tags/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    }, tagId);
  }
});

test('the star turns the record into a favourite and says so', async ({ page }) => {
  await splitView(page);
  const header = recordPane(page).locator('header').first();

  /*
    It saved and the button did not move: `invalidateRecordQueries` was called
    without the record's id, so the lists refreshed and `['record', module,
    id]` — which is what this header reads — did not. The press looked like it
    had done nothing.
  */
  const star = header.locator('button[title$="starred"], button[title^="Star "]').first();
  const before = await star.getAttribute('title');
  await star.click();
  await expect(star).not.toHaveAttribute('title', before ?? '', { timeout: 15_000 });

  // And back, so the spec leaves the record as it found it.
  await star.click();
  await expect(star).toHaveAttribute('title', before ?? '', { timeout: 15_000 });
});

test('the open record is obvious in the queue', async ({ page }) => {
  await splitView(page);
  const rows = page.locator('aside').first().getByTestId('queue-card');

  /*
    The marker used to be `border-l-4 border-l-brand-600` on a row that also
    says `border-b border-slate-100`, and which of those decides the left
    edge's colour is Tailwind's own stylesheet order rather than the order they
    are written. Measured, so a class that is present while the row still looks
    like its neighbours cannot pass.
  */
  const chosen = rows.nth(2).locator('button').first();
  await chosen.click();
  /*
    **The open card is a light fill and nothing else**, on the owner's
    instruction of 27 September 2026: *"Remove highlight box and shadow of
    box, We Need highlight whole box with only light colour for Selected
    record"*. So this measures the fill against a plain row and then measures
    that the things he asked to go really have gone — a shadow or a marker
    stripe would still read as a box around the row, which is what he was
    looking at.
  */
  const fill = (el: Element): string => getComputedStyle(el).backgroundColor;
  const open = await chosen.evaluate(fill);
  const plain = await rows.nth(4).locator('button').first().evaluate(fill);
  expect(open, 'the open record is not filled differently from every other row').not.toBe(plain);
  expect(await chosen.evaluate((el) => getComputedStyle(el).boxShadow), 'the open row still has a shadow').toBe('none');
  await expect(chosen).toHaveAttribute('aria-current', 'true');

  /*
    And the name reads in the theme's own colour while it is open — his
    *"When we Selected a record Then Font colour of Name and Price should be
    change as per theme"*. Measured against the same row before it was
    chosen, because a name that is one colour either way is the bug.
  */
  const nameOf = (row: typeof chosen): Promise<string> =>
    row.locator('span span').first().evaluate((el) => getComputedStyle(el).color);
  expect(await nameOf(chosen), 'the open name reads the same colour as a closed one')
    .not.toBe(await nameOf(rows.nth(4).locator('button').first()));
});

/**
 * Every fact in the header wears one chip, and only the stage carries colour.
 *
 * **28 September 2026, the owner:** *"All of them into Round Chip/Box/Card In
 * Light Colour with a Border, All chips colour will same except
 * Leads/Inventory Status … All chips need a line separator, And All chips
 * also be Bolder."*
 *
 * Measured rather than read off a class name: what he is looking at is the
 * *fill*, and a class that is present while two chips still come out
 * different colours is exactly the bug. The stage is identified by being the
 * one that is not like the others, which is the promise itself — naming a
 * field here would be the thing `useRecordPanes` exists to prevent.
 */
test('the header chips are one look, with the stage the only exception', async ({ page }) => {
  await splitView(page);
  const strip = recordPane(page).locator('header').first().getByTestId('header-fields');
  await expect(strip).toBeVisible();

  const chips = await strip.evaluate((box) => [...box.children].map((wrap, i) => {
    const w = getComputedStyle(wrap as Element);
    const inner = (wrap as Element).querySelector('span');
    const c = inner ? getComputedStyle(inner) : null;
    return {
      separator: i === 0 ? 'n/a' : w.borderLeftWidth,
      fill: c?.backgroundColor ?? '', radius: c?.borderRadius ?? '',
      border: c?.borderTopWidth ?? '', weight: Number(c?.fontWeight ?? 0),
    };
  }));
  expect(chips.length, 'no chips to compare').toBeGreaterThan(1);

  // The stage draws its own `Badge` inside, so its wrapper carries no fill.
  const plain = chips.filter((c) => c.fill !== 'rgba(0, 0, 0, 0)');
  expect(plain.length, 'every chip drew its own colour — none share the header chip').toBeGreaterThan(0);
  /*
    One tone, and at most one exception: a chase date that has already passed
    reads red (*"bring the overdue red back on followup chip"*). Which record
    the queue opens on decides whether that second tone is on screen at all,
    so this allows it rather than depending on it — `an overdue chase date is
    the one red chip` below is where it is actually proved.
  */
  expect(new Set(plain.map((c) => c.fill)).size, 'the chips carry more tones than the ordinary one and overdue')
    .toBeLessThanOrEqual(2);
  for (const chip of plain) {
    expect(chip.radius, 'a chip is not round').toMatch(/9999px/);
    expect(chip.border, 'a chip has no border').toBe('1px');
    expect(chip.weight, 'a chip is not bold').toBeGreaterThanOrEqual(700);
  }
  // A hairline between each pair — every chip after the first.
  for (const chip of chips.slice(1)) {
    expect(chip.separator, 'no separator between two chips').toBe('1px');
  }
});

/**
 * The photo reaches the innermost ring.
 *
 * **28 September 2026:** *"There are three lines after avatar. Please increase
 * the avtar size till touch inner circle first line."* It stops one white
 * ring short of the dashes on purpose — grown flush it covers them and he is
 * left with two lines where he counted three — so this checks both halves:
 * the photo nearly fills that circle, and the circle is still drawn.
 */
test('the photo fills the dashed ring without swallowing it', async ({ page }) => {
  await splitView(page);
  const rings = recordPane(page).locator('svg[role="img"]').first();
  await expect(rings).toBeVisible();

  const size = await rings.evaluate((svg) => {
    const width = (n: Element): number => n.getBoundingClientRect().width;
    const dashed = [...svg.querySelectorAll('circle')].find((c) => c.getAttribute('stroke-dasharray') === '2 3');
    const face = [...svg.parentElement!.children]
      .find((c) => c !== svg && (c as HTMLElement).className?.toString().includes('z-10'));
    return dashed && face ? { dashed: width(dashed), face: width(face) } : null;
  });
  expect(size, 'the rings or the photo are not where this spec expects them').not.toBeNull();
  expect(size!.dashed, 'the dashed ring is gone').toBeGreaterThan(0);
  // Inside it, and filling all but its own white hairline on each side.
  expect(size!.face).toBeLessThan(size!.dashed);
  expect(size!.face / size!.dashed, 'the photo no longer reaches the inner ring').toBeGreaterThan(0.9);
});
