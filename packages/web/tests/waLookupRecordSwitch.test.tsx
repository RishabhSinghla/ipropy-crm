// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { WhatsAppLookupButton } from '../src/components/WhatsAppLookupButton';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false }), configurable: true });
});

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; vi.restoreAllMocks(); });

const found = (number: string, name: string) => ({
  status: 'on_whatsapp', message: '', number, pushName: name, avatar: null, fromCache: true, matches: [], lookedUpAt: '2026-11-01T00:00:00Z',
});
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

it('switching records closes the popover and never shows or applies the previous record', async () => {
  vi.spyOn(api, 'waLookupStored').mockImplementation(async (n: string) => ({ result: n === '9000010005' ? found('919000010005', 'Old Person') : null }) as never);
  const apply = vi.spyOn(api, 'waLookupApply').mockResolvedValue({ savedName: true, savedPhoto: false });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const show = (id: string, number: string) => act(() => {
    // Same key the Details panel uses, so this is the real switching behaviour.
    root!.render(<QueryClientProvider client={query}><WhatsAppLookupButton key={`leads:${id}:${number}`} module="leads" recordId={id} number={number} /></QueryClientProvider>);
  });

  show('rec-old', '9000010005');
  await flush();
  act(() => { container.querySelector<HTMLButtonElement>('[data-testid="wa-lookup-button"]')!.click(); });
  expect(document.body.textContent).toContain('Old Person');

  show('rec-new', '9000010016');
  await flush();
  expect(document.body.textContent).not.toContain('Old Person');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
