import { type JSX } from 'react';
import { useApp } from '../lib/store';

export function SarvamOperations({ config, onChange, onSave, busy, result }: {
  config: Record<string, string>;
  onChange: (config: Record<string, string>) => void;
  onSave: () => void;
  busy: boolean;
  result: string;
}): JSX.Element {
  const { modules } = useApp();
  const batchSize = config.batchSize ?? '25';
  const start = config.callStart ?? '10:00';
  const end = config.callEnd ?? '19:00';
  const enabled = config.callingHoursEnabled !== 'false';
  const deployment = config.inboundDeploymentId ?? '';
  const module = config.inboundModule ?? 'leads';
  const sync = config.syncInboundVersion === 'true';
  const change = (key: string, value: string): void => onChange({ ...config, [key]: value });
  return <section className="space-y-3 border-t p-4 dark:border-slate-700" aria-label="AI calling rules">
    <h3 className="font-semibold">AI calling rules</h3>
    <p className="text-xs text-muted">Either Save button stores all changes on this card. These rules apply before every outbound dial, including individual AI calls. An accepted call can finish after the end time. Waiting queues resume during the next allowed window.</p>
    <label className="block text-sm">Contacts per batch<input aria-label="Contacts per AI batch" className="input mt-1 w-full" type="number" min={1} max={200} value={batchSize} onChange={(e) => change('batchSize', e.target.value)} /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => change('callingHoursEnabled', String(e.target.checked))} />Restrict outbound calling hours</label>
    <div className="grid grid-cols-2 gap-3"><label className="text-sm">Start (India time)<input aria-label="AI calling start time" type="time" className="input mt-1 w-full" value={start} onChange={(e) => change('callStart', e.target.value)} /></label><label className="text-sm">End (India time)<input aria-label="AI calling end time" type="time" className="input mt-1 w-full" value={end} onChange={(e) => change('callEnd', e.target.value)} /></label></div>
    <p className="text-xs text-muted">Timezone: Asia/Kolkata. Start is included; end is excluded. If end is earlier than start, the window continues overnight.</p>
    <h3 className="pt-2 font-semibold">Inbound callbacks</h3>
    <p className="text-xs text-muted">Recognize a unique caller from current CRM data. Unknown or shared numbers receive a neutral greeting and an identity check. Incoming calls keep their separate Sarvam availability schedule.</p>
    <label className="block text-sm">Inbound CRM module<select aria-label="Inbound CRM module" className="input mt-1 w-full" value={module} onChange={(e) => change('inboundModule', e.target.value)}>{modules.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}</select></label>
    <label className="block text-sm">Existing Sarvam inbound deployment ID<input aria-label="Sarvam inbound deployment ID" className="input mt-1 w-full" value={deployment} onChange={(e) => change('inboundDeploymentId', e.target.value)} placeholder="Copy the Deployment ID from Sarvam → Inbound calls" /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync} onChange={(e) => change('syncInboundVersion', String(e.target.checked))} />Keep inbound on the live CRM agent version</label>
    <p className="text-xs text-muted">Uses this module’s agent version from the mapping below. Checks every minute. Applying a version briefly pauses and resumes the existing inbound deployment; phone numbers and inbound hours stay as configured.</p>
    <button className="btn-primary btn-sm" disabled={busy} type="button" onClick={onSave}>{busy ? 'Saving…' : 'Save settings and sync inbound'}</button>
    {result && <p role="status" className="text-sm">{result}</p>}
  </section>;
}
