import { type JSX, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight, Building2, CalendarDays, Check, ChevronRight, FileText, Image, MapPin, Plus, Search,
  Trash2, Video, X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { type RecordEnvelope, type ListResult } from '@ipropy/shared';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { Modal, Spinner } from '../components/ui';

type Profile = Record<string, unknown>;
type Masters = Record<string, { value: string; label: string; sortOrder: number; isActive: boolean }[]>;
type ProjectAsset = { id: string; category: string; title: string; url: string; caption: string | null; isCover: boolean };
type Accommodation = { id: string; configuration: string; bedrooms: number | null; areaUnit: string; carpetArea: number | null; builtUpArea: number | null; superBuiltUpArea: number | null; plotArea: number | null; priceMin: number | null; priceMax: number | null };
type ProjectTab = 'overview' | 'accommodation' | 'floor_plan' | 'layout_plan' | 'cluster_plan' | 'availability' | 'location' | 'gallery' | 'videos' | 'documents' | 'pricing' | 'leads_visits';

const TABS: { key: ProjectTab; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'accommodation', label: 'Accommodation' },
  { key: 'floor_plan', label: 'Floor Plans' }, { key: 'layout_plan', label: 'Layout Plans' },
  { key: 'cluster_plan', label: 'Cluster Plans' }, { key: 'availability', label: 'Availability' },
  { key: 'location', label: 'Location' }, { key: 'gallery', label: 'Gallery' },
  { key: 'videos', label: 'Videos' }, { key: 'documents', label: 'Documents' },
  { key: 'pricing', label: 'Pricing' }, { key: 'leads_visits', label: 'Leads & Visits' },
];

const MASTER_FIELD: Record<string, string> = {
  category: 'category', projectType: 'project_type', projectStatus: 'project_status', developer: 'developer',
  state: 'state', city: 'city', locality: 'locality', areaUnit: 'area_unit',
};
const PROFILE_LABELS: Record<string, string> = {
  projectCode: 'Project code', developer: 'Developer / builder', category: 'Category', projectType: 'Project type',
  reraNumber: 'RERA number', reraExpiry: 'RERA expiry', state: 'State', city: 'City', sector: 'Sector',
  locality: 'Locality', address: 'Address', pincode: 'PIN code', landmark: 'Landmark', googleMapsUrl: 'Google Maps link',
  latitude: 'Latitude', longitude: 'Longitude', projectStatus: 'Project status', launchDate: 'Launch date',
  possessionDate: 'Possession date', constructionProgress: 'Construction progress (%)', totalLandArea: 'Total land area',
  areaUnit: 'Area unit', towerCount: 'Towers', blockCount: 'Blocks', floorCount: 'Floors', unitCount: 'Units',
  startingPrice: 'Starting price (₹)', maximumPrice: 'Maximum price (₹)', bookingAmount: 'Booking amount (₹)',
  highlights: 'Highlights', description: 'Project description',
};
const PROFILE_SECTIONS: { title: string; fields: string[] }[] = [
  { title: 'Identity & status', fields: ['projectCode','developer','category','projectType','projectStatus','reraNumber','reraExpiry'] },
  { title: 'Location', fields: ['state','city','sector','locality','address','pincode','landmark','googleMapsUrl','latitude','longitude'] },
  { title: 'Size & timeline', fields: ['totalLandArea','areaUnit','towerCount','blockCount','floorCount','unitCount','launchDate','possessionDate','constructionProgress'] },
  { title: 'Commercial & marketing', fields: ['startingPrice','maximumPrice','bookingAmount','highlights','description'] },
];

function amount(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(number)}` : 'Price on request';
}

export default function ProjectsWorkspace(): JSX.Element {
  const { user } = useApp();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<ProjectTab>('overview');
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<Profile>({});

  const list = useQuery({ queryKey: ['project-workspace', 'list', search], queryFn: () => api.list('projects', { page: 1, pageSize: 200, search: search || undefined, sortBy: 'updated_at', sortDir: 'desc' }) });
  const masters = useQuery({ queryKey: ['project-workspace', 'masters'], queryFn: () => api.request<Masters>('/api/project-workspace/masters') });
  const rows = (list.data as ListResult<RecordEnvelope> | undefined)?.rows ?? [];
  const selected = rows.find((item) => item.id === selectedId) ?? rows[0] ?? null;
  const projectId = selected?.id ?? null;

  const profileQuery = useQuery({
    queryKey: ['project-workspace', projectId, 'profile'],
    queryFn: () => api.request<{ projectId: string; profile: Profile | null }>(`/api/project-workspace/${projectId}/profile`),
    enabled: Boolean(projectId),
  });
  const profile = profileQuery.data?.profile ?? {};
  useEffect(() => { setDraft(profile); }, [projectId, profileQuery.dataUpdatedAt]);

  const saveProfile = useMutation({
    mutationFn: (value: Profile) => api.request<{ profile: Profile }>(`/api/project-workspace/${projectId}/profile`, { method: 'PUT', body: value }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['project-workspace', projectId, 'profile'] });
      toast.success('Project details saved');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not save project details'),
  });
  const createProject = useMutation({
    mutationFn: async (values: { name: string; city: string }) => {
      const created = await api.create('projects', { project_name: values.name, project_status: 'New Launch', city: values.city || undefined });
      await api.request(`/api/project-workspace/${created.id}/profile`, { method: 'PUT', body: { city: values.city || null, projectStatus: 'pre_launch', lifecycle: 'draft' } });
      return created;
    },
    onSuccess: async (created) => {
      setCreateOpen(false); setSelectedId(created.id);
      await client.invalidateQueries({ queryKey: ['project-workspace', 'list'] });
      toast.success('Project created');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not create project'),
  });

  if (list.isLoading || masters.isLoading) return <div className="flex h-full min-h-[60vh] items-center justify-center"><Spinner className="h-6 w-6 text-brand-600" /></div>;
  if (list.isError) return <div className="p-8 text-sm text-red-600">Could not load projects: {list.error.message}</div>;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f5f7fa] dark:bg-slate-950">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-100 p-2.5 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300"><Building2 className="h-5 w-5" /></div>
          <div><h1 className="text-lg font-semibold">Project Explorer</h1><p className="text-xs text-muted">One place for project facts, plans, units and presentations</p></div>
        </div>
        <div className="flex items-center gap-2">
          <label className="relative hidden w-64 sm:block"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><input aria-label="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} className="form-input pl-9" placeholder="Search projects, developer, city…" /></label>
          {user?.capabilities?.includes('records.create') !== false && <button type="button" onClick={() => setCreateOpen(true)} className="btn-primary inline-flex items-center gap-2"><Plus className="h-4 w-4" /> New project</button>}
          <Link to="/admin/project-masters" className="btn-secondary">Project Masters</Link>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-b border-slate-200 bg-white xl:border-b-0 xl:border-r dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between px-4 py-3"><h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Projects</h2><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium dark:bg-slate-800">{list.data?.total ?? 0}</span></div>
          <label className="relative px-3 pb-3 sm:hidden"><Search className="absolute left-6 top-2.5 h-4 w-4 text-slate-400" /><input aria-label="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} className="form-input pl-9" placeholder="Search projects…" /></label>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((row) => {
              const isSelected = selected?.id === row.id;
              const city = row.values.city ?? row.values.locality ?? '';
              return <button key={row.id} type="button" onClick={() => { setSelectedId(row.id); setTab('overview'); }} className={cn('w-full border-t border-slate-100 px-4 py-3 text-left transition-colors dark:border-slate-800', isSelected ? 'bg-violet-50 ring-inset ring-2 ring-violet-500/70 dark:bg-violet-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                <div className="flex items-start justify-between gap-2"><p className="truncate text-sm font-semibold">{row.label}</p><ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" /></div>
                <p className="mt-1 truncate text-xs text-slate-500">{String(row.values.developer || 'Developer not set')}{city ? ` · ${String(city)}` : ''}</p>
                <div className="mt-2 flex items-center justify-between gap-2"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{String(row.values.project_status || 'Draft')}</span><span className="text-[11px] text-slate-400">{new Date(row.updatedAt).toLocaleDateString()}</span></div>
              </button>;
            })}
            {!rows.length && <div className="p-6 text-center text-sm text-muted">No projects yet. Create your first one.</div>}
          </div>
        </aside>

        {selected ? <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <ProjectHero record={selected} profile={profile} />
          <nav aria-label="Project sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-900">
            {TABS.map((item) => <button key={item.key} type="button" onClick={() => setTab(item.key)} className={cn('shrink-0 border-b-2 px-3 py-3 text-xs font-medium transition-colors', tab === item.key ? 'border-violet-600 text-violet-700 dark:text-violet-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>{item.label}</button>)}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {tab === 'overview' && <ProfileEditor profile={profile} draft={draft} setDraft={setDraft} masters={masters.data ?? {}} saving={saveProfile.isPending} onSave={() => saveProfile.mutate(draft)} />}
            {tab === 'accommodation' && <AccommodationPanel projectId={selected.id} masters={masters.data ?? {}} />}
            {['floor_plan','layout_plan','cluster_plan','gallery','videos','documents'].includes(tab) && <AssetPanel projectId={selected.id} tab={tab} />}
            {tab === 'availability' && <AvailabilityPanel projectId={selected.id} />}
            {tab === 'location' && <LocationPanel profile={profile} />}
            {tab === 'pricing' && <PricingPanel profile={profile} />}
            {tab === 'leads_visits' && <LeadsVisitsPanel />}
          </div>
        </main> : <div className="flex min-h-[45vh] items-center justify-center p-8 text-center text-sm text-muted">Select a project to view its details.</div>}
      </div>
      {createOpen && <CreateProjectModal onClose={() => setCreateOpen(false)} busy={createProject.isPending} onCreate={(values) => createProject.mutate(values)} />}
    </div>
  );
}

function ProjectHero({ record, profile }: { record: RecordEnvelope; profile: Profile }): JSX.Element {
  const percent = Number(profile.constructionProgress ?? 0);
  return <div className="relative shrink-0 overflow-hidden border-b border-slate-200 bg-gradient-to-r from-slate-950 via-indigo-950 to-violet-900 px-5 py-5 text-white dark:border-slate-800 sm:px-7">
    <div className="absolute -right-10 -top-24 h-64 w-64 rounded-full border border-white/10" /><div className="absolute -right-2 -top-16 h-48 w-48 rounded-full border border-white/10" />
    <div className="relative flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0"><div className="mb-2 flex items-center gap-2 text-xs text-violet-200"><Building2 className="h-3.5 w-3.5" /> iPROPY · PROJECT EXPLORER</div><h2 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{record.label}</h2><p className="mt-1 text-sm text-indigo-100">{[profile.developer, profile.locality || profile.sector, profile.city].filter(Boolean).join(' · ') || 'Add project location and developer details'}</p></div>
      <div className="grid grid-cols-2 gap-x-7 gap-y-2 text-xs sm:grid-cols-4"><HeroStat label="Category" value={String(profile.category || '—')} /><HeroStat label="Stage" value={String(profile.projectStatus || record.values.project_status || '—')} /><HeroStat label="Starting from" value={amount(profile.startingPrice)} /><HeroStat label="Progress" value={percent ? `${percent}%` : '—'} /></div>
    </div>
    {percent > 0 && <div className="relative mt-4 h-1.5 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full bg-emerald-300" style={{ width: `${Math.min(percent, 100)}%` }} /></div>}
  </div>;
}
function HeroStat({ label, value }: { label: string; value: string }): JSX.Element { return <div><div className="text-[10px] uppercase tracking-wider text-indigo-200">{label}</div><div className="mt-0.5 max-w-36 truncate font-medium">{value}</div></div>; }

function ProfileEditor({ profile, draft, setDraft, masters, saving, onSave }: { profile: Profile; draft: Profile; setDraft: (value: Profile) => void; masters: Masters; saving: boolean; onSave: () => void }): JSX.Element {
  const dirty = JSON.stringify(profile) !== JSON.stringify(draft);
  const set = (key: string, value: unknown): void => setDraft({ ...draft, [key]: value });
  return <div className="mx-auto max-w-6xl space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-base font-semibold">Project information</h3><p className="mt-1 text-xs text-muted">Project-specific details and dropdowns are isolated from CRM lead, contact and inventory masters.</p></div><button type="button" onClick={onSave} disabled={!dirty || saving} className="btn-primary inline-flex items-center gap-2"><Check className="h-4 w-4" />{saving ? 'Saving…' : 'Save changes'}</button></div>
    {PROFILE_SECTIONS.map((section) => <section key={section.title} className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900"><h4 className="mb-4 text-sm font-semibold">{section.title}</h4><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{section.fields.map((key) => <label key={key} className={cn('block', ['address','highlights','description'].includes(key) && 'sm:col-span-2 lg:col-span-3')}><span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">{PROFILE_LABELS[key]}</span>{key === 'address' || key === 'highlights' || key === 'description' ? <textarea rows={key === 'description' ? 4 : 2} value={String(draft[key] ?? '')} onChange={(event) => set(key, event.target.value || null)} className="form-input min-h-20 resize-y" /> : MASTER_FIELD[key] ? <MasterSelect master={MASTER_FIELD[key]!} value={String(draft[key] ?? '')} masters={masters} onChange={(value) => set(key, value || null)} /> : <input type={key.toLowerCase().includes('date') || key === 'reraExpiry' ? 'date' : key.toLowerCase().includes('url') ? 'url' : ['totalLandArea','towerCount','blockCount','floorCount','unitCount','startingPrice','maximumPrice','bookingAmount','constructionProgress','latitude','longitude'].includes(key) ? 'number' : 'text'} min={['constructionProgress'].includes(key) ? 0 : undefined} max={key === 'constructionProgress' ? 100 : undefined} step={['latitude','longitude'].includes(key) ? 'any' : '1'} value={String(draft[key] ?? '')} onChange={(event) => set(key, event.target.value === '' ? null : ['totalLandArea','towerCount','blockCount','floorCount','unitCount','startingPrice','maximumPrice','bookingAmount','constructionProgress','latitude','longitude'].includes(key) ? Number(event.target.value) : event.target.value)} className="form-input" />}</label>)}</div></section>)}
    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900"><h4 className="text-sm font-semibold">Amenities & approvals</h4><p className="mt-1 text-xs text-muted">Comma-separated for now; the dedicated masters remain independently configurable.</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><MultiText label="Amenities" value={Array.isArray(draft.amenities) ? draft.amenities as string[] : []} onChange={(value) => set('amenities', value)} options={masters.amenities ?? []} /><MultiText label="Approvals" value={Array.isArray(draft.approvals) ? draft.approvals as string[] : []} onChange={(value) => set('approvals', value)} options={masters.approvals ?? []} /><MultiText label="Payment plans" value={Array.isArray(draft.paymentPlans) ? draft.paymentPlans as string[] : []} onChange={(value) => set('paymentPlans', value)} options={[]} /></div></section>
  </div>;
}

function MasterSelect({ master, value, masters, onChange }: { master: string; value: string; masters: Masters; onChange: (value: string) => void }): JSX.Element {
  const choices = (masters[master] ?? []).filter((item) => item.isActive);
  return <select value={value} onChange={(event) => onChange(event.target.value)} className="form-input"><option value="">Select…</option>{choices.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>;
}

function MultiText({ label, value, onChange, options }: { label: string; value: string[]; onChange: (value: string[]) => void; options: { label: string }[] }): JSX.Element {
  const [draft, setDraft] = useState('');
  const add = (item: string): void => { const normalized = item.trim(); if (normalized && !value.includes(normalized)) onChange([...value, normalized]); setDraft(''); };
  return <div><span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span><div className="flex flex-wrap gap-1.5">{value.map((item) => <span key={item} className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-xs text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">{item}<button aria-label={`Remove ${item}`} type="button" onClick={() => onChange(value.filter((valueItem) => valueItem !== item))}><X className="h-3 w-3" /></button></span>)}</div><div className="mt-2 flex gap-2"><input list={`${label}-master`} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(draft); } }} className="form-input" placeholder={`Add ${label.toLowerCase()}`} /><datalist id={`${label}-master`}>{options.map((item) => <option key={item.label} value={item.label} />)}</datalist><button type="button" onClick={() => add(draft)} className="btn-secondary"><Plus className="h-4 w-4" /></button></div></div>;
}

function CreateProjectModal({ onClose, onCreate, busy }: { onClose: () => void; onCreate: (values: { name: string; city: string }) => void; busy: boolean }): JSX.Element {
  const [name, setName] = useState(''); const [city, setCity] = useState('');
  return <Modal open title="Create a Project" onClose={onClose} size="md"><form onSubmit={(event) => { event.preventDefault(); onCreate({ name: name.trim(), city: city.trim() }); }} className="space-y-4"><p className="text-sm text-muted">Start with a name. The Project Explorer will keep all project-specific details in its own workspace.</p><label className="block"><span className="mb-1 block text-xs font-medium">Project name</span><input required autoFocus value={name} onChange={(event) => setName(event.target.value)} className="form-input" placeholder="e.g. Premium Residences" /></label><label className="block"><span className="mb-1 block text-xs font-medium">City</span><input value={city} onChange={(event) => setCity(event.target.value)} className="form-input" placeholder="Faridabad" /></label><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-secondary">Cancel</button><button disabled={busy || !name.trim()} type="submit" className="btn-primary">{busy ? 'Creating…' : 'Create project'}</button></div></form></Modal>;
}

function AccommodationPanel({ projectId, masters }: { projectId: string; masters: Masters }): JSX.Element {
  const client = useQueryClient(); const [newName, setNewName] = useState(''); const [area, setArea] = useState(''); const [unit, setUnit] = useState('sqft'); const [priceMin, setPriceMin] = useState(''); const [priceMax, setPriceMax] = useState('');
  const query = useQuery({ queryKey: ['project-workspace', projectId, 'accommodations'], queryFn: () => api.request<Accommodation[]>(`/api/project-workspace/${projectId}/accommodations`) });
  const create = useMutation({ mutationFn: () => api.request<{ id: string }>(`/api/project-workspace/${projectId}/accommodations`, { method: 'POST', body: { configuration: newName, areaUnit: unit, carpetArea: area ? Number(area) : null, priceMin: priceMin ? Number(priceMin) : null, priceMax: priceMax ? Number(priceMax) : null } }), onSuccess: async () => { setNewName(''); setArea(''); setPriceMin(''); setPriceMax(''); await client.invalidateQueries({ queryKey: ['project-workspace', projectId, 'accommodations'] }); toast.success('Configuration added'); }, onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not add accommodation') });
  const remove = useMutation({ mutationFn: (id: string) => api.request(`/api/project-workspace/${projectId}/accommodations/${id}`, { method: 'DELETE' }), onSuccess: () => client.invalidateQueries({ queryKey: ['project-workspace', projectId, 'accommodations'] }) });
  return <Section title="Accommodation configurations" subtitle="Keep every BHK, layout and area variant under this project."><div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900"><tr>{['Configuration','Carpet area','Unit','Price range',''].map((label) => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead><tbody>{query.data?.map((item) => <tr key={item.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-3 font-medium">{item.configuration}</td><td className="px-4 py-3">{item.carpetArea ?? '—'}</td><td className="px-4 py-3">{item.areaUnit}</td><td className="px-4 py-3">{item.priceMin || item.priceMax ? `${amount(item.priceMin)} – ${amount(item.priceMax)}` : 'On request'}</td><td className="px-4 py-3 text-right"><button type="button" onClick={() => remove.mutate(item.id)} aria-label="Remove accommodation" className="btn-icon text-red-500"><Trash2 className="h-4 w-4" /></button></td></tr>)}</tbody></table>{!query.data?.length && <p className="px-4 py-6 text-center text-sm text-muted">Add the project's first accommodation option below.</p>}</div><div className="mt-4 grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-[1.2fr_1fr_.8fr_1fr_1fr_auto] dark:bg-slate-900"><input value={newName} onChange={(event) => setNewName(event.target.value)} className="form-input" placeholder="2 BHK / Studio / Plot" /><input type="number" min="0" value={area} onChange={(event) => setArea(event.target.value)} className="form-input" placeholder="Carpet area" /><select value={unit} onChange={(event) => setUnit(event.target.value)} className="form-input">{(masters.area_unit ?? []).filter((item) => item.isActive).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><input type="number" min="0" value={priceMin} onChange={(event) => setPriceMin(event.target.value)} className="form-input" placeholder="Min price" /><input type="number" min="0" value={priceMax} onChange={(event) => setPriceMax(event.target.value)} className="form-input" placeholder="Max price" /><button disabled={!newName.trim() || create.isPending} type="button" onClick={() => create.mutate()} className="btn-primary inline-flex items-center justify-center gap-1"><Plus className="h-4 w-4" /> Add</button></div></Section>;
}

function AssetPanel({ projectId, tab }: { projectId: string; tab: ProjectTab }): JSX.Element {
  const client = useQueryClient(); const [title, setTitle] = useState(''); const [url, setUrl] = useState(''); const [caption, setCaption] = useState('');
  const categoryByTab: Partial<Record<ProjectTab, string>> = { floor_plan: 'floor_plan', layout_plan: 'layout_plan', cluster_plan: 'cluster_plan', gallery: 'gallery', videos: 'video', documents: 'document' };
  const category = categoryByTab[tab]!;
  const titles: Partial<Record<ProjectTab, string>> = { floor_plan: 'Floor plans', layout_plan: 'Layout plans', cluster_plan: 'Cluster plans', gallery: 'Gallery', videos: 'Videos & virtual tours', documents: 'Documents & brochures' };
  const query = useQuery({ queryKey: ['project-workspace', projectId, 'assets'], queryFn: () => api.request<ProjectAsset[]>(`/api/project-workspace/${projectId}/assets`) });
  const assets = (query.data ?? []).filter((item) => item.category === category);
  const create = useMutation({ mutationFn: () => api.request(`/api/project-workspace/${projectId}/assets`, { method: 'POST', body: { category, title, url, caption: caption || null, isCover: false } }), onSuccess: async () => { setTitle(''); setUrl(''); setCaption(''); await client.invalidateQueries({ queryKey: ['project-workspace', projectId, 'assets'] }); toast.success('Project item added'); }, onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not add item') });
  const remove = useMutation({ mutationFn: (id: string) => api.request(`/api/project-workspace/${projectId}/assets/${id}`, { method: 'DELETE' }), onSuccess: () => client.invalidateQueries({ queryKey: ['project-workspace', projectId, 'assets'] }) });
  const icon = category === 'video' ? <Video className="h-5 w-5" /> : category === 'document' ? <FileText className="h-5 w-5" /> : <Image className="h-5 w-5" />;
  return <Section title={titles[tab] ?? 'Project media'} subtitle="Add approved URLs for plans, images, videos and project documents. Removed entries are archived, not erased."><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{assets.map((asset) => <article key={asset.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"><div className="flex h-32 items-center justify-center bg-slate-100 text-slate-400 dark:bg-slate-800">{category === 'gallery' && /\.(png|jpe?g|webp|gif)(?:\?|$)/i.test(asset.url) ? <img src={asset.url} alt={asset.caption || asset.title} className="h-full w-full object-cover" /> : icon}</div><div className="p-3"><div className="flex items-start justify-between gap-2"><h4 className="truncate text-sm font-medium">{asset.title}</h4><button type="button" onClick={() => remove.mutate(asset.id)} aria-label="Archive item" className="btn-icon h-7 w-7 text-red-500"><Trash2 className="h-3.5 w-3.5" /></button></div>{asset.caption && <p className="mt-1 line-clamp-2 text-xs text-muted">{asset.caption}</p>}<a href={asset.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-violet-700 hover:underline dark:text-violet-300">Open item <ArrowUpRight className="h-3 w-3" /></a></div></article>)}</div>{!assets.length && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-muted">No items added in this section yet.</div>}<form className="mt-5 grid gap-2 rounded-xl bg-white p-4 sm:grid-cols-[1fr_2fr_1.5fr_auto] dark:bg-slate-900" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><input required value={title} onChange={(event) => setTitle(event.target.value)} className="form-input" placeholder="Title" /><input required type="url" value={url} onChange={(event) => setUrl(event.target.value)} className="form-input" placeholder="Image, video, PDF or map URL" /><input value={caption} onChange={(event) => setCaption(event.target.value)} className="form-input" placeholder="Caption (optional)" /><button disabled={create.isPending} className="btn-primary inline-flex items-center justify-center gap-1"><Plus className="h-4 w-4" /> Add</button></form></Section>;
}

function AvailabilityPanel({ projectId }: { projectId: string }): JSX.Element {
  const client = useQueryClient(); const [term, setTerm] = useState(''); const [results, setResults] = useState<RecordEnvelope[]>([]);
  const linked = useQuery({ queryKey: ['project-workspace', projectId, 'inventory-links'], queryFn: () => api.request<RecordEnvelope[]>(`/api/project-workspace/${projectId}/inventory-links`) });
  const searchInventory = async (): Promise<void> => { try { const data = await api.list('properties', { page: 1, pageSize: 12, search: term }); setResults(data.rows); } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not search Inventory'); } };
  const add = useMutation({ mutationFn: (id: string) => api.request(`/api/project-workspace/${projectId}/inventory-links`, { method: 'POST', body: { inventoryRecordIds: [id] } }), onSuccess: () => client.invalidateQueries({ queryKey: ['project-workspace', projectId, 'inventory-links'] }), onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not link Inventory') });
  const remove = useMutation({ mutationFn: (id: string) => api.request(`/api/project-workspace/${projectId}/inventory-links/${id}`, { method: 'DELETE' }), onSuccess: () => client.invalidateQueries({ queryKey: ['project-workspace', projectId, 'inventory-links'] }) });
  return <Section title="Linked Inventory" subtitle="Units link to their original CRM Inventory record IDs; the Project module never creates duplicate units."><form className="mb-4 flex gap-2" onSubmit={(event) => { event.preventDefault(); void searchInventory(); }}><input value={term} onChange={(event) => setTerm(event.target.value)} className="form-input" placeholder="Search Inventory by name, house number, locality…" /><button className="btn-secondary inline-flex items-center gap-1"><Search className="h-4 w-4" /> Search</button></form>{results.length > 0 && <div className="mb-4 divide-y rounded-xl border border-slate-200 dark:border-slate-800">{results.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 p-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{item.label}</p><p className="truncate text-xs text-muted">{String(item.values.locality ?? '')}{item.values.house_no ? ` · ${String(item.values.house_no)}` : ''}</p></div><button type="button" onClick={() => add.mutate(item.id)} disabled={add.isPending || linked.data?.some((x) => x.id === item.id)} className="btn-secondary text-xs">{linked.data?.some((x) => x.id === item.id) ? 'Linked' : 'Link unit'}</button></div>)}</div>}<div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">{linked.data?.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 border-b border-slate-100 p-3 last:border-0 dark:border-slate-800"><div className="min-w-0"><p className="truncate text-sm font-medium">{item.label}</p><p className="truncate text-xs text-muted">{String(item.values.locality ?? '')}{item.values.house_no ? ` · ${String(item.values.house_no)}` : ''} · {String(item.values.status ?? 'Status not set')}</p></div><button type="button" onClick={() => remove.mutate(item.id)} className="btn-icon text-red-500" aria-label="Unlink unit"><X className="h-4 w-4" /></button></div>)}{!linked.data?.length && <p className="p-6 text-center text-sm text-muted">No Inventory units linked yet. Search above to add existing units.</p>}</div></Section>;
}

function LocationPanel({ profile }: { profile: Profile }): JSX.Element {
  const url = String(profile.googleMapsUrl ?? '');
  const address = [profile.address, profile.landmark, profile.locality, profile.sector, profile.city, profile.state, profile.pincode].filter(Boolean).join(', ');
  return <Section title="Project location" subtitle="Project address and map link are stored on the Project profile."><div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"><MapPin className="h-5 w-5 text-violet-600" /><h3 className="mt-3 text-sm font-semibold">{String(profile.locality || profile.city || 'Location not set')}</h3><p className="mt-1 text-sm text-muted">{address || 'Add address details in Overview.'}</p>{url && <a href={url} target="_blank" rel="noreferrer" className="btn-secondary mt-4 inline-flex items-center gap-2">Open in Google Maps <ArrowUpRight className="h-4 w-4" /></a>}</div><div className="rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-muted">Add the Google Maps URL or coordinates in Overview to give your team one-click directions.</div></div></Section>;
}
function PricingPanel({ profile }: { profile: Profile }): JSX.Element { return <Section title="Project pricing" subtitle="Price guidance and booking amount are separate from unit-specific Inventory prices."><div className="grid gap-3 sm:grid-cols-3">{[['Starting price',profile.startingPrice],['Maximum price',profile.maximumPrice],['Booking amount',profile.bookingAmount]].map(([label,value]) => <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"><p className="text-xs text-muted">{String(label)}</p><p className="mt-2 text-xl font-semibold">{amount(value)}</p></div>)}</div><div className="mt-4 rounded-xl bg-white p-5 dark:bg-slate-900"><h3 className="text-sm font-semibold">Payment plans</h3><ul className="mt-2 flex flex-wrap gap-2">{(Array.isArray(profile.paymentPlans) ? profile.paymentPlans as string[] : []).map((value) => <li key={value} className="rounded-full bg-slate-100 px-3 py-1.5 text-xs dark:bg-slate-800">{value}</li>)}</ul>{!Array.isArray(profile.paymentPlans) && <p className="mt-2 text-sm text-muted">No payment plans saved yet.</p>}</div></Section>; }
function LeadsVisitsPanel(): JSX.Element { return <Section title="Leads & site visits" subtitle="Keep client conversations and scheduled visits in the CRM, linked back to this Project."><div className="rounded-xl border border-dashed border-slate-300 p-8 text-center"><CalendarDays className="mx-auto h-7 w-7 text-slate-400" /><p className="mt-3 text-sm font-medium">Project-linked activity is the next integration slice</p><p className="mt-1 text-xs text-muted">Existing Leads and Site Visits stay in their own modules; this panel will show their links without duplicating records.</p></div></Section>; }
function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }): JSX.Element { return <section className="mx-auto max-w-6xl"><header className="mb-4"><h3 className="text-base font-semibold">{title}</h3><p className="mt-1 text-xs text-muted">{subtitle}</p></header>{children}</section>; }
