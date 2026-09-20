/**
 * Sending one template to many people, without repeating the worst thing this
 * CRM has ever done.
 *
 * On 13 and 16 September a *daily* workflow whose condition list had emptied
 * itself queued 40,515 WhatsApp messages — 20,209 people holding two each —
 * and nobody received one only because no provider was connected. Luck, not a
 * safeguard. A campaign is deliberately "message many people", so the
 * protection cannot be "refuse to match everybody". It is these, and only a
 * real database can answer them:
 *
 *  * **the audience is frozen at approval**, so a saved view widened
 *    afterwards cannot grow a campaign that is already running;
 *  * **once per number**, not once per record — two contacts sharing a
 *    husband-and-wife phone are one person holding one handset;
 *  * **anybody who cannot be reached is a row saying why**, because the
 *    birthday messages were invisible until somebody thought to count them;
 *  * **the count is the one that was approved**, checked against the audience
 *    as it stands at that moment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import {
  approveCampaign, createCampaign, previewCampaign, setCampaignStatus,
  campaignRecipients, listCampaigns,
} from '../../src/integrations/whatsapp/business/campaigns.js';
import { saveMapping } from '../../src/integrations/whatsapp/business/templates.js';
import { invalidate as reloadIntegrations } from '../../src/core/settings/integrations.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const MARKER = `Campaign ${stamp}`;
const TEMPLATE = `campaign_offer_${stamp}`;
const SHARED_NUMBER = `97${String(stamp).slice(-8)}`;

let ctx: Awaited<ReturnType<typeof adminContext>>;
let templateId = '';
let campaignId = '';
const created: string[] = [];

/** Everybody this test made, and nobody else's records. */
const audience = { filter: { logic: 'AND' as const, conditions: [
  { field: 'full_name', operator: 'contains' as const, value: MARKER },
] } };

async function lead(name: string, phones: { mobile?: string; alternate?: string }): Promise<string> {
  const row = await recordService.createRecord(ctx, 'leads', {
    full_name: `${MARKER} ${name}`,
    ...(phones.mobile ? { mobile: phones.mobile } : {}),
    ...(phones.alternate ? { alternate_phone: phones.alternate } : {}),
    // A contact needs a mobile *or* an email, so the ones with no WhatsApp
    // number here are reachable some other way — which is exactly the person a
    // campaign has to skip rather than fail on.
    ...(phones.mobile ? {} : { email: `${name.toLowerCase()}.${stamp}@example.test` }),
    status: 'New',
  });
  created.push(row.id);
  return row.id;
}

beforeAll(async () => {
  ctx = await adminContext();

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_whatsapp_template (name, language, category, status, body_text)
     VALUES ($1, 'en', 'MARKETING', 'APPROVED', 'Hello {{1}}, we have something for you.')
     RETURNING id`,
    [TEMPLATE],
  );
  templateId = row!.id;
  await saveMapping(templateId, 'leads', { 1: 'field:full_name' });

  await lead('One', { mobile: `98${String(stamp).slice(-8)}` });
  await lead('Two', { mobile: SHARED_NUMBER });
  /*
    The same handset as Two, reached through a different field — which is the
    only way this happens, because `createRecord` already refuses a second
    record with the same *mobile*. An alternate number matching somebody
    else's mobile is nobody's mistake and is not checked anywhere, and an
    import bypasses the duplicate check entirely.
  */
  await lead('Three', { alternate: SHARED_NUMBER });
  // No number at all.
  await lead('Four', {});

  const campaign = await createCampaign({
    name: MARKER, module: 'leads', templateId, audience, userId: ctx.user.id,
  });
  campaignId = campaign.id;

  /*
    Switch a provider on the way an admin does — a row in `ipy_integration`,
    then the snapshot reloaded. Without one `approveCampaign` refuses, and
    freezing the audience is the behaviour this file exists to prove. It sends
    nothing: `sendCampaignBatch` is never called here, and the credentials
    below are not real.
  */
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_integration WHERE provider = 'whatsapp_whatsmarketing'`,
  );
  if (existing) {
    await db.query(`UPDATE ipy_integration SET is_active = true WHERE id = $1`, [existing.id]);
  } else {
    await db.query(
      `INSERT INTO ipy_integration (provider, kind, label, is_active, config, credentials)
       VALUES ('whatsapp_whatsmarketing', 'whatsapp', 'whatsmarketing.in', true, '{}'::jsonb, '{}'::jsonb)`,
    );
  }
  await reloadIntegrations();
});

afterAll(async () => {
  if (campaignId) await db.query(`DELETE FROM ipy_campaign WHERE id = $1`, [campaignId]);
  await db.query(`DELETE FROM ipy_whatsapp_template WHERE id = $1`, [templateId]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = 'whatsapp_whatsmarketing'`);
  await reloadIntegrations();
  for (const id of created) {
    await db.query(`DELETE FROM ipy_record WHERE id = $1`, [id]).catch(() => undefined);
  }
});

describe('before anything is sent', () => {
  it('counts everybody, and separately counts who can actually be reached', async () => {
    const preview = await previewCampaign({
      ctx, module: 'leads', audience, templateId, agentName: 'Tester', samples: 10,
    });

    // Four records; three numbers between them; two of those are the same
    // handset, so two people can be reached.
    expect(preview.total).toBe(4);
    expect(preview.reachable).toBe(2);
  });

  it('shows the wording a customer would actually read', async () => {
    const preview = await previewCampaign({
      ctx, module: 'leads', audience, templateId, agentName: 'Tester', samples: 10,
    });
    const one = preview.sample.find((row) => row.label.endsWith('One'));
    expect(one?.preview).toBe(`Hello ${MARKER} One, we have something for you.`);
    expect(one?.missing).toEqual([]);
  });

  it('says when a blank has nothing mapped to it, because then nobody gets anything', async () => {
    /*
      The bug this pins, found in a browser on 20 September 2026: an unmapped
      blank made every one of 84 sample rows read "Will be skipped" while the
      button still said **Send to 84**. `reachable` cannot see it — it counts
      who has a number — so the approver is shown a number, approves it, and
      not one message goes. That is the exact failure the whole feature exists
      to prevent, so the preview answers it separately.
    */
    await saveMapping(templateId, 'leads', {});
    const blank = await previewCampaign({
      ctx, module: 'leads', audience, templateId, agentName: 'Tester', samples: 10,
    });
    expect(blank.reachable, 'people with a number is unchanged').toBe(2);
    expect(blank.unmapped.join(' ')).toMatch(/nothing is mapped to it/);

    // And a mapping that IS set says nothing — an empty field on one record is
    // a per-person skip, not a campaign that cannot go at all.
    await saveMapping(templateId, 'leads', { 1: 'field:full_name' });
    const filled = await previewCampaign({
      ctx, module: 'leads', audience, templateId, agentName: 'Tester', samples: 10,
    });
    expect(filled.unmapped).toEqual([]);
  });

  it('writes nothing while previewing', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM ipy_campaign_recipient WHERE campaign_id = $1`, [campaignId],
    );
    expect(rows, 'previewing queued somebody').toHaveLength(0);
  });
});

describe('approving it', () => {
  it('refuses a count the person was not shown', async () => {
    await expect(approveCampaign({
      ctx, userId: ctx.user.id, campaignId, expectedCount: 4,
    })).rejects.toThrow(/not the 4 you were shown/);
  });

  it('freezes one row per person, and writes down why the others were left out', async () => {
    const frozen = await approveCampaign({
      ctx, userId: ctx.user.id, campaignId, expectedCount: 2,
    });
    expect(frozen.frozen).toBe(2);
    expect(frozen.skipped).toBe(2);

    const everyone = await campaignRecipients(campaignId);
    const pending = everyone.filter((row) => row.status === 'pending');
    const skipped = everyone.filter((row) => row.status === 'skipped');
    expect(pending).toHaveLength(2);

    // Not a silence: each one says which person and why.
    expect(skipped.map((row) => row.error).sort()).toEqual([
      'another record in this audience has the same number',
      'no WhatsApp number on the record',
    ]);
  });

  it('will not grow when the audience does', async () => {
    /*
      **The rule this whole feature turns on.** Somebody widens the saved view,
      or ten leads arrive from the website, while the campaign is running. It
      must reach exactly the people it was approved for — nothing re-reads the
      audience after this point.
    */
    await lead('Five', { mobile: `95${String(stamp).slice(-8)}` });

    const stillMatching = await previewCampaign({
      ctx, module: 'leads', audience, templateId, agentName: 'Tester', samples: 10,
    });
    expect(stillMatching.reachable, 'the audience did not actually widen').toBe(3);

    const queued = (await campaignRecipients(campaignId)).filter((row) => row.status === 'pending');
    expect(queued, 'a running campaign grew when the audience did').toHaveLength(2);
  });

  it('cannot be approved twice', async () => {
    await expect(approveCampaign({
      ctx, userId: ctx.user.id, campaignId, expectedCount: 2,
    })).rejects.toThrow(/Only a draft campaign/);
  });

  it('stops when it is cancelled, and remembers who never got it', async () => {
    await setCampaignStatus(campaignId, 'cancelled');
    const mine = (await listCampaigns()).find((row) => row.id === campaignId);
    expect(mine?.status).toBe('cancelled');
    // The people who did not get it are still on the record.
    expect((await campaignRecipients(campaignId)).filter((row) => row.status === 'pending'))
      .toHaveLength(2);
  });
});

describe('what the campaign remembers', () => {
  it('lists itself with its template and what became of each recipient', async () => {
    const mine = (await listCampaigns()).find((row) => row.id === campaignId);
    expect(mine?.templateName).toBe(TEMPLATE);
    expect(mine?.counts).toEqual({ pending: 2, sent: 0, failed: 0, skipped: 2 });
    expect(mine?.approvedCount).toBe(2);
  });

  it('cannot be resumed once it is finished', async () => {
    await expect(setCampaignStatus(campaignId, 'running'))
      .rejects.toThrow(/finished/);
  });
});
