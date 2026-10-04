import { useRef, useState, type JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, authedFileUrl } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { Avatar, Dropdown, DropdownItem, Modal } from './ui';

export function CompanyAvatar({ name, logoUrl }: { name: string; logoUrl: string | null }): JSX.Element {
  const { user } = useApp();
  const cache = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (file: File | null): Promise<void> => {
    if (file && !file.type.startsWith('image/')) { toast.error('Choose an image'); return; }
    setBusy(true);
    try {
      const url = file ? (await api.uploadFile(file)).url : '';
      await api.saveSettings({ 'org.logo_url': url });
      await Promise.all(['brand', 'public-brand'].map((key) => cache.invalidateQueries({ queryKey: [key] })));
      toast.success(file ? 'Company photo updated' : 'Company photo removed');
    } catch (error) { toast.error('Could not update company photo', (error as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return <>
    <input ref={input} type="file" accept="image/*" className="hidden" aria-label="Upload company photo" onChange={(event) => { const file = event.target.files?.[0]; if (file) void save(file); }} />
    <Dropdown align="left" trigger={<button disabled={busy} className="shrink-0 rounded-full border-[3px] border-brand-700 p-0.5" aria-label={`Company photo of ${name}`} title="Preview or manage company photo"><Avatar name={name} src={logoUrl} size={36} /></button>}>
      {(close) => <>
        {logoUrl && <DropdownItem onClick={() => { setPreview(true); close(); }}>Preview photo</DropdownItem>}
        {user?.isAdmin && <DropdownItem onClick={() => { input.current?.click(); close(); }}>{logoUrl ? 'Replace company photo' : 'Add company photo'}</DropdownItem>}
        {user?.isAdmin && logoUrl && <DropdownItem danger onClick={() => { void save(null); close(); }}>Remove company photo</DropdownItem>}
        {user?.isAdmin && <DropdownItem onClick={() => { window.location.assign('/admin/brand'); close(); }}>Edit company profile</DropdownItem>}
      </>}
    </Dropdown>
    <Modal open={preview} onClose={() => setPreview(false)} title={name} size="lg">{logoUrl && <img src={authedFileUrl(logoUrl)} alt={name} className="max-h-[65vh] w-full object-contain" />}</Modal>
  </>;
}
