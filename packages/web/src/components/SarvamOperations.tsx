import { type JSX, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';

export function SarvamOperations({ config }: { config: Record<string, string> }): JSX.Element {
  const cache = useQueryClient();
  const { modules } = useApp();
  const [batchSize, setBatchSize] = useState(config.batchSize || '25');
  const [start, setStart] = useState(config.callStart || '10:00');
  const [end, setEnd] = useState(config.callEnd || '19:00');
  const [enabled, setEnabled] = useState(config.callingHoursEnabled !== 'false');
  const [deployment, setDeployment] = useState(config.inboundDeploymentId || '');
  const [module, setModule] = useState(config.inboundModule || 'leads');
  const [sync, setSync] = useState(config.syncInboundVersion === 'true');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const save = async (): Promise<void> => {
    if (sync && !deployment.trim()) { toast.error('Add the existing inbound deployment ID from Sarvam.'); return; }
    setBusy(true); setResult('');
    try {
      await api.saveIntegration('sarvam_voice', { config: { batchSize, callStart: start, callEnd: end,
        callingHoursEnabled: String(enabled), inboundDeploymentId: deployment.trim(), inboundModule: module, syncInboundVersion: String(sync) } });
      await cache.invalidateQueries({ queryKey: ['sarvam-policy'] });
      await cache.invalidateQueries({ queryKey: ['sarvam-control'] });
      await cache.invalidateQueries({ queryKey: ['integrations'] });
      setResult('Calling rules saved.');
      if (sync) {
        try {
          const inbound = await api.syncSarvamInbound();
          setResult(`Calling rules saved. Inbound deployment verified: v${inbound.version} · ${inbound.status}. Future CRM version changes sync automatically.`);
        } catch (error) { setResult(`Calling rules saved. Inbound sync needs attention: ${(error as Error).message}`); }
      }
      toast.success('Calling rules saved');
    } catch (error) { toast.error('Could not save calling rules', (error as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="space-y-3 border-t p-4 dark:border-slate-700" aria-label="AI calling rules">
    <h3 className="font-semibold">AI calling rules</h3>
    <p className="text-xs text-muted">These rules apply before every outbound dial, including individual AI calls. An accepted call can finish after the end time. Waiting queues resume during the next allowed window.</p>
    <label className="block text-sm">Contacts per batch<input aria-label="Contacts per AI batch" className="input mt-1 w-full" type="number" min={1} max={200} value={batchSize} onChange={(e) => setBatchSize(e.target.value)} /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Restrict outbound calling hours</label>
    <div className="grid grid-cols-2 gap-3"><label className="text-sm">Start (India time)<input aria-label="AI calling start time" type="time" className="input mt-1 w-full" value={start} onChange={(e) => setStart(e.target.value)} /></label><label className="text-sm">End (India time)<input aria-label="AI calling end time" type="time" className="input mt-1 w-full" value={end} onChange={(e) => setEnd(e.target.value)} /></label></div>
    <p className="text-xs text-muted">Timezone: Asia/Kolkata. Start is included; end is excluded. If end is earlier than start, the window continues overnight.</p>
    <h3 className="pt-2 font-semibold">Inbound callbacks</h3>
    <p className="text-xs text-muted">Recognize a unique caller from current CRM data. Unknown or shared numbers receive a neutral greeting and an identity check. Incoming calls keep their separate Sarvam availability schedule.</p>
    <label className="block text-sm">Inbound CRM module<select aria-label="Inbound CRM module" className="input mt-1 w-full" value={module} onChange={(e) => setModule(e.target.value)}>{modules.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}</select></label>
    <label className="block text-sm">Existing Sarvam inbound deployment ID<input aria-label="Sarvam inbound deployment ID" className="input mt-1 w-full" value={deployment} onChange={(e) => setDeployment(e.target.value)} placeholder="Copy the Deployment ID from Sarvam → Inbound calls" /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />Keep inbound on the live CRM agent version</label>
    <p className="text-xs text-muted">Uses this module’s agent version from the mapping below. Checks every minute. Applying a version briefly pauses and resumes the existing inbound deployment; phone numbers and inbound hours stay as configured.</p>
    <button className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving and verifying…' : 'Save calling rules and sync inbound'}</button>
    {result && <p role="status" className="text-sm">{result}</p>}
  </section>;
}
