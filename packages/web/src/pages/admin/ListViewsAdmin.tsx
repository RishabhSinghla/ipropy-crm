import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Columns2, LayoutGrid, List, Save } from 'lucide-react';
import type { ListViews } from '@ipropy/shared';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Skeleton, Spinner } from '../../components/ui';

/**
 * Which of the three list views the team may use.
 *
 * All three ship on. A business that only ever works the split view still saw
 * three buttons above every list, and three ways for two people to be looking
 * at the same records differently. Switching one off here removes its button
 * everywhere, for everybody.
 *
 * **The last one on cannot be switched off.** A module with no view is a blank
 * page, so the screen refuses it and `readListViews` on the server ignores a
 * row that says so anyway — two guards, because this is the one mistake this
 * screen could make that a person could not undo from the screen itself.
 */

/** The three views, in the order their buttons sit in above a list. */
const VIEWS: { key: keyof ListViews; label: string; icon: typeof List; what: string }[] = [
  { key: 'table', label: 'Table', icon: List, what: 'Every record as a row, the way a spreadsheet reads.' },
  { key: 'kanban', label: 'Board', icon: LayoutGrid, what: 'Cards in columns, one column per stage. Modules with no stage field never show it.' },
  { key: 'ipropy', label: 'Split view', icon: Columns2, what: 'The queue on the left, the open record on the right. What the team lands on by default.' },
];

const ALL_ON: ListViews = { table: true, kanban: true, ipropy: true };

export default function ListViewsAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: ['settings', 'ui'], queryFn: () => api.settings('ui') });

  const [chosen, setChosen] = useState<ListViews>(ALL_ON);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  /*
    Nothing renders until the saved answer has arrived. A settings response
    that lands after the first paint wipes whatever was ticked in the gap, with
    no error and nothing on screen — which reads exactly like a switch that
    does not work. That has already happened on this repo's split-view screen.
  */
  useEffect(() => {
    if (loaded || !settings) return;
    const row = settings.find((s) => (s as { key: string }).key === 'ui.list_views');
    const value = (row as { value?: unknown } | undefined)?.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const saved = value as Record<string, unknown>;
      setChosen({
        table: saved.table !== false,
        kanban: saved.kanban !== false,
        ipropy: saved.ipropy !== false,
      });
    }
    setLoaded(true);
  }, [settings, loaded]);

  const onCount = VIEWS.filter((view) => chosen[view.key]).length;

  const toggle = (key: keyof ListViews): void => {
    if (chosen[key] && onCount === 1) {
      toast.error('At least one view has to stay on', 'A list with no view is a blank page.');
      return;
    }
    setChosen((current) => ({ ...current, [key]: !current[key] }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.saveSettings({ 'ui.list_views': chosen });
      await queryClient.invalidateQueries({ queryKey: ['settings', 'ui'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      toast.success('List views saved', 'Everybody sees these views above every list.');
    } catch (err) {
      toast.error('Could not save the list views', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !loaded) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">List views</h1>
        <p className="text-xs text-muted">
          Which ways the team may look at a list. Switched off here means the button is gone for
          everybody, on every module.
        </p>
      </div>

      <div className="space-y-2">
        {VIEWS.map((view) => {
          const on = chosen[view.key];
          return (
            <button
              key={view.key}
              type="button"
              onClick={() => toggle(view.key)}
              aria-pressed={on}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                on
                  ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
                  : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800',
              )}
            >
              <view.icon className={cn('mt-0.5 h-4 w-4 shrink-0', on ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-400')} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{view.label}</span>
                <span className="block text-xs text-muted">{view.what}</span>
              </span>
              <span className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-2xs font-bold',
                on
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
              )}>
                {on ? 'ON' : 'OFF'}
              </span>
            </button>
          );
        })}
      </div>

      <button className="btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
        {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
        Save
      </button>
    </div>
  );
}
