// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { useApp } from '../src/lib/store';
import { useLiveCall } from '../src/lib/liveCall';
import { CallDispositionProvider, CallButton } from '../src/components/CallDisposition';
import { CallDeckPanel } from '../src/components/CallDeckPanel';

vi.mock('../src/lib/realtime', () => ({ getSocket: () => null }));
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false }), configurable: true });
});

it('ends and saves a builder row call while another Lead remains selected', async () => {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const phone = { state: 'active', number: '9999999999', updatedSecondsAgo: 0, connectedSecondsAgo: 2, talkedSeconds: null, canEndCall: true, canControlCall: true };
  vi.spyOn(api, 'liveCall').mockImplementation(async () => phone as never);
  vi.spyOn(api, 'module').mockResolvedValue({ fields: [] } as never);
  vi.spyOn(api, 'record').mockImplementation(async (module, id) => ({ label: `${module}/${id}`, values: {} }) as never);
  vi.spyOn(api, 'neighbours').mockResolvedValue({ nextId: null } as never);
  vi.spyOn(api, 'picklist').mockResolvedValue([{ value: 'Call Connected', label: 'Call Connected' }] as never);
  const dial = vi.spyOn(api, 'dialOnPhone').mockResolvedValue({ sent: true, commandId: 'test' });
  vi.spyOn(api, 'dialStatus').mockResolvedValue({ status: 'done', error: null, via: 'app' });
  const hangup = vi.spyOn(api, 'hangUpOnPhone').mockImplementation(async () => {
    phone.state = 'ended';
    await query.invalidateQueries({ queryKey: ['live-call'] });
    return { sent: true };
  });
  const log = vi.spyOn(api, 'logCall').mockResolvedValue({} as never);
  const update = vi.spyOn(api, 'update');
  useApp.setState({ user: { id: 'test-agent' } as never });
  useLiveCall.getState().finish();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); }); };
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === text || item.textContent?.trim() === text);
    expect(button, text).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  try {
    await act(async () => { root.render(<QueryClientProvider client={query}><MemoryRouter>
      <CallDispositionProvider module="leads" recordId="selected-lead" queue={{ nextId: 'next-lead', position: 1, total: 2, url: '/leads' }}>
        <CallButton to="9999999999" recordId="builder-row" module="builder_floors" />
      </CallDispositionProvider>
      <CallDeckPanel module="leads" recordId="selected-lead" />
    </MemoryRouter></QueryClientProvider>); });
    await click('Call 9999999999');
    expect(dial).toHaveBeenCalledWith({ to: '9999999999', module: 'builder_floors', recordId: 'builder-row' });
    expect(useLiveCall.getState().call?.queueUrl).toBeUndefined();
    expect(container.textContent).toContain('builder_floors/builder-row');
    expect(container.textContent).not.toContain('Save & Next');
    await click('End call');
    expect(hangup).toHaveBeenCalledWith({ module: 'builder_floors', recordId: 'builder-row' });
    expect(container.textContent).toContain('Not answered');
    await click('Save & Exit');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ module: 'builder_floors', recordId: 'builder-row' }));
    expect(update).not.toHaveBeenCalled();
    expect(container.textContent).toContain('No call in progress');
    expect(useLiveCall.getState().call).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    query.clear();
    useLiveCall.getState().finish();
    vi.restoreAllMocks();
  }
});
