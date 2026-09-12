/**
 * What a list row says, worked out from metadata.
 *
 * Kept apart from the components that draw it so it can be tested without a
 * browser — these are the rules that decide whether a rep can recognise
 * somebody at a glance, and they are worth pinning. Nothing here imports React.
 */
import type { FieldMeta, RecordEnvelope } from '@ipropy/shared';
import { toInternational } from '@ipropy/shared';

/*
  Eight hues, picked by name.

  A contacts app gives every person a colour and it is the same colour every
  time, which is most of how you find somebody in a list without reading. Hue
  rather than an arbitrary palette so the set stays coherent, and one fixed
  saturation and lightness so white text clears contrast on all eight.
*/
const HUES = [210, 268, 330, 12, 32, 152, 190, 250];

export function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return HUES[Math.abs(hash) % HUES.length];
}

/** Initials the way a phone does it: first letter of the first and last word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * The line under the name.
 *
 * A number and where they have got to — the two things a rep wants before
 * deciding whether to tap. Both are found through metadata rather than named:
 * the number is whichever field is a phone, and the stage is the module's own
 * `pipelineField`, which already means "the field this module's progress is
 * tracked on". A module with neither shows its first filled-in dropdown.
 *
 * `display` before `values`, always. The raw value of a phone is national
 * digits with no country and of a reference is a UUID — showing either is how
 * a list ends up with a row of identifiers under every name.
 */
export function secondLine(
  row: Pick<RecordEnvelope, 'label' | 'values' | 'display'>,
  fields: Map<string, FieldMeta>,
  pipelineField: string | null,
): string {
  const parts: string[] = [];

  const shown = (name: string): string | null => {
    const raw = row.display?.[name] ?? row.values[name];
    if (raw === null || raw === undefined || raw === '') return null;
    if (Array.isArray(raw) && !raw.length) return null;
    const text = String(raw);
    // The label repeated under itself reads as a rendering fault.
    return text === row.label ? null : text;
  };

  for (const [name, field] of fields) {
    if (field.uitype !== 'phone') continue;
    const text = shown(name);
    if (text) { parts.push(text); break; }
  }

  const stage = pipelineField ? shown(pipelineField) : null;
  if (stage) parts.push(stage);

  if (!parts.length) {
    for (const [name, field] of fields) {
      if (field.uitype !== 'picklist') continue;
      const text = shown(name);
      if (text) { parts.push(text); break; }
    }
  }

  return parts.join(' · ');
}

/**
 * The first phone-shaped field on the record, in the form a dialler wants.
 *
 * A number is two fields here — a country picklist and the national digits
 * (migration 026). `toInternational` is the one place that knows how to put
 * them back together, and writing that out by hand is how the lead-capture
 * path silently threw away every automated lead for weeks.
 */
export function phoneOf(
  row: Pick<RecordEnvelope, 'values'>,
  fields: Map<string, FieldMeta>,
): string | null {
  for (const [name, field] of fields) {
    if (field.uitype !== 'phone') continue;
    const value = row.values[name];
    if (!value) continue;
    const countryField = String(field.config?.countryField ?? 'country_code');
    const country = String(row.values[countryField] ?? 'India');
    return toInternational(country, String(value));
  }
  return null;
}

/**
 * A time a person reads at a glance: the clock today, the day this week, a
 * date beyond that. The rule every messaging list uses.
 */
export function shortTime(iso: string, now = new Date()): string {
  const then = new Date(iso);
  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  }
  const days = (now.getTime() - then.getTime()) / 86_400_000;
  if (days < 7) return then.toLocaleDateString('en-IN', { weekday: 'short' });
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
