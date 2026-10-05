import { useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';

type Preview = Awaited<ReturnType<typeof api.contactMergePreview>>;
export function ContactMergeTool() {
  const user = useApp(state => state.user);
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<Array<{ key: string; status: string; details: string }>>([]);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.contactMergeHistory>>>([]);
  if (!user?.isAdmin) return null;
  const scan = async () => {
    setBusy(true); setError(''); setConfirmed(false); setResults([]);
    try { setPreview(await api.contactMergePreview()); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const merge = async () => {
    if (!preview || !confirmed || busy) return;
    setBusy(true); setError('');
    const outcomes: typeof results = [];
    for (const group of preview.groups) {
      try {
        const result = await api.contactMergeGroup(group);
        outcomes.push({ key: group.key, status: 'Merged', details: JSON.stringify(result) });
      } catch (e) {
        outcomes.push({ key: group.key, status: 'Not merged', details: (e as Error).message });
      }
      setResults([...outcomes]);
    }
    setBusy(false); setConfirmed(false);
  };
  const download = () => {
    const blob = new Blob([JSON.stringify({ prepared: preview, results }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'contact-merge-results.json'; link.click(); URL.revokeObjectURL(url);
  };
  const loadHistory = async () => { try { setHistory(await api.contactMergeHistory()); } catch (e) { setError((e as Error).message); } };
  const downloadArchive = async (key: string) => {
    try {
      const archive = await api.contactMergeArchive(key);
      const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `merge-before-after-${key.slice(0, 12)}.json`; link.click(); URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); }
  };
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900" aria-label="Duplicate contact consolidation">
    <h2 className="font-semibold">Merge duplicate contacts into Leads</h2>
    <p className="mt-2 text-sm text-muted">Administrator only. Matches primary and alternate mobile numbers across Leads, Inventory and Associates. Keeps an existing Lead when available; otherwise creates a Lead. Old and new house numbers are combined, tags and history retained. Original source values and relationship ownership are archived in the CRM.</p>
    <button className="btn-secondary mt-3" disabled={busy} onClick={scan}>Preview duplicate merges</button>
    <button className="btn-secondary ml-2 mt-3" disabled={busy} onClick={loadHistory}>Show CRM merge history</button>
    {history.length > 0 && <div className="mt-3 max-h-48 overflow-auto text-sm">{history.map(item => <p key={item.key} className="flex flex-wrap items-center gap-2 border-b py-2"><a className="text-brand-600" href={`/leads?open=${item.survivor_id}`}>{item.label}</a><span>{item.agent} · {new Date(item.created_at).toLocaleString()}</span><button className="btn-secondary text-xs" onClick={() => downloadArchive(item.key)}>Download before/after archive</button></p>)}</div>}
    {preview && <div className="mt-4 space-y-3">
      <p role="status">{preview.groups.length} duplicate groups · {preview.records} records · {preview.review} non-standard number groups excluded</p>
      <div className="max-h-48 overflow-auto rounded-lg border p-2 text-sm">{preview.groups.map(group => <p key={group.key} className="border-b py-2">{group.members.map(member => `${member.label} (${member.module})`).join(' + ')}</p>)}</div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Merge these duplicate groups into Leads and append all different house numbers. Archive source records, preserve tags and retain before/after history.</label>
      <button className="btn-primary" disabled={busy || !confirmed || results.length > 0 || !preview.groups.length} onClick={merge}>Merge all previewed groups</button>
      <p className="text-xs text-muted">Keep this page open while running. Each group commits independently; changed records and incompatible relationships are not merged. A preview refresh finds any groups still remaining. Ordinary record restore does not undo a merge; the retained archive supports supervised recovery.</p>
    </div>}
    {results.length > 0 && <div className="mt-4 space-y-2"><p role="status">Processed {results.length}/{preview?.groups.length} · Merged {results.filter(r => r.status === 'Merged').length} · Not merged {results.filter(r => r.status !== 'Merged').length}{busy ? ' · Running' : ' · Finished'}</p><button className="btn-secondary" onClick={download}>Download merge results</button><div className="max-h-48 overflow-auto text-sm">{results.filter(r => r.status !== 'Merged').map(r => <p key={r.key} className="text-negative">{r.details}</p>)}</div></div>}
    {error && <p role="alert" className="mt-3 text-negative">{error}</p>}
  </section>;
}
