import type { JSX } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import type { ModuleMeta } from '@ipropy/shared';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import RecordForm from '../components/RecordForm';
import { Skeleton } from '../components/ui';

/**
 * Defaults the metadata already declares, applied client-side so the user sees
 * them rather than discovering them after saving.
 *
 * The server applies the same values on create; doing it here too is about the
 * form showing "New" in the status box from the moment it opens.
 */
function defaultsFromMetadata(meta: ModuleMeta | undefined): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const field of meta.fields) {
    if (!field.isActive || field.isReadonly) continue;
    if (field.defaultValue !== null && field.defaultValue !== undefined) {
      out[field.name] = field.defaultValue;
    } else if (field.uitype === 'picklist' || field.uitype === 'radio') {
      const preset = field.options?.find((o) => o.isDefault);
      if (preset) out[field.name] = preset.value;
    }
  }
  return out;
}

export default function RecordEdit(): JSX.Element {
  const { module: moduleName, id } = useParams<{ module: string; id?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useApp();
  const isCreate = !id;
  const returnTo = searchParams.get('return');

  const { data: meta } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName!),
    enabled: Boolean(moduleName),
  });

  const { data: record, isLoading } = useQuery({
    queryKey: ['record', moduleName, id],
    queryFn: () => api.record(moduleName!, id!),
    enabled: Boolean(!isCreate && moduleName && id),
  });

  // Query-string values pre-fill the form — used by "Add" on related lists.
  const queryDefaults = Object.fromEntries(
    [...searchParams.entries()].filter(([k]) => k !== 'view' && k !== 'return'),
  );

  /**
   * Everything mandatory that has an obvious answer, filled in already.
   *
   * Picklist defaults and `default_value` come from metadata and are applied by
   * the server. The one it cannot know is the owner: whoever is creating a lead
   * is almost always the person who will work it, and making them pick
   * themselves from a list on every single lead is pure friction.
   */
  const initialValues = {
    ...(isCreate && user ? { owner_id: user.id } : {}),
    ...defaultsFromMetadata(meta),
    ...queryDefaults,
  };

  if (!meta || (!isCreate && isLoading)) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="btn-ghost -ml-2 p-1.5">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h1 className="text-lg font-semibold tracking-tight">
          {isCreate ? `New ${meta.singularLabel}` : `Edit ${record?.label ?? meta.singularLabel}`}
        </h1>
      </div>

      <RecordForm
        module={meta}
        record={record}
        initialValues={isCreate ? initialValues : undefined}
        onSaved={(saved) => {
          toast.success(isCreate ? `${meta.singularLabel} created` : 'Changes saved', saved.label);
          if (!isCreate) {
            navigate(`/${moduleName}/${saved.id}`);
            return;
          }
          // Back to the list after creating, not into the new record. Adding a
          // lead is usually one of several — from a call, a portal batch, a
          // walk-in — and being dropped into a detail page you did not ask for
          // means navigating back before you can add the next one.
          //
          // `return` carries the list state the user came from, so the filter
          // and sort they had set are still there.
          navigate(returnTo ?? `/${moduleName}`);
        }}
        onCancel={() => (returnTo ? navigate(returnTo) : navigate(-1))}
      />
    </div>
  );
}
