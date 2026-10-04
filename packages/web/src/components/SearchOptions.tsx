import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { type FieldMeta, type FilterCondition, type FilterGroup } from '@ipropy/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { Dropdown } from './ui';
import { FilterBuilder } from './FilterBuilder';
import { FieldInput } from './FieldRenderer';
import { assignmentField, followUpFieldOf, pipelineFieldOf } from '../lib/fields';
import { followUpFilters, type TaskQueue } from './FollowUpQueue';

/** Temporary search criteria, not an edit to anybody's saved list. */
export function SearchOptions({ words, onWordsChange, onOpen }: { words: string; onWordsChange: (value: string) => void; onOpen: () => void }): JSX.Element {
  const { modules } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const entities = modules.filter((module) => module.isEntity);
  const current = location.pathname.split('/')[1];
  const [moduleName, setModuleName] = useState('');
  const selected = moduleName || (entities.some((module) => module.name === current) ? current : entities[0]?.name) || '';
  const [filter, setFilter] = useState<FilterGroup>({ logic: 'AND', conditions: [] });
  const [choices, setChoices] = useState<Record<string, unknown>>({});
  const { data: meta } = useQuery({ queryKey: ['module', selected], queryFn: () => api.module(selected), enabled: Boolean(selected) });
  const { data: tags } = useQuery({ queryKey: ['tags', selected], queryFn: () => api.tags(selected), enabled: Boolean(selected), staleTime: 60_000 });
  const fields = meta?.fields.filter((field) => field.isActive && field.displayType !== 'hidden' && field.config.filterable !== false) ?? [];
  const owner = assignmentField(fields);
  const nameField = fields.find((field) => field.columnName === 'full_name' || meta?.labelFields.includes(field.name));
  const phoneField = fields.find((field) => field.uitype === 'phone');
  const status = meta ? pipelineFieldOf(meta) : undefined;
  const due = followUpFieldOf(fields);
  const locationField = fields.find((field) => field.config.picklist === 'locality' || field.columnName === 'locality');
  const contactType = fields.find((field) => field.config.picklist === 'contact_type' || field.columnName === 'contact_type');
  const money = fields.find((field) => field.uitype === 'currency' && /budget|demand|asking|price/i.test(`${field.name} ${field.label}`)) ?? fields.find((field) => field.uitype === 'currency');
  const choose = (key: string, value: unknown): void => setChoices((previous) => ({ ...previous, [key]: value }));
  const quickConditions: Array<FilterCondition | FilterGroup> = [];
  for (const field of [nameField, phoneField]) {
    if (field && choices[field.name]) quickConditions.push({ field: field.name, operator: 'contains', value: choices[field.name] });
  }
  for (const field of [owner, status, locationField, contactType]) {
    const value = field && choices[field.name];
    if (field && value !== undefined && value !== null && value !== '') quickConditions.push({ field: field.name, operator: Array.isArray(value) ? 'has_any' : 'equals', value });
  }
  if (due && choices.task) quickConditions.push(followUpFilters(due.name)[choices.task as TaskQueue]);
  if (choices.created) quickConditions.push({ field: 'created_at', operator: choices.created as 'today' | 'yesterday' | 'this_week' | 'this_month' });
  if (choices.tag) quickConditions.push({ field: 'record_tags', operator: 'has_any', value: [choices.tag] });
  if (money) {
    if (choices.min !== undefined && choices.min !== '') quickConditions.push({ field: money.name, operator: 'greater_or_equal', value: Number(choices.min) });
    if (choices.max !== undefined && choices.max !== '') quickConditions.push({ field: money.name, operator: 'less_or_equal', value: Number(choices.max) });
  }
  const quickField = (field: FieldMeta | undefined, label: string): JSX.Element | null => field ? <div className="min-w-0 space-y-1"><span className="text-xs font-medium text-muted">{label}</span><FieldInput field={{ ...field, isReadonly: false, displayType: 'default', isMandatory: false }} value={choices[field.name] ?? null} onChange={(value) => choose(field.name, value)} /><button type="button" className="text-[10px] text-muted hover:text-brand-600" onClick={() => choose(field.name, '')}>Any {label.toLowerCase()}</button></div> : null;
  const apply = (close: () => void, clear = false): void => {
    const criteria: FilterGroup = clear ? { logic: 'AND', conditions: [] } : { logic: 'AND', conditions: [...quickConditions, ...(filter.conditions.length ? [filter] : [])] };
    const search = clear ? '' : words.trim();
    const params = new URLSearchParams(current === selected ? location.search : '');
    params.delete('q'); params.delete('filter'); params.delete('page');
    if (search) params.set('q', search);
    if (criteria.conditions.length) params.set('filter', JSON.stringify(criteria));
    // The list hydrates its queue on arrival. A deliberate search handoff gives
    // it one clean hydration without reloading the app or editing the saved view.
    navigate(`/${selected}?${params}`, { state: { searchHandoff: Date.now() } });
    if (clear) { onWordsChange(''); setFilter(criteria); setChoices({}); }
    close();
  };
  return <Dropdown align="right" className="w-[min(44rem,calc(100vw-2rem))] max-h-[80vh] overflow-y-auto p-4"
    trigger={<button onClick={onOpen} className="rounded-full bg-slate-200/70 p-2 text-slate-600 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200" aria-label="Search options" title="Search options"><SlidersHorizontal className="h-4 w-4" /></button>}>
    {(close) => <div className="space-y-3" role="dialog" aria-label="CRM search options">
      <h2 className="text-base font-semibold">Search options</h2>
      <label className="flex items-center gap-4 text-sm"><span className="w-24 shrink-0">Search in</span><select className="input" value={selected} onChange={(event) => { setModuleName(event.target.value); setChoices({}); setFilter({ logic: 'AND', conditions: [] }); }}>{entities.map((module) => <option key={module.name} value={module.name}>{module.label}</option>)}</select></label>
      <label className="flex items-center gap-4 text-sm"><span className="w-24 shrink-0">Has the words</span><input className="input" value={words} onChange={(event) => onWordsChange(event.target.value)} placeholder="Name, phone, property or comma-separated words" /></label>
      <div className="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2" data-testid="default-search-fields">
        {nameField && <label className="space-y-1 text-xs font-medium text-muted">Full name<input className="input" value={String(choices[nameField.name] ?? '')} onChange={(event) => choose(nameField.name, event.target.value)} placeholder="Any name" /></label>}
        {phoneField && <label className="space-y-1 text-xs font-medium text-muted">Mobile<input className="input" type="tel" value={String(choices[phoneField.name] ?? '')} onChange={(event) => choose(phoneField.name, event.target.value)} placeholder="Any mobile number" /></label>}
        {quickField(owner, 'Agent')}{quickField(locationField, 'Location')}{quickField(status, `${meta?.singularLabel ?? 'Record'} status`)}{quickField(contactType, 'Contact type')}
        {due && <label className="space-y-1 text-xs font-medium text-muted">Task wise<select className="input" value={String(choices.task ?? '')} onChange={(event) => choose('task', event.target.value)}><option value="">Any task</option><option value="pending">Overdue</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="upcoming">Upcoming</option></select></label>}
        <label className="space-y-1 text-xs font-medium text-muted">Created date<select className="input" value={String(choices.created ?? '')} onChange={(event) => choose('created', event.target.value)}><option value="">Any date</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="this_week">This week</option><option value="this_month">This month</option></select></label>
        <label className="space-y-1 text-xs font-medium text-muted">Tag wise<select className="input" value={String(choices.tag ?? '')} onChange={(event) => choose('tag', event.target.value)}><option value="">Any tag</option>{tags?.map((tag) => <option key={tag.id} value={tag.name}>{tag.name}</option>)}</select></label>
        {money && <div className="min-w-0 space-y-1"><span className="text-xs font-medium text-muted">{money.label} range (₹)</span><div className="flex gap-2"><input aria-label="Minimum budget or demand" className="input min-w-0" type="number" min="0" placeholder="Min" value={String(choices.min ?? '')} onChange={(event) => choose('min', event.target.value)} /><input aria-label="Maximum budget or demand" className="input min-w-0" type="number" min={Number(choices.min) || 0} placeholder="Max" value={String(choices.max ?? '')} onChange={(event) => choose('max', event.target.value)} /></div><input aria-label="Budget or demand maximum slider" className="w-full accent-brand-600" type="range" min={Number(choices.min) || 0} max={Math.max(1_000_000_000, Number(choices.max) || 0, Number(choices.min) || 0)} step="100000" value={Number(choices.max) || 1_000_000_000} onChange={(event) => choose('max', event.target.value)} /></div>}
      </div>
      <p className="text-xs text-muted">Temporary search only — saved views stay unchanged.</p>
      {meta && <FilterBuilder compact module={meta} value={filter} onChange={setFilter} />}
      <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => apply(close, true)}>Clear search filters</button><button className="btn-primary" onClick={() => apply(close)}>Search</button></div>
    </div>}
  </Dropdown>;
}
