/**
 * Guard: the deployment killer this repo has now hit once.
 *
 * The server runs as native ESM after tsc, and Node ESM refuses extensionless
 * relative imports — `./analyzeAndEmail` typechecks, passes every test under
 * tsx/vitest, and then kills the container at boot with ERR_MODULE_NOT_FOUND.
 * That is exactly what happened on Render: green CI, dead deploy.
 *
 * This walks the server source and fails on any relative import (./ or ../)
 * whose specifier does not end in .js — the convention every other import in
 * the codebase already follows.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('every relative import ends in .js', () => {
  it('no extensionless relative import survives into dist', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
        if (!match[1].endsWith('.js')) {
          offenders.push(`${file.replace(`${SRC}/`, '')}: ${match[1]}`);
        }
      }
    }
    expect(offenders, 'extensionless relative imports (they break the production ESM boot)').toEqual([]);
  });
});
