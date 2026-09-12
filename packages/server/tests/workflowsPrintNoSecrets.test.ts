/**
 * No workflow may print a secret, because this repository is public.
 *
 * Its Actions logs are public with it, and two workflows echoed a freshly
 * minted credential into one: `create-api-key.yml` published a production API
 * key carrying the owner's permissions, and `set-n8n-config.yml` published the
 * callback secret that guards the webhooks router. Both ran on 18 August 2026
 * and both logs stayed readable for weeks.
 *
 * `probe-prod-schema.yml` had the rule right from the start — it prints counts
 * and never a value, "because this log is public". This makes that a rule
 * rather than a habit.
 *
 * A unit test rather than a lint rule because it needs no tooling and fails in
 * the same run as everything else.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../../../.github/workflows/', import.meta.url).pathname;

/**
 * `echo "$SECRET"` and friends — a bare echo of something whose name says it
 * is a credential. Deliberately narrow: this has to catch the real shape
 * without flagging `echo "::notice::… prefix ${PREFIX}"`, which is not secret.
 */
const ECHOES_A_SECRET = /^\s*echo\s+"?\$\{?(RAW|SECRET|PASSWORD|PASS|TOKEN|KEY|API_KEY|CREDENTIAL)[A-Z_]*\}?"?\s*$/;

describe('the GitHub workflows', () => {
  it('never echo a credential into a public log', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      readFileSync(`${DIR}${file}`, 'utf8').split('\n').forEach((line, i) => {
        if (ECHOES_A_SECRET.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'This repository is public and so are its Actions logs. Write the value '
      + 'into a repository secret with `gh secret set` instead, or have the '
      + `operator supply it.\n\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
