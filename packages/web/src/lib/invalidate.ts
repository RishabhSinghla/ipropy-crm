/**
 * Central cache-invalidation rules.
 *
 * Writing a record touches far more than the record itself: list views, saved
 * view counts, the timeline, related lists on other modules, AI insights and
 * every dashboard widget that counts or sums the module. Each mutation site
 * used to invalidate its own ad-hoc subset — some invalidated nothing at all —
 * which is why edits appeared to need a page refresh.
 *
 * `invalidateQueries` only refetches queries that are currently mounted;
 * everything else is just marked stale, so casting a wide net here is cheap.
 */
import type { QueryClient } from '@tanstack/react-query';

/** Anything that reads record data, anywhere in the app. */
export function invalidateRecordQueries(qc: QueryClient, module?: string, id?: string): void {
  // Quick-filter numbers are projections of records, not tag-master totals.
  void qc.invalidateQueries({ queryKey: module ? ['facet', module] : ['facet'] });
  void qc.invalidateQueries({ queryKey: module ? ['chip-count', module] : ['chip-count'] });
  void qc.invalidateQueries({ queryKey: ['tags'] });
  if (module) {
    void qc.invalidateQueries({ queryKey: ['records', module] });
    void qc.invalidateQueries({ queryKey: ['queue-groups', module] });
    void qc.invalidateQueries({ queryKey: ['queue-group-record', module] });
    void qc.invalidateQueries({ queryKey: [module, 'table'] });
    void qc.invalidateQueries({ queryKey: ['views', module] });
  } else {
    void qc.invalidateQueries({ queryKey: ['records'] });
  }

  // Sidebar badges and favourites are user-specific projections of the same
  // records. A pipeline move or star toggle must update them in the same tick.
  void qc.invalidateQueries({ queryKey: ['starred'] });

  /*
    The "3 / 25,458" counter and the arrows beside it. The list's default is
    Recently updated, so any edit moves a record — and a counter left over from
    before the edit names a place the record no longer holds.
  */
  void qc.invalidateQueries({ queryKey: ['record-neighbours'] });
  void qc.invalidateQueries({ queryKey: ['neighbours'] });
  void qc.invalidateQueries({ queryKey: ['call-next'] });

  if (module && id) {
    void qc.invalidateQueries({ queryKey: ['record', module, id] });
    void qc.invalidateQueries({ queryKey: ['timeline', module, id] });
    void qc.invalidateQueries({ queryKey: ['insights', id] });
  }

  // A record can appear in another module's related list (a lead's deals, a
  // project's units), so related lists are invalidated regardless of module.
  void qc.invalidateQueries({ queryKey: ['related'] });

  // Dashboards, widgets and the inventory board all aggregate record data.
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['dashboards'] });
  void qc.invalidateQueries({ queryKey: ['widget'] });
  void qc.invalidateQueries({ queryKey: ['inventory'] });
  void qc.invalidateQueries({ queryKey: ['recent'] });
}

/** Metadata changes reshape the whole UI — modules, fields, layouts, picklists. */
export function invalidateMetadataQueries(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['module'] });
  void qc.invalidateQueries({ queryKey: ['all-modules'] });
  void qc.invalidateQueries({ queryKey: ['modules'] });
  void qc.invalidateQueries({ queryKey: ['picklists'] });
  void qc.invalidateQueries({ queryKey: ['layouts'] });
  void qc.invalidateQueries({ queryKey: ['fields'] });
}
