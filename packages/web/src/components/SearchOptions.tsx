import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { type FilterGroup } from '@ipropy/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { Dropdown } from './ui';
import { FilterBuilder } from './FilterBuilder';

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
  const { data: meta } = useQuery({ queryKey: ['search-options-meta', selected], queryFn: () => api.module(selected), enabled: Boolean(selected) });
  const apply = (close: () => void, clear = false): void => {
    const criteria = clear ? { logic: 'AND' as const, conditions: [] } : filter;
    const search = clear ? '' : words.trim();
    const params = new URLSearchParams(current === selected ? location.search : '');
    params.delete('q'); params.delete('filter'); params.delete('page');
    if (search) params.set('q', search);
    if (criteria.conditions.length) params.set('filter', JSON.stringify(criteria));
    // The list hydrates its queue on arrival. A deliberate search handoff gives
    // it one clean hydration without reloading the app or editing the saved view.
    navigate(`/${selected}?${params}`, { state: { searchHandoff: Date.now() } });
    if (clear) { onWordsChange(''); setFilter(criteria); }
    close();
  };
  return <Dropdown align="right" className="w-[min(42rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto p-5"
    trigger={<button onClick={onOpen} className="rounded-full bg-slate-200/70 p-2 text-slate-600 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200" aria-label="Search options" title="Search options"><SlidersHorizontal className="h-4 w-4" /></button>}>
    {(close) => <div className="space-y-4" role="dialog" aria-label="CRM search options">
      <h2 className="text-base font-semibold">Search options</h2>
      <label className="flex items-center gap-4 text-sm"><span className="w-24 shrink-0">Search in</span><select className="input" value={selected} onChange={(event) => { setModuleName(event.target.value); setFilter({ logic: 'AND', conditions: [] }); }}>{entities.map((module) => <option key={module.name} value={module.name}>{module.label}</option>)}</select></label>
      <label className="flex items-center gap-4 text-sm"><span className="w-24 shrink-0">Has the words</span><input className="input" value={words} onChange={(event) => onWordsChange(event.target.value)} placeholder="Name, phone, property or comma-separated words" /></label>
      <p className="text-xs text-muted">Choose any available CRM field, operator and value. These criteria are temporary; saved views stay unchanged.</p>
      {meta && <FilterBuilder module={meta} value={filter} onChange={setFilter} />}
      <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => apply(close, true)}>Clear search filters</button><button className="btn-primary" onClick={() => apply(close)}>Search</button></div>
    </div>}
  </Dropdown>;
}
