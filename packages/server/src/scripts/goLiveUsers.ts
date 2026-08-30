/**
 * Turn a demo database into a real one: one owner, no seeded logins.
 *
 * The demo seed creates about a dozen users who all share a password that is
 * published in this repository. Every one of them is an unlocked door into real
 * customer data, and there is no version of going live where they stay.
 *
 * Run against production **once**, before the team starts using it:
 *
 *   ADMIN_EMAIL='you@example.com' \
 *   ADMIN_PASSWORD='...' \
 *   ADMIN_MOBILE='98115 33633' \
 *   ADMIN_NAME='Rishabh Singhla' \
 *   DATABASE_URL='postgresql://…' \
 *   npm run go-live:users
 *
 * The password is read from the environment and never written to a file, a log
 * line or a commit. It is hashed with the same bcrypt cost the login route uses,
 * so nothing about this account is special.
 *
 * Three things make it safe to run on a live database:
 *
 *  * **It reassigns before it deletes.** `ipy_record.owner_id` has no foreign
 *    key to `ipy_user` — it is one of the `config.__record` fields — so deleting
 *    a user leaves every record they owned pointing at somebody who is not
 *    there. Silently. Those records would still list, still be reported on, and
 *    belong to nobody. Everything owned by a removed user moves to the admin
 *    first.
 *  * **It is idempotent.** Run it twice and the second run changes nothing but
 *    the password, which it resets to whatever the environment says.
 *  * **It refuses to leave nobody in charge.** The admin is created and verified
 *    before a single delete runs, and the account being kept can never be one of
 *    the accounts being removed.
 *
 * It prints what it will do and asks, unless CONFIRM=yes is set.
 */
import { createInterface } from 'node:readline/promises';
import bcrypt from 'bcryptjs';
import { db, transaction } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isSystemAccount } from '../core/auth/systemAccounts.js';

interface Existing { id: string; email: string; is_admin: boolean }

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`\n  ${name} is required.\n`);
    process.exit(1);
  }
  return value;
}

/** Digits only, so "98115 33633" and "+91 98115 33633" store the same way. */
function nationalDigits(input: string): string {
  const digits = input.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function main(): Promise<void> {
  const email = required('ADMIN_EMAIL').toLowerCase();
  const password = required('ADMIN_PASSWORD');
  const mobile = nationalDigits(process.env.ADMIN_MOBILE ?? '');
  const fullName = (process.env.ADMIN_NAME ?? 'iPropy Admin').trim();
  const [firstName, ...rest] = fullName.split(/\s+/);
  const lastName = rest.join(' ') || 'Admin';

  if (password.length < 8) {
    console.error('\n  ADMIN_PASSWORD must be at least 8 characters.\n');
    process.exit(1);
  }

  /*
    Everybody except the admin being kept, and except the automation accounts.

    `system@ipropy` is not a person. It is the actor that workflow tasks,
    telephony logging, lead capture and AI field writes all run as, and deleting
    it breaks every one of them — quietly, because each of those paths creates it
    on demand and would simply make a second one. The convention this codebase
    already uses is that a real person's address has a dot after the @; a system
    account does not.
  */
  const everyone = await db.query<Existing>(
    `SELECT id, email, is_admin FROM ipy_user WHERE deleted_at IS NULL ORDER BY email`,
  );
  const doomed = everyone.rows.filter(
    (u) => u.email.toLowerCase() !== email && !isSystemAccount(u.email),
  );
  const kept = everyone.rows.filter((u) => isSystemAccount(u.email));

  console.log(`\n  Database: ${config.db.url.replace(/:\/\/[^@]*@/, '://***@')}`);
  console.log(`  Keeping:  ${email}${mobile ? `  (${mobile})` : ''}`);
  console.log(`  Removing: ${doomed.length} account(s)`);
  for (const u of doomed) console.log(`            - ${u.email}${u.is_admin ? '  [admin]' : ''}`);

  if (!doomed.length) console.log('            (none — nothing to clean up)');
  if (kept.length) {
    console.log(`  Leaving:  ${kept.length} automation account(s) — ${kept.map((u) => u.email).join(', ')}`);
  }

  if (process.env.CONFIRM !== 'yes') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('\n  Type "yes" to proceed: ')).trim();
    rl.close();
    if (answer !== 'yes') {
      console.log('  Cancelled. Nothing changed.\n');
      process.exit(0);
    }
  }

  const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);

  await transaction(async (tx) => {
    /*
      The admin first, and completely, before anything is removed. If this fails
      the transaction rolls back and the demo logins are still there — which is
      the right way round to fail.
    */
    /*
      Found first, then updated or inserted. `ON CONFLICT (email)` cannot be used
      here: the unique index is `lower(email) WHERE deleted_at IS NULL`, a
      partial functional index, and Postgres will not match an inference clause
      to one. It fails with "no unique or exclusion constraint matching", which
      reads like a missing constraint rather than an un-inferrable one.
    */
    const found = await tx.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [email],
    );

    const admin = found
      ? await tx.queryOne<{ id: string }>(
        `UPDATE ipy_user
            SET password_hash = $2, first_name = $3, last_name = $4,
                phone = COALESCE(NULLIF($5, ''), phone),
                is_admin = true, is_active = true, deleted_at = NULL,
                password_changed_at = now(), updated_at = now()
          WHERE id = $1 RETURNING id`,
        [found.id, passwordHash, firstName, lastName, mobile || null],
      )
      : await tx.queryOne<{ id: string }>(
        `INSERT INTO ipy_user (email, password_hash, first_name, last_name, phone,
                               is_admin, is_active, password_changed_at)
         VALUES ($1,$2,$3,$4,$5,true,true,now())
         RETURNING id`,
        [email, passwordHash, firstName, lastName, mobile || null],
      );
    if (!admin) throw new Error('could not create or update the admin user');

    /*
      Give it a role and profile, so it can actually administer. Without one a
      fresh account signs in and sees nothing.

      Checked against the catalogue rather than wrapped in a catch. Inside a
      transaction a failed statement poisons everything after it — Postgres
      answers "current transaction is aborted" to every following command — so
      catching the error in JavaScript does not rescue the transaction, it just
      hides which statement killed it.
    */
    const hasColumn = async (table: string, column: string): Promise<boolean> => Boolean(
      await tx.queryOne(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column],
      ),
    );

    const roleOrder = (await hasColumn('ipy_role', 'depth')) ? 'depth ASC NULLS LAST, created_at ASC' : 'created_at ASC';
    const adminProfile = (await hasColumn('ipy_profile', 'is_admin'))
      ? `(SELECT id FROM ipy_profile WHERE is_admin = true ORDER BY created_at ASC LIMIT 1)`
      : `(SELECT id FROM ipy_profile ORDER BY created_at ASC LIMIT 1)`;

    await tx.query(
      `UPDATE ipy_user
          SET role_id = COALESCE(role_id, (SELECT id FROM ipy_role ORDER BY ${roleOrder} LIMIT 1)),
              profile_id = COALESCE(profile_id, ${adminProfile})
        WHERE id = $1`,
      [admin.id],
    );

    if (!doomed.length) return;
    const ids = doomed.map((u) => u.id);

    /*
      Reassign before deleting. `ipy_record.owner_id` has no foreign key, so a
      delete would leave records owned by a user who no longer exists — they
      stay in every list and belong to nobody.
    */
    const moved = await tx.query(
      `UPDATE ipy_record SET owner_id = $1 WHERE owner_id = ANY($2)`,
      [admin.id, ids],
    );

    // The same problem, wherever else a user id is held without a constraint.
    for (const [table, column] of [
      ['ipy_workflow', 'created_by'],
      ['ipy_assignment_rule', 'created_by'],
    ] as const) {
      if (!await hasColumn(table, column)) continue;
      await tx.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = ANY($2)`, [admin.id, ids]);
    }

    // An assignment rule pointing at somebody who is about to stop existing
    // would route new leads into a void, and nothing would report it.
    if (await hasColumn('ipy_assignment_rule', 'target_users')) {
      await tx.query(
        `UPDATE ipy_assignment_rule
            SET target_users = COALESCE((
                  SELECT jsonb_agg(u) FROM jsonb_array_elements(target_users) u
                   WHERE NOT (u #>> '{}' = ANY($1))), '[]'::jsonb)
          WHERE target_users IS NOT NULL
            AND jsonb_typeof(target_users) = 'array'`,
        [ids],
      );
    }

    const removed = await tx.query(`DELETE FROM ipy_user WHERE id = ANY($1)`, [ids]);

    logger.info(
      { removed: removed.rowCount, recordsReassigned: moved.rowCount, admin: email },
      'go-live user cleanup complete',
    );
    console.log(`\n  Reassigned ${moved.rowCount} record(s) to ${email}`);
    console.log(`  Removed ${removed.rowCount} account(s)`);
  });

  const left = await db.query<{ email: string; is_admin: boolean }>(
    `SELECT email, is_admin FROM ipy_user WHERE deleted_at IS NULL ORDER BY email`,
  );
  console.log(`\n  Accounts now: ${left.rows.map((u) => u.email).join(', ') || '(none)'}`);
  console.log('  Done. Sign in with the password you supplied.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n  Failed, and nothing was changed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
