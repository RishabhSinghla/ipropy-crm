/**
 * A workflow that runs on a schedule cannot read `inputs`.
 *
 * `inputs` is populated for `workflow_dispatch` and `workflow_call` and is
 * empty for every other trigger — including `schedule`. A default declared
 * under `workflow_dispatch.inputs` applies when a person presses the button and
 * at no other time.
 *
 * `Prove the CRM answers` and `Prove the CRM remembers` are the two checks that
 * say production still works — one that the screens load, one that what a rep
 * types is kept. Both carried `BASE_URL: ${{ inputs.base_url }}` and both ran
 * on a cron. So every scheduled run handed curl an empty address and died
 * before testing anything, while every manual run passed.
 *
 * That is the worst shape a monitor can have. It was not absent and it was not
 * obviously broken: the history showed green runs, because somebody had pressed
 * the button. Nobody looks at a monitor that appears to be working.
 *
 * The fix is `${{ inputs.x || 'a default' }}`, and this is here so the next
 * scheduled workflow cannot forget it.
 *
 * A unit test rather than a lint rule because it needs no tooling and fails in
 * the same run as everything else — the same reason as
 * `workflowsPrintNoSecrets.test.ts` next door.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../../../.github/workflows/', import.meta.url).pathname;

/** `${{ inputs.foo }}` with nothing after it to fall back on. */
const BARE_INPUT = /\$\{\{\s*inputs\.[A-Za-z0-9_]+\s*\}\}/;

describe('a workflow that runs on a schedule', () => {
  it('never depends on an input a schedule cannot supply', () => {
    const offenders: string[] = [];

    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const text = readFileSync(`${DIR}${file}`, 'utf8');

      // Only workflows that actually run unattended. A dispatch-only workflow
      // reading its own inputs is exactly right and must not be flagged.
      if (!/^\s{2}schedule:/m.test(text)) continue;

      text.split('\n').forEach((line, i) => {
        if (BARE_INPUT.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      'This workflow runs on a schedule, and `inputs` is empty on every trigger '
      + 'except workflow_dispatch — so this reads as blank at 3am and the step '
      + 'runs against nothing. A default under `workflow_dispatch.inputs` does '
      + 'not help; it only applies when somebody presses the button. Write '
      + "`${{ inputs.x || 'the default' }}` instead.",
    ).toEqual([]);
  });
});
