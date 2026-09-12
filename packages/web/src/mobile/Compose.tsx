/**
 * Adding something, as one column you fill top to bottom.
 *
 * The fields are the module's quick-create layout — the same short list the
 * site-visit screen uses and the same one an admin arranges in Layout Designer.
 * Not the full form: a nine-field grid is what makes somebody give up and
 * decide to "add it tonight", which is how a lead is lost.
 *
 * Save sits in the bar at the top rather than at the bottom of the form,
 * because on a phone the bottom of a form is wherever the keyboard is not.
 */
import { type JSX, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { collectFieldErrors, type FieldMeta, type LayoutConfig } from '@ipropy/shared';
import { api, ApiError } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { startingValues } from '../lib/recordDefaults';
import { invalidateRecordQueries } from '../lib/invalidate';
import { FieldInput } from '../components/FieldRenderer';
import { Spinner } from '../components/ui';
import { AppBar } from './primitives';

export default function MobileCompose(): JSX.Element {
  const { module = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: meta } = useQuery({
    queryKey: ['module', module],
    queryFn: () => api.module(module),
    staleTime: 5 * 60_000,
  });

  const me = useApp((st) => st.user);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [touched, setTouched] = useState(false);

  /*
    The same rule the site-visit screen uses, and deliberately identical to it:
    the quick-create layout an admin arranged, falling back to the fields
    flagged for quick create when no layout row exists.

    The type is `quick_create` with the underscore. Spelled without it, no
    layout is ever found, the fallback runs, and the form quietly shows a
    different — shorter — set of fields than the one somebody configured. It
    did exactly that here and the missing field was the phone number, which is
    the one thing a contact cannot be created without.
  */
  const fields = useMemo<FieldMeta[]>(() => {
    if (!meta) return [];
    const quick = meta.layouts?.find((l) => l.type === 'quick_create' && l.is_default)
      ?? meta.layouts?.find((l) => l.type === 'quick_create');
    const config = quick?.config as LayoutConfig | undefined;
    const byName = new Map(meta.fields.map((f) => [f.name, f]));

    const configured = config?.blocks?.flatMap((b) => b.fields) ?? [];
    const chosen = configured.length
      ? configured
      : meta.fields.filter((f) => f.quickCreate).map((f) => f.name);

    // A record cannot be created without its label. Keep this usable if an
    // admin drops it from quick create; everything else keeps their order.
    const labelField = meta.labelFields?.[0];
    const ordered = labelField && !chosen.includes(labelField) ? [labelField, ...chosen] : chosen;

    return ordered
      .map((n) => byName.get(n))
      .filter((f): f is FieldMeta => f !== undefined
        && f.displayType !== 'hidden'
        && f.uitype !== 'autonumber'
        && !f.isReadonly);
  }, [meta]);

  // Defaults an admin configured, not an empty object — a status that should
  // start at "New" must start at "New" here too.
  useEffect(() => {
    if (meta) setValues((v) => (Object.keys(v).length ? v : startingValues(meta, me?.id)));
  }, [meta, me?.id]);

  /*
    `collectFieldErrors` takes the fields being shown and the whole record it
    belongs to separately, because a rule can name a field this form does not
    display — a mandatory-when, a comparison between two dates. Passing the
    visible values as both would quietly skip those.
  */
  const errors = useMemo(() => {
    const found = new Map<string, string>();
    for (const e of collectFieldErrors(fields, values, values)) found.set(e.field, e.message);
    return found;
  }, [fields, values]);
  const invalid = errors.size > 0;

  const create = useMutation({
    mutationFn: () => api.create(module, values),
    onSuccess: async (row) => {
      await invalidateRecordQueries(queryClient, module);
      toast.success(`${meta?.singularLabel ?? 'Saved'} added`);
      navigate(`/${module}/${row.id}`, { replace: true });
    },
    onError: (err: Error) => toast.error(
      'Not saved',
      err instanceof ApiError ? err.message : 'Check your connection and try again.',
    ),
  });

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]">
      <AppBar
        title={`New ${(meta?.singularLabel ?? '').toLowerCase()}`.trim()}
        onBack={() => navigate(-1)}
        actions={(
          <button
            type="button"
            disabled={create.isPending || invalid}
            onClick={() => create.mutate()}
            className="mr-2 rounded-full bg-brand-600 px-4 py-2 text-[15px] font-semibold text-white disabled:opacity-40"
          >
            {create.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
        {!meta ? (
          <div className="flex h-40 items-center justify-center"><Spinner className="h-6 w-6 text-brand-600" /></div>
        ) : (
          <div className="space-y-5 py-4">
            {fields.map((field) => (
              <div key={field.name}>
                <label htmlFor={`f-${field.name}`} className="mb-1.5 block text-[13px] font-medium text-muted">
                  {field.label}
                  {field.isMandatory && <span className="ml-1 text-rose-500">*</span>}
                </label>
                <FieldInput
                  id={`f-${field.name}`}
                  field={field}
                  value={values[field.name] ?? null}
                  onChange={(v) => { setTouched(true); setValues((old) => ({ ...old, [field.name]: v })); }}
                  moduleName={module}
                />
                {touched && errors.get(field.name) && (
                  <p className="mt-1 text-[13px] text-rose-600">{errors.get(field.name)}</p>
                )}
              </div>
            ))}
            <div className="h-24" />
          </div>
        )}
      </div>
    </div>
  );
}
