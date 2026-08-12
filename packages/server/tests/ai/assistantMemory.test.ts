import { describe, expect, it } from 'vitest';
import { extractMemoryFact, normalizeMemoryFact } from '../../src/ai/assistantMemory.js';
import { isClearlyOutsideCrm } from '../../src/ai/assistant.js';

describe('Ask iPropy explicit memory', () => {
  it('stores only an explicit remember instruction', () => {
    expect(extractMemoryFact('Remember that I prefer WhatsApp drafts in Hinglish.'))
      .toBe('I prefer WhatsApp drafts in Hinglish');
    expect(extractMemoryFact('please remember: show prices in crore')).toBe('show prices in crore');
    expect(extractMemoryFact('What did I tell you to remember?')).toBeNull();
    expect(extractMemoryFact('Show my hot leads')).toBeNull();
  });

  it('normalises equivalent memory for safe deduplication', () => {
    expect(normalizeMemoryFact('  WhatsApp — in Hinglish! ')).toBe('whatsapp in hinglish');
  });
});

describe('Ask iPropy scope boundary', () => {
  it('keeps obvious outside-world requests out of the CRM assistant', () => {
    expect(isClearlyOutsideCrm('What is the weather in Faridabad?')).toBe(true);
    expect(isClearlyOutsideCrm('Write me a poem')).toBe(true);
    expect(isClearlyOutsideCrm('Show me properties in Faridabad')).toBe(false);
    expect(isClearlyOutsideCrm('Which leads should I call today?')).toBe(false);
  });
});
