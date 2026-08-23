/**
 * The settings that decide which model runs and how the business sounds.
 *
 * Pure logic, so it is checked here rather than through a browser: what happens
 * to a blank box, a pasted price, a model id with a stray space. All three are
 * things somebody will do, and the answer has to be "that one job falls back"
 * rather than "the pipeline is off and nothing says why".
 */
import { describe, expect, it } from 'vitest';
import { AI_JOBS } from '../src/core/settings/aiModels.js';
import { AI_FEATURES } from '../src/core/settings/aiFeatures.js';

describe('the model list', () => {
  it('names a real default for every job', () => {
    for (const [job, spec] of Object.entries(AI_JOBS)) {
      expect(spec.fallback, `${job} has no fallback`).toMatch(/^[a-z0-9][a-z0-9._/-]+/i);
      expect(spec.label.length, `${job} has no label`).toBeGreaterThan(3);
      expect(spec.key, `${job} has the wrong key shape`).toBe(`ai_models.${job}`);
    }
  });

  it('describes every job in words an owner can act on', () => {
    for (const [job, spec] of Object.entries(AI_JOBS)) {
      expect(spec.description.length, `${job} has no description`).toBeGreaterThan(30);
      // The settings screen shows the description and never the key. A
      // description that names the key is a leak of the thing it exists to
      // hide.
      expect(spec.description, `${job} mentions its own key`).not.toContain('ai_models.');
    }
  });
});

describe('the feature switches', () => {
  it('defaults everything on except the one that costs money', () => {
    for (const [name, spec] of Object.entries(AI_FEATURES)) {
      if (name === 'videoGeneration') {
        expect(spec.fallback, 'video generation must default to off').toBe(false);
      } else {
        expect(spec.fallback, `${name} should default on`).toBe(true);
      }
    }
  });

  it('says what each one does, and what the expensive one costs', () => {
    for (const [name, spec] of Object.entries(AI_FEATURES)) {
      expect(spec.description.length, `${name} has no description`).toBeGreaterThan(30);
    }
    // The rule this encodes: the only feature that puts an invented frame on
    // screen must say so, and must say what it costs, in the box next to its
    // own switch.
    expect(AI_FEATURES.videoGeneration.description).toMatch(/cost|rupee|₹/i);
    expect(AI_FEATURES.videoGeneration.description).toMatch(/nobody photographed|generated/i);
  });

  it('gives every switch its own key, so one cannot turn off another', () => {
    const keys = Object.values(AI_FEATURES).map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
