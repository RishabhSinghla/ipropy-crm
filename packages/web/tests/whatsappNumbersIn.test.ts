import { describe, expect, it } from 'vitest';
import { numbersIn } from '../src/components/BubbleKindFilter';

describe('numbersIn', () => {
  it('lists each of our numbers once, skipping unknown ones', () => {
    expect(numbersIn([
      { numberId: 'a', numberName: 'yogesh-phone', numberPhone: '+91 98xxx' },
      { numberId: 'a', numberName: 'yogesh-phone', numberPhone: '+91 98xxx' },
      { numberId: 'api:x', numberName: 'iPropy Floors', numberPhone: '+91 98217 72933' },
      { numberId: null },
    ])).toEqual([
      { id: 'a', label: 'yogesh-phone · +91 98xxx' },
      { id: 'api:x', label: 'iPropy Floors · +91 98217 72933' },
    ]);
  });
});
