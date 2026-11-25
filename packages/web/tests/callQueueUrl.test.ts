import { describe, expect, it } from 'vitest';
import { callQueueUrl } from '../src/lib/callQueueUrl';
import { saveNextUrl } from '../src/lib/saveNextUrl';

describe('call deck queue handoff', () => {
  it('keeps the effective quick filters and follow-up sort through Save & Next', () => {
    const filter = {
      logic: 'AND' as const,
      conditions: [
        { field: 'next_follow_up', operator: 'less_than' as const, value: '2026-09-27' },
        { field: 'lead_status', operator: 'in' as const, value: ['Contacted'] },
        { field: 'owner_id', operator: 'equals' as const, value: 'agent-1' },
      ],
    };
    const snapshot = callQueueUrl('leads', {
      view: 'team', page: 5, pageSize: 25, search: 'sector', filter,
      sortBy: 'next_follow_up', sortDir: 'asc',
    });
    const destination = new URL(saveNextUrl(snapshot, 'leads', 'next-row', 103), 'https://crm.local');
    expect(destination.pathname).toBe('/leads');
    expect(destination.searchParams.get('filter')).toBe(JSON.stringify(filter));
    expect(destination.searchParams.get('sort')).toBe('next_follow_up');
    expect(destination.searchParams.get('dir')).toBe('asc');
    expect(destination.searchParams.get('page')).toBe('5');
    expect(destination.searchParams.get('open')).toBe('next-row');
    expect(destination.searchParams.get('dial')).toBe('1');
  });
});
