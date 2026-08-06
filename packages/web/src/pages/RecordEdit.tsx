import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import RecordForm from '../components/RecordForm';
import { Skeleton } from '../components/ui';

export default function RecordEdit(): JSX.Element {
  const { module: moduleName, id } = useParams<{ module: string; id?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isCreate = !id;

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
  const initialValues = Object.fromEntries(
    [...searchParams.entries()].filter(([k]) => k !== 'view'),
  );

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
          navigate(`/${moduleName}/${saved.id}`);
        }}
        onCancel={() => navigate(-1)}
      />
    </div>
  );
}
