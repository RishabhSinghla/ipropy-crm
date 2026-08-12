import { describe, expect, it } from 'vitest';
import { isOpenCodeChatCompletionModel, parseModelCatalogue } from '../../src/ai/models.js';

describe('AI model discovery', () => {
  it('only offers OpenCode models callable through chat-completions', () => {
    expect(isOpenCodeChatCompletionModel('nemotron-3-ultra-free')).toBe(true);
    expect(isOpenCodeChatCompletionModel('deepseek-v4-flash-free')).toBe(true);
    expect(isOpenCodeChatCompletionModel('big-pickle')).toBe(true);
    expect(isOpenCodeChatCompletionModel('gpt-5.4')).toBe(false);
    expect(isOpenCodeChatCompletionModel('claude-opus-4-6')).toBe(false);
    expect(isOpenCodeChatCompletionModel('gemini-3.1-pro')).toBe(false);
  });

  it('honours an explicit transport declared by the catalogue', () => {
    expect(isOpenCodeChatCompletionModel({ id: 'future-model', api: '/chat/completions' })).toBe(true);
    expect(isOpenCodeChatCompletionModel({ id: 'deepseek-future', api: '/responses' })).toBe(false);
  });

  it('filters non-chat Groq models and keeps live metadata', () => {
    const models = parseModelCatalogue('groq', {
      data: [
        { id: 'whisper-large-v3-turbo' },
        { id: 'openai/gpt-oss-120b', context_window: 131072 },
      ],
    });
    expect(models).toEqual([{
      id: 'openai/gpt-oss-120b',
      label: 'openai/gpt-oss-120b',
      contextLength: 131072,
      free: false,
      vision: false,
    }]);
  });

  it('only keeps Gemini generateContent models', () => {
    const models = parseModelCatalogue('gemini', {
      models: [
        { name: 'models/gemini-flash-latest', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    });
    expect(models.map((model) => model.id)).toEqual(['gemini-flash-latest']);
  });
});
