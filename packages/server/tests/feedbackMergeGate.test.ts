/**
 * What the AI engineer is and is not allowed to touch.
 *
 * The forbidden list is the whole safety story of the autonomous pipeline: the
 * agent can open a PR, but the CRM only auto-merges one whose diff stays inside
 * the allowed surface. A PR that edits a workflow file can green-light itself
 * (CI runs the workflow from the PR's own branch), so the only honest answer
 * is to refuse modified workflows outright — which is exactly what
 * `diffIsSafe` encodes.
 */
import { describe, expect, it } from 'vitest';
import { diffIsSafe } from '../src/core/feedback/mergeGate.js';

describe('what an agent pull request may touch', () => {
  it('accepts ordinary code changes', () => {
    expect(diffIsSafe([
      { filename: 'packages/server/src/core/entity/recordService.ts' },
      { filename: 'packages/web/src/pages/ListView.tsx' },
      { filename: 'packages/server/src/db/migrations/111_new_thing.sql' },
      { filename: 'scripts/agent/run-agent.mjs' },
    ])).toBe(true);
  });

  it('refuses environment and secret files', () => {
    expect(diffIsSafe([{ filename: '.env' }])).toBe(false);
    expect(diffIsSafe([{ filename: '.env.example' }])).toBe(false);
    expect(diffIsSafe([{ filename: 'config/secrets.json' }])).toBe(false);
    expect(diffIsSafe([{ filename: 'packages/server/src/prodSecrets.ts' }])).toBe(false);
  });

  it('refuses the deploy pipeline itself', () => {
    // A modified workflow could make CI green-light itself; a modified
    // Dockerfile or render.yaml changes what production runs while CI keeps
    // passing. None of them may be agent-authored.
    expect(diffIsSafe([{ filename: '.github/workflows/ci.yml' }])).toBe(false);
    expect(diffIsSafe([{ filename: '.github/workflows/agent.yml' }])).toBe(false);
    expect(diffIsSafe([{ filename: 'render.yaml' }])).toBe(false);
    expect(diffIsSafe([{ filename: 'Dockerfile' }])).toBe(false);
    expect(diffIsSafe([{ filename: 'docker-compose.yml' }])).toBe(false);
  });

  it('refuses the whole PR when any one file is out of bounds', () => {
    expect(diffIsSafe([
      { filename: 'packages/web/src/App.tsx' },
      { filename: '.github/workflows/ci.yml' },
    ])).toBe(false);
  });
});
