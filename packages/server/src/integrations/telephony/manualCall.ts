/**
 * A call somebody made from their own phone, written down.
 *
 * All that is left of `telephony/service.ts`, which is gone. That file carried
 * Twilio and Exotel — click-to-call from the browser, inbound IVR routing and
 * status callbacks — and none of it was ever configured on this business. The
 * calls that actually happen here are made on a handset and land through the
 * paired Android app (`deviceSync.ts`), or are typed in afterwards, which is
 * this.
 *
 * The interesting half is below: a synced call and a hand-logged one are
 * usually the *same* call, and creating both leaves a rep looking at a
 * duplicate they have to reconcile.
 */
import { toE164 } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { bus } from '../../core/events/bus.js';
import { touchActivity } from '../../core/entity/recordService.js';
import { markContacted } from '../../core/entity/payloadColumns.js';

export async function logManualCall(input: {
  userId: string;
  recordId: string | null;
  module: string | null;
  toNumber: string;
  direction: 'inbound' | 'outbound';
  durationSeconds: number;
  disposition?: string;
  notes?: string;
}): Promise<{ callId: string }> {
  const agent = await db.queryOne<{ phone: string | null }>(`SELECT phone FROM ipy_user WHERE id = $1`, [input.userId]);
  const numberTail = input.toNumber.replace(/\D/g, '').slice(-10);
  // A paired Android phone may finish syncing a call before the rep presses
  // Save on the disposition popup. That row is the real call (exact time and
  // duration), so add the outcome to it instead of creating a manual twin.
  const synced = numberTail.length === 10 ? await db.queryOne<{ id: string }>(
    `SELECT id
      FROM ipy_call
      WHERE user_id = $1
        AND direction = $2
        AND source = 'device'
        AND ended_at > now() - interval '2 minutes'
        AND abs(duration_seconds - $4::int) <= 120
        AND right(regexp_replace(
          CASE WHEN direction = 'outbound' THEN to_number ELSE from_number END,
          '\\D', '', 'g'
        ), 10) = $3
      ORDER BY ended_at DESC NULLS LAST
      LIMIT 1`,
    [input.userId, input.direction, numberTail, input.durationSeconds],
  ) : null;
  if (synced) {
    await db.query(
      `UPDATE ipy_call
          SET disposition = COALESCE($2, disposition),
              notes = COALESCE($3, notes),
              record_id = COALESCE($4, record_id),
              record_module = COALESCE($5, record_module),
              disposition_at = CASE WHEN $2::text IS NULL THEN disposition_at ELSE now() END
        WHERE id = $1`,
      [synced.id, input.disposition ?? null, input.notes ?? null, input.recordId, input.module],
    );
    return { callId: synced.id };
  }
  // $7 is read twice, so it needs the same deduced type in both places. `$7 || ' seconds'`
  // made it text while duration_seconds made it integer, and Postgres rejected the whole
  // statement with "inconsistent types deduced for parameter $7" — every manual call log
  // returned a 500. make_interval takes the integer directly.
  const row = await db.queryOne<{ id: string }>(
    /*
      `disposition_at` is stamped here too, not only by the disposition button.

      Without a telephony provider the call dialog logs the call and its
      outcome in one request, which is how every call the team makes is
      recorded — so the column that says "when was the outcome decided" was
      null on all of them, and anything grouping by it saw no outcomes at all.
      It is the moment of the log, because that is when the rep answered.
    */
    `INSERT INTO ipy_call
      (direction, from_number, to_number, user_id, record_id, record_module,
       status, duration_seconds, provider, source, disposition, disposition_at,
       notes, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,'completed',$7::int,'manual','manual',$8,
             CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, $9,
             now() - make_interval(secs => $7::int), now())
     RETURNING id`,
    [
      input.direction,
      input.direction === 'outbound' ? (agent?.phone ?? 'agent') : input.toNumber,
      input.direction === 'outbound' ? input.toNumber : (agent?.phone ?? 'agent'),
      input.userId, input.recordId, input.module,
      input.durationSeconds, input.disposition ?? null, input.notes ?? null,
    ],
  );

  if (input.recordId) {
    await touchActivity(input.recordId);
    await markContacted(input.recordId, { attempt: true });
  }

  bus.emitAsync('call.ended', {
    callId: row!.id, direction: input.direction, status: 'completed',
    recordId: input.recordId, userId: input.userId,
  });

  return { callId: row!.id };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c
  ));
}
