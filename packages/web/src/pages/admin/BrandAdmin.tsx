import { type JSX, useEffect, useRef, useState } from 'react';
/**
 * The organisation's name, logo, brand line and theme colour.
 *
 * Settings rather than constants, so a rename or a new logo is not a deploy.
 * The social links that were edited here went on 2 October 2026 with the icons
 * they drew in the header — *"get rid of them from CRM and from admin panel"*.
 * The saved `social.links` row is left as it was; nothing in the CRM reads it.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { api, authedFileUrl } from '../../lib/api';
import { applyBrandColour, toast } from '../../lib/store';
import { Skeleton, Spinner } from '../../components/ui';

export default function BrandAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings', 'brand'],
    queryFn: () => api.settings('brand'),
  });

  // The header and sign-in screen draw from this, so the live logo shows here
  // as soon as it is saved rather than after the settings rows reload.
  const { data: brand } = useQuery({ queryKey: ['brand'], queryFn: () => api.brand() });

  const [orgName, setOrgName] = useState('');
  const [tagline, setTagline] = useState('');
  /** The whole CRM's accent colour — buttons, links, chips, focus rings. */
  const [primaryColor, setPrimaryColor] = useState('#6366f1');
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!settings) return;
    const byKey = new Map(settings.map((s) => [(s as { key: string }).key, (s as { value: unknown }).value]));
    // org.name lives under the 'general' category, not 'brand' — the brand
    // query is the one reliable place both halves are always present.
    setOrgName(String(brand?.orgName ?? byKey.get('org.name') ?? ''));
    setTagline(String(byKey.get('brand.tagline') ?? ''));
    setPrimaryColor(String(byKey.get('org.primary_color') ?? '#6366f1'));
  }, [settings]);

  /** The logo goes to the file store, then its URL into a setting — the same
   *  path an avatar takes, so permissions and serving are already handled. */
  const uploadLogo = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) {
      toast.error('Choose an image', `${file.name} is not a picture.`);
      return;
    }
    setLogoBusy(true);
    try {
      const { url } = await api.uploadFile(file);
      await api.saveSettings({ 'org.logo_url': url });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings', 'brand'] }),
        queryClient.invalidateQueries({ queryKey: ['brand'] }),
        queryClient.invalidateQueries({ queryKey: ['public-brand'] }),
      ]);
      toast.success('Logo updated');
    } catch (err) {
      toast.error('Could not update the logo', (err as Error).message);
    } finally {
      setLogoBusy(false);
    }
  };

  const removeLogo = async (): Promise<void> => {
    setLogoBusy(true);
    try {
      await api.saveSettings({ 'org.logo_url': '' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings', 'brand'] }),
        queryClient.invalidateQueries({ queryKey: ['brand'] }),
        queryClient.invalidateQueries({ queryKey: ['public-brand'] }),
      ]);
      toast.success('Logo removed');
    } catch (err) {
      toast.error('Could not remove the logo', (err as Error).message);
    } finally {
      setLogoBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.saveSettings({
        // The org name renders in the header, the sign-in screen and every
        // email footer; blank reverts it to the server's built-in default.
        'org.name': orgName.trim(),
        'brand.tagline': tagline.trim(),
        'org.primary_color': primaryColor,
      });
      toast.success('Brand settings saved');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings', 'brand'] }),
        queryClient.invalidateQueries({ queryKey: ['brand'] }),
        queryClient.invalidateQueries({ queryKey: ['public-brand'] }),
      ]);
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Brand</h1>
        <p className="text-sm text-muted">
          How iPropy presents itself inside the CRM.
        </p>
      </div>

      <div className="card space-y-5 p-5">
        {/* Name and logo: the two things every screen shows. Admin-editable
            for the same reason the tagline is — a rename or a new logo should
            not be a deploy. */}
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[12rem] flex-1 space-y-1">
            <label className="label">Organisation name</label>
            <input
              className="input"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="iPropy"
            />
            <p className="text-2xs text-muted">
              Shown in the header, on the sign-in screen and in message templates.
            </p>
          </div>

          <div className="space-y-1">
            <label className="label">Logo</label>
            <div className="flex items-center gap-3">
              {brand?.logoUrl ? (
                <img src={authedFileUrl(brand.logoUrl)} alt="Current logo" className="h-12 w-12 rounded-lg bg-slate-50 object-contain dark:bg-slate-800" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-50 text-2xs text-muted dark:bg-slate-800">
                  None
                </div>
              )}
              <div className="flex flex-col gap-1">
                <button
                  className="btn-secondary btn-sm"
                  disabled={logoBusy}
                  onClick={() => logoInput.current?.click()}
                >
                  {logoBusy ? <Spinner className="h-3.5 w-3.5" /> : null} Upload logo
                </button>
                {brand?.logoUrl && (
                  <button
                    className="text-left text-2xs text-negative hover:underline"
                    disabled={logoBusy}
                    onClick={() => void removeLogo()}
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={logoInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadLogo(f);
                  // Reset so picking the same file twice still fires a change.
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        </div>

        <div>
          <label className="label">Brand line</label>
          <input
            className="input"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="Builder Floor = iPropy"
          />
          <p className="mt-1 text-2xs text-muted">
            Appears on the sign-in screen and under the sidebar logo.
          </p>
        </div>

        {/* The whole CRM's accent colour. Live-previewed as you pick: the
            buttons and swatch below already wear it, and Save makes it
            everyone's. Blank or the shipped indigo takes the CRM back to
            default without a deploy. */}
        <div>
          <label className="label">Theme colour</label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="color"
              aria-label="Pick the CRM theme colour"
              className="h-10 w-14 cursor-pointer rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-800"
              value={primaryColor}
              onChange={(e) => {
                setPrimaryColor(e.target.value);
                applyBrandColour(e.target.value);
              }}
            />
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs tnum">{primaryColor}</span>
              <button className="btn-secondary btn-sm" onClick={() => { setPrimaryColor('#6366f1'); applyBrandColour(null); }}>
                Reset to default
              </button>
            </div>
            {/* The chosen colour on the very things that will wear it. */}
            <div className="ml-auto flex items-center gap-2">
              <span className="rounded-full px-2.5 py-1 text-2xs font-medium" style={{ background: `${primaryColor}1f`, color: primaryColor }}>
                Accent text
              </span>
              <button type="button" className="btn-primary btn-sm pointer-events-none">A button</button>
            </div>
          </div>
          <p className="mt-1 text-2xs text-muted">
            Buttons, links, chips and focus rings across the CRM follow this colour.
          </p>
        </div>

        <div className="flex justify-end">
          <button className="btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
