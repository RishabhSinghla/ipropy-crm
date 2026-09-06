import { type JSX, useEffect, useRef, useState } from 'react';
/**
 * Brand line and the company's own social accounts.
 *
 * These are settings rather than constants in the code for a specific reason:
 * the seeded URLs were found by public search, not supplied by the business,
 * and more than one plausible iPropy account exists. Somebody has to be able to
 * correct a wrong handle in ten seconds, not in a deploy.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Facebook, Globe, GripVertical, Instagram, Linkedin, MessageCircle, Plus, Save, Trash2, Twitter, Youtube,
} from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { Select, Skeleton, Spinner } from '../../components/ui';

interface SocialLink { platform: string; label: string; url: string }

const PLATFORMS = [
  { value: 'website', label: 'Website' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'x', label: 'X (Twitter)' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'link', label: 'Other' },
];

function PlatformIcon({ platform }: { platform: string }): JSX.Element {
  const c = 'h-4 w-4';
  switch (platform) {
    case 'instagram': return <Instagram className={c} />;
    case 'facebook': return <Facebook className={c} />;
    case 'x': return <Twitter className={c} />;
    case 'linkedin': return <Linkedin className={c} />;
    case 'youtube': return <Youtube className={c} />;
    case 'whatsapp': return <MessageCircle className={c} />;
    default: return <Globe className={c} />;
  }
}

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
  const [links, setLinks] = useState<SocialLink[]>([]);
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
    const raw = byKey.get('social.links');
    setLinks(Array.isArray(raw) ? raw as SocialLink[] : []);
  }, [settings]);

  const update = (index: number, patch: Partial<SocialLink>): void => {
    setLinks((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

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
    // Reject anything that isn't http(s) here as well as on the server: these
    // values end up in an href, where `javascript:` would run in our origin.
    const bad = links.find((l) => l.url.trim() && !/^https?:\/\//i.test(l.url.trim()));
    if (bad) {
      toast.error('Links must start with http:// or https://', bad.url);
      return;
    }

    setSaving(true);
    try {
      await api.saveSettings({
        // The org name renders in the header, the sign-in screen and every
        // email footer; blank reverts it to the server's built-in default.
        'org.name': orgName.trim(),
        'brand.tagline': tagline.trim(),
        'social.links': links
          .filter((l) => l.url.trim())
          .map((l) => ({ platform: l.platform, label: l.label.trim() || l.platform, url: l.url.trim() })),
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
        <h1 className="text-lg font-semibold tracking-tight">Brand &amp; social</h1>
        <p className="text-sm text-muted">
          How iPropy presents itself inside the CRM, and where the team jumps to your own accounts.
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
                <img src={brand.logoUrl} alt="Current logo" className="h-12 w-12 rounded-lg bg-slate-50 object-contain dark:bg-slate-800" />
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

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="label mb-0">Social links</label>
            <button
              className="btn-secondary btn-sm"
              onClick={() => setLinks((prev) => [...prev, { platform: 'instagram', label: 'Instagram', url: '' }])}
            >
              <Plus className="h-3.5 w-3.5" /> Add link
            </button>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            The links below were found by a public web search, not supplied by you — check each
            one opens the right account before the team relies on it. Two iPropy Instagram
            accounts exist (<code>@ipropy_official</code> and <code>@ipropy.floors</code>); only
            the first is seeded.
          </div>

          <ul className="mt-2 space-y-2">
            {links.length === 0 && (
              <li className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-muted dark:border-slate-700">
                No links yet.
              </li>
            )}
            {links.map((link, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                <GripVertical className="hidden h-4 w-4 shrink-0 text-slate-300 sm:block" />
                <span className="shrink-0 text-slate-500"><PlatformIcon platform={link.platform} /></span>
                <div className="w-36 shrink-0">
                  <Select
                    value={link.platform}
                    onChange={(v) => update(i, {
                      platform: v,
                      // Keep the label in step unless it has been customised.
                      label: PLATFORMS.find((p) => p.value === link.platform)?.label === link.label
                        ? PLATFORMS.find((p) => p.value === v)?.label ?? link.label
                        : link.label,
                    })}
                    options={PLATFORMS}
                  />
                </div>
                <input
                  className="input min-w-[8rem] flex-1"
                  value={link.url}
                  onChange={(e) => update(i, { url: e.target.value })}
                  placeholder="https://www.instagram.com/…"
                />
                <a
                  href={/^https?:\/\//i.test(link.url) ? link.url : undefined}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="btn-ghost btn-sm shrink-0 aria-disabled:pointer-events-none aria-disabled:opacity-30"
                  aria-disabled={!/^https?:\/\//i.test(link.url)}
                >
                  Open ↗
                </a>
                <button
                  className="btn-ghost btn-sm shrink-0 text-negative"
                  onClick={() => setLinks((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${link.label}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
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
