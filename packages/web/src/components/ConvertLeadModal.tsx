import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RecordEnvelope } from '@ipropy/shared';
import { formatIndianPrice } from '@ipropy/shared';
import { UserCheck } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { Modal, Spinner, Toggle } from './ui';
import { ReferencePicker } from './FieldRenderer';

export default function ConvertLeadModal({
  record, onClose, onConverted,
}: {
  record: RecordEnvelope;
  onClose: () => void;
  onConverted: (result: { contactId: string; dealId: string | null; organizationId: string | null }) => void;
}): JSX.Element {
  // Contacts are merged into Leads, so conversion no longer creates a second
  // person record — it advances this record's lifecycle and opens a deal.
  const [createOrganization, setCreateOrganization] = useState(Boolean(record.values.company));
  const [createDeal, setCreateDeal] = useState(true);
  const [dealName, setDealName] = useState(
    `${record.label}${record.display?.interested_project_id ? ` — ${record.display.interested_project_id}` : ''}`,
  );
  const [dealAmount, setDealAmount] = useState<number | null>(
    (record.values.budget_max as number) ?? (record.values.budget_min as number) ?? null,
  );
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: stages } = useQuery({
    queryKey: ['picklist', 'deal_stage'],
    queryFn: () => api.picklist('deal_stage'),
  });
  const [stage, setStage] = useState('Enquiry');

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.convert('leads', record.id, {
        createOrganization, createDeal,
        dealName, dealAmount, dealStage: stage,
        propertyId: propertyId ?? undefined,
      });
      onConverted(result);
    } catch (err) {
      toast.error('Conversion failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const propertyField = {
    id: 'prop', moduleId: '', moduleName: '', blockId: null, name: 'property_id',
    label: 'Unit', uitype: 'reference' as const, storage: 'column' as const, columnName: 'property_id',
    sequence: 0, isMandatory: false, isReadonly: false, isUnique: false, isCustom: false, isActive: true,
    displayType: 'default' as const, defaultValue: null, maxLength: null, helpText: null,
    config: { referenceModules: ['properties'] }, quickCreate: false, massEditable: true, searchable: false,
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Convert ${record.label}`}
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner /> : <UserCheck className="h-4 w-4" />}
            Convert lead
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          This record becomes the customer — its entire history stays in one place. Converting moves
          the lifecycle from <strong>Lead</strong> to <strong>Prospect</strong> and opens a deal against it.
        </p>

        <div className="space-y-2.5 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <Toggle
            checked={createOrganization}
            onChange={setCreateOrganization}
            label={`Link an Organisation${record.values.company ? ` (${record.values.company})` : ''}`}
            disabled={!record.values.company}
          />
          <Toggle checked={createDeal} onChange={setCreateDeal} label="Open a Deal" />
        </div>

        {createDeal && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div>
              <label className="label">Deal name</label>
              <input className="input" value={dealName} onChange={(e) => setDealName(e.target.value)} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Deal value</label>
                <input
                  type="number"
                  className="input tnum"
                  value={dealAmount ?? ''}
                  onChange={(e) => setDealAmount(e.target.value ? Number(e.target.value) : null)}
                />
                {dealAmount ? (
                  <p className="mt-1 text-2xs text-muted">{formatIndianPrice(dealAmount)}</p>
                ) : null}
              </div>

              <div>
                <label className="label">Starting stage</label>
                <select className="input" value={stage} onChange={(e) => setStage(e.target.value)}>
                  {(stages ?? []).map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="label">Link a unit (optional)</label>
              <ReferencePicker
                field={propertyField as never}
                value={propertyId}
                onChange={setPropertyId}
                placeholder="Search available inventory…"
              />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
