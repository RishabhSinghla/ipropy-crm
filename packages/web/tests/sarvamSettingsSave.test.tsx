// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { api, type IntegrationSummary } from '../src/lib/api';
import { useApp } from '../src/lib/store';
import { ProviderCard } from '../src/pages/admin/IntegrationsAdmin';

it.each(['Save', 'Save settings and sync inbound'])('%s stores edited calling hours with the rest of the Sarvam card', async (saveButton) => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const summary: IntegrationSummary = {
    provider: 'sarvam_voice', kind: 'voice', label: 'Sarvam', isActive: true, status: 'working',
    lastSyncAt: null, lastError: null, credentialFields: {}, config: {
      callStart: '10:00', callEnd: '19:00', batchSize: '25', orgId: 'org', workspaceId: 'workspace',
      syncInboundVersion: 'true', inboundDeploymentId: 'Inbound-test', inboundModule: 'leads',
      agentsByModule: JSON.stringify({ leads: { appId: 'Buyer', appVersion: '9', label: 'Buyer' } }),
    },
  };
  useApp.setState({ modules: [{ name: 'leads', label: 'Leads' }] as never });
  const save = vi.spyOn(api, 'saveIntegration').mockImplementation(async (_provider, patch) => {
    Object.assign(summary.config, patch.config);
    return {} as never;
  });
  const sync = vi.spyOn(api, 'syncSarvamInbound').mockResolvedValue({ enabled: true, version: 9, status: 'active' });
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  const render = async (key: string) => {
    await act(async () => { root.render(<QueryClientProvider client={cache}><MemoryRouter>
      <ProviderCard key={key} summary={summary} />
    </MemoryRouter></QueryClientProvider>); });
  };
  const input = (label: string) => node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const fill = async (label: string, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(label), value);
      input(label).dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  try {
    await render('open');
    await fill('AI calling start time', '11:30');
    await fill('AI calling end time', '22:00');
    await fill('Contacts per AI batch', '40');
    const button = [...node.querySelectorAll('button')].find((item) => item.textContent?.trim() === saveButton)!;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); });
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith('sarvam_voice', expect.objectContaining({ config: expect.objectContaining({
      callStart: '11:30', callEnd: '22:00', batchSize: '40',
      orgId: 'org', agentsByModule: expect.stringContaining('Buyer'),
    }) }));
    expect(sync).toHaveBeenCalledOnce();
    expect(node.textContent).toContain('Inbound deployment verified: v9');
    await render('reopen');
    expect(input('AI calling start time').value).toBe('11:30');
    expect(input('AI calling end time').value).toBe('22:00');
    expect(input('Contacts per AI batch').value).toBe('40');
  } finally {
    await act(async () => { root.unmount(); }); node.remove(); cache.clear(); vi.restoreAllMocks();
  }
});
