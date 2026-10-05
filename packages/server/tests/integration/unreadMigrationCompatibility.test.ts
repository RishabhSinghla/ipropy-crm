import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { transaction } from '../../src/db/pool.js';

describe('migration 184 on existing installations', () => {
  for (const hasConfig of [true, false]) {
    it(`handles a report table ${hasConfig ? 'with' : 'without'} config`, async () => {
      const sql = await readFile(new URL('../../src/db/migrations/184_unread_goes_from_every_module.sql', import.meta.url), 'utf8');
      await transaction(async (tx) => {
        // Temporary tables shadow the real ones; no CRM data is touched.
        await tx.query(`
          CREATE TEMP TABLE ipy_view (module_id text, seed_key text, filter jsonb) ON COMMIT DROP;
          CREATE TEMP TABLE ipy_view_tombstone (module_id text, seed_key text, UNIQUE(module_id, seed_key)) ON COMMIT DROP;
          CREATE TEMP TABLE ipy_dashboard_widget (id int, config jsonb) ON COMMIT DROP;
          CREATE TEMP TABLE ipy_report (id int ${hasConfig ? ', config jsonb' : ''}) ON COMMIT DROP;
          INSERT INTO ipy_dashboard_widget VALUES
            (1, '{"filter":{"field":"unread"}}'),
            (2, '{"filter":{"field":"full_name"}}');
        `);
        await tx.query(hasConfig
          ? `INSERT INTO ipy_report VALUES (1, '{"filter":{"field":"unread"}}'), (2, '{"filter":{"field":"full_name"}}')`
          : 'INSERT INTO ipy_report VALUES (2)');
        await tx.query(sql);
        await tx.query(sql); // Re-running is safe too.
        expect((await tx.query('SELECT id FROM ipy_dashboard_widget')).rows).toEqual([{ id: 2 }]);
        expect((await tx.query('SELECT id FROM ipy_report')).rows).toEqual([{ id: 2 }]);
      });
    });
  }
});
