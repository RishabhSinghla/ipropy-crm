import { expect, it } from 'vitest';
import { dashboardChoiceCondition } from '../src/lib/quickDashboardFilters';

it('uses stored values for dashboard dropdown filters', () => {
  expect(dashboardChoiceCondition('status', 'Contacted')).toEqual({ field: 'status', operator: 'equals', value: 'Contacted' });
  expect(dashboardChoiceCondition('last_call_disposition', '__blank')).toEqual({ field: 'last_call_disposition', operator: 'is_empty' });
  expect(dashboardChoiceCondition('record_tags', 'visit done')).toEqual({ field: 'record_tags', operator: 'has_any', value: ['visit done'] });
  expect(dashboardChoiceCondition('record_tags', '__blank')).toEqual({ field: 'record_tags', operator: 'is_empty' });
});
