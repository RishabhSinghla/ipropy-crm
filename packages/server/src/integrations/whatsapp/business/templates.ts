/**
 * Approved templates, and what fills their blanks.
 *
 * A WhatsApp template is positional — `{{1}}`, `{{2}}` — and approved by Meta
 * with its wording fixed. The only thing the CRM decides is what goes in the
 * gaps, and that decision is **metadata, not code**: `{{1}} → Full Name` is a
 * row an admin sets, read through the same Field Manager every other screen
 * reads. Hard-coding a field name here would mean a rename in the UI silently
 * emptying a template that goes to customers.
 *
 * Two rules worth stating plainly:
 *
 *  * **A sync never overwrites a mapping.** The provider owns the wording and
 *    the approval status; the CRM owns what fills the blanks. Re-syncing to
 *    pick up a new template must not wipe the mapping somebody set on the
 *    other twelve — this is the same create-only rule the seed follows, and
 *    for the same reason.
 *  * **A template with an unfilled blank is not sent.** WhatsApp rejects it
 *    anyway, but the CRM has to say *which* field was empty on *which* record,
 *    because "message failed" tells a rep nothing they can act on.
 */
import { db } from '../../../db/pool.js';
import { BadRequestError } from '../../../utils/errors.js';
import { registry } from '../../../core/metadata/registry.js';
import { recordService } from '../../../core/entity/recordService.js';
import type { ScopeContext } from '../../../core/permissions/index.js';
import { activeBusinessProvider } from './registry.js';
import { countVariables } from './metaCloud.js';

/**
 * What a `{{n}}` may be filled from.
 *
 * `field:` is the ordinary case and goes through metadata. The other three
 * exist because a template's blanks are not all about the customer: the agent
 * signing off, the business name, and a fixed word the template needs but
 * Meta would not approve inside the body.
 */
export type MappingSource = `field:${string}` | 'agent:name' | 'org:name' | `text:${string}`;

export interface StoredTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  variableCount: number;
  /** `{ "1": "field:full_name", "2": "agent:name" }` */
  variableMap: Record<string, string>;
  providerTemplateId: string | null;
}

export async function listStoredTemplates(): Promise<StoredTemplate[]> {
  const { rows } = await db.query<{
    id: string; name: string; language: string; category: string; status: string;
    body_text: string; variable_map: Record<string, string>; provider_template_id: string | null;
  }>(
    `SELECT id, name, language, category, status, body_text, variable_map, provider_template_id
       FROM ipy_whatsapp_template
      ORDER BY status DESC, name`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    bodyText: row.body_text,
    variableCount: countVariables(row.body_text),
    variableMap: row.variable_map ?? {},
    providerTemplateId: row.provider_template_id,
  }));
}

/**
 * Pull the approved list from whichever provider is switched on.
 *
 * Returns what changed rather than a bare count, because "synced 14" answers
 * nothing when somebody is looking for the template they had approved this
 * morning.
 */
export async function syncTemplates(): Promise<{ added: string[]; updated: string[]; skipped: string }> {
  const provider = activeBusinessProvider();
  if (!provider) throw new BadRequestError('No official WhatsApp provider is switched on.');
  if (!provider.capabilities.has('templateSync')) {
    return {
      added: [],
      updated: [],
      // AiSensy publishes no template list, so its templates are added by hand
      // and this says so rather than reporting an empty success.
      skipped: `${provider.name} does not hand its template list back, so add them here by name.`,
    };
  }

  const remote = await provider.listTemplates();
  const added: string[] = [];
  const updated: string[] = [];

  for (const template of remote) {
    if (!template.name || !template.bodyText) continue;
    const row = await db.queryOne<{ id: string; inserted: boolean }>(
      `INSERT INTO ipy_whatsapp_template
         (name, language, category, status, body_text, provider_template_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name, language) DO UPDATE
         SET category = EXCLUDED.category,
             status = EXCLUDED.status,
             body_text = EXCLUDED.body_text,
             provider_template_id = EXCLUDED.provider_template_id
             -- variable_map is deliberately absent: the provider owns the
             -- wording, the CRM owns what fills the blanks, and a sync that
             -- wiped somebody's mapping would be a message going out with
             -- empty gaps.
       RETURNING id, (xmax = 0) AS inserted`,
      [
        template.name, template.language, template.category, template.status,
        template.bodyText, template.providerTemplateId,
      ],
    );
    (row?.inserted ? added : updated).push(`${template.name} (${template.language})`);
  }

  return { added, updated, skipped: '' };
}

/** An admin setting what fills the blanks. Checked against real fields, now. */
export async function saveMapping(
  templateId: string, module: string, map: Record<string, string>,
): Promise<void> {
  const meta = await registry.getModule(module);
  if (!meta) throw new BadRequestError(`There is no module called "${module}".`);
  const known = new Set(meta.fields.map((field) => field.name));

  for (const [slot, source] of Object.entries(map)) {
    if (!/^\d+$/.test(slot)) throw new BadRequestError(`"${slot}" is not a template position.`);
    if (source.startsWith('field:')) {
      const name = source.slice('field:'.length);
      if (!known.has(name)) {
        // Caught here rather than at send time, when the customer is waiting
        // and the only clue is a provider's rejection code.
        throw new BadRequestError(`There is no field called "${name}" on ${module}.`);
      }
    } else if (!['agent:name', 'org:name'].includes(source) && !source.startsWith('text:')) {
      throw new BadRequestError(`"${source}" is not something a template can be filled from.`);
    }
  }

  const row = await db.queryOne<{ id: string }>(
    `UPDATE ipy_whatsapp_template SET variable_map = $2::jsonb WHERE id = $1 RETURNING id`,
    [templateId, JSON.stringify(map)],
  );
  if (!row) throw new BadRequestError('No such template.');
}

export interface ResolvedTemplate {
  name: string;
  language: string;
  params: string[];
  /** The body with the blanks filled, so somebody can read it before it goes. */
  preview: string;
  /** Positions the mapping leaves empty — the reason a send is refused. */
  missing: { slot: string; reason: string }[];
}

/**
 * Fill one template for one record.
 *
 * The record is read through `recordService`, so field permissions, sharing
 * rules and the role hierarchy all apply: a rep who cannot see a lead's budget
 * cannot send it to a customer through a template either.
 */
export async function resolveTemplate(input: {
  ctx: ScopeContext;
  templateId: string;
  module: string;
  recordId: string;
  agentName: string;
  orgName: string;
}): Promise<ResolvedTemplate> {
  const template = await db.queryOne<{
    name: string; language: string; body_text: string; variable_map: Record<string, string>;
  }>(
    `SELECT name, language, body_text, variable_map FROM ipy_whatsapp_template WHERE id = $1`,
    [input.templateId],
  );
  if (!template) throw new BadRequestError('No such template.');

  const record = await recordService.getRecord(input.ctx, input.module, input.recordId);
  const slots = countVariables(template.body_text);
  const map = template.variable_map ?? {};

  const params: string[] = [];
  const missing: { slot: string; reason: string }[] = [];

  for (let index = 1; index <= slots; index += 1) {
    const slot = String(index);
    const source = map[slot];
    if (!source) {
      missing.push({ slot, reason: 'nothing is mapped to it' });
      params.push('');
      continue;
    }

    let value = '';
    if (source === 'agent:name') value = input.agentName;
    else if (source === 'org:name') value = input.orgName;
    else if (source.startsWith('text:')) value = source.slice('text:'.length);
    else if (!source.startsWith('field:')) {
      /*
        A mapping written in an older vocabulary — the seeded templates from
        before the WhatsApp removal say `contact.first_name`, which names a
        field that no longer exists under a prefix this code does not speak.
        Reported as needing re-mapping rather than sliced blindly: slicing
        `contact.first_name` by six characters yields nonsense, looks up
        nothing, and sends a customer a blank.
      */
      missing.push({ slot, reason: `"${source}" is an old mapping and needs setting again` });
      params.push('');
      continue;
    } else {
      const name = source.slice('field:'.length);
      // The display value first: a picklist's stored value and a reference's
      // uuid are both the wrong thing to put in front of a customer.
      const display = (record.display ?? {})[name];
      const raw = record.values[name];
      value = String(display ?? (Array.isArray(raw) ? raw.join(', ') : raw ?? ''));
    }

    // WhatsApp rejects a parameter carrying a newline or a run of spaces, and
    // the rejection names none of this — so it is fixed here rather than
    // debugged there.
    value = value.replace(/\s+/g, ' ').trim();
    if (!value) missing.push({ slot, reason: `${source} is empty on this record` });
    params.push(value);
  }

  const preview = template.body_text.replace(
    /\{\{\s*(\d+)\s*\}\}/g,
    (_match, index: string) => params[Number(index) - 1] || `{{${index}}}`,
  );

  return { name: template.name, language: template.language, params, preview, missing };
}

/**
 * The business's own name, for a template slot that asks for it.
 *
 * One reading of `org.name` — the same value the app header shows — so
 * renaming the business renames it everywhere at once. It falls back to the
 * product name rather than to an empty gap, because an approved template with
 * a blank in it is refused by WhatsApp.
 */
export async function organisationName(): Promise<string> {
  const row = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'org.name'`,
  );
  return (typeof row?.value === 'string' && row.value.trim()) || 'iPropy';
}
