// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type MarketDealSide, type MarketIntroduction } from '../src/lib/api';
import MarketIntroductions from '../src/components/MarketIntroductions';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false }), configurable: true });
  window.scrollTo = () => undefined;
});

const side = (id: string, kind: 'want' | 'have'): MarketDealSide => ({
  id, postId: `post-${id}`, kind, purpose: 'sale', body: 'Plot for sale sector 91', summary: 'Plot sector 91',
  posterName: 'Test Dealer', posterPhone: '9000000001', groups: ['Test Group'], postedAt: new Date().toISOString(),
  placeKeys: ['sector 91'], sizeSqYd: 250, priceMinLakh: 300, priceMaxLakh: 320, bhk: null, category: 'Residential Plot',
} as unknown as MarketDealSide);

const match = (n: number): MarketIntroduction => ({
  id: `m${n}`, want: side(`w${n}`, 'want'), have: side(`h${n}`, 'have'), score: 0.9, reasons: [], crossGroup: true,
  status: 'new', note: null, jevFit: 0.8,
});

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; vi.restoreAllMocks(); });

async function mount(save: ReturnType<typeof vi.fn>) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, 'marketIntroductions').mockResolvedValue({ total: 2, matches: [match(1), match(2)] } as never);
  vi.spyOn(api, 'marketJevStatus').mockResolvedValue({
    connection: { connected: true, via: 'typesafe', model: null, lastOkAt: null, lastError: null },
    pairings: { total: 2, rated: 2, sure: 2, possible: 0, waiting: 0, gaveUp: 0, checkingNow: 0 },
    messages: { read: 0, waiting: 0, gaveUp: 0 }, today: { calls: 0, failed: 0, tokens: 0, costUsd: 0 }, week: { calls: 0, costUsd: 0 },
  } as never);
  vi.spyOn(api, 'setMarketIntroduction').mockImplementation(save as never);
  const errors: unknown[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={query}><MarketIntroductions /></QueryClientProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  return { container, errors };
}

const press = async (container: HTMLElement, label: string, index = 0) => {
  const buttons = Array.from(container.querySelectorAll('li button')).filter((b) => b.textContent?.trim() === label);
  expect(buttons.length, label).toBeGreaterThan(index);
  await act(async () => { (buttons[index] as HTMLButtonElement).click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
};

// Regression: both buttons swap the card for a one-line note; a hook placed after that early return made React throw #300.
it.each([['Not for us', 'dismissed', 'Marked not for us'], ['Not a real match', 'bad_match', 'Marked not a real match']])(
  '%s saves, marks the card and leaves the screen alive', async (label, status, note) => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    const { container, errors } = await mount(save);
    await press(container, label);
    expect(save).toHaveBeenCalledWith('w1', 'h1', status);
    expect(container.textContent).toContain(note);
    // The other card is still a full card, and nothing threw.
    expect(container.querySelectorAll('li').length).toBe(2);
    expect(container.textContent).not.toContain('Something went wrong');
    expect(errors.filter((e) => String(e).includes('Rendered fewer hooks') || String(e).includes('#300'))).toEqual([]);
    // Undo brings the full card back, which changes the hooks the other way.
    await press(container, 'Undo');
    expect(container.textContent).not.toContain(note);
  });

it('rolls back and says so when the save is refused', async () => {
  const save = vi.fn().mockRejectedValue(new Error('refused'));
  const { container } = await mount(save);
  await press(container, 'Not for us');
  expect(container.textContent).not.toContain('Marked not for us');
  expect(container.querySelectorAll('li').length).toBe(2);
});

it('offers Busy straight after Called and keeps the card', async () => {
  const save = vi.fn().mockResolvedValue({ ok: true });
  const { container } = await mount(save);
  const labels = Array.from(container.querySelectorAll('li')[0]!.querySelectorAll('button')).map((b) => b.textContent?.trim());
  expect(labels.indexOf('Busy')).toBe(labels.indexOf('Called') + 1);
  await press(container, 'Busy');
  expect(save).toHaveBeenCalledWith('w1', 'h1', 'busy');
  expect(container.textContent).toContain('Line was busy');
});
