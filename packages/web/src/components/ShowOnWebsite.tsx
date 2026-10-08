import { type JSX, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import type { ModuleMeta, RecordEnvelope } from '@ipropy/shared';
import { api } from '../lib/api';
import { invalidateRecordQueries } from '../lib/invalidate';
import { toast } from '../lib/store';
import { DropdownItem } from './ui';

/*
  The tick that puts an inventory on the property portal.

  **1 October 2026, the owner:** only the properties staff tick go public. The
  tick is the `publish_to_web` field, which production keeps hidden from the
  forms — so without this item there was no way to set it at all. Offered only
  where the server says the record can go on the portal, and only to somebody
  who may edit it. The server is asked rather than the screen's field list,
  because that list leaves hidden fields out — which is why this item was
  invisible on production the day it shipped.
  What a buyer then sees is decided on the server (core/sharing/publicListings.ts),
  and the seller's name and number are never part of it.
*/
export function ShowOnWebsiteItem({ module, record, close }: {
  module: ModuleMeta;
  record: RecordEnvelope;
  close: () => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const canEdit = Boolean(record.can?.edit);
  const { data: state } = useQuery({
    queryKey: ['website', module.name, record.id],
    queryFn: () => api.websiteState(module.name, record.id),
    enabled: canEdit,
  });
  if (!canEdit || !state?.offered) return null;

  const isShown = state.shown;

  const toggle = async () => {
    close();
    setSaving(true);
    try {
      await api.update(module.name, record.id, { publish_to_web: !isShown });
      invalidateRecordQueries(qc, module.name, record.id);
      void qc.invalidateQueries({ queryKey: ['website', module.name, record.id] });
      toast.success(isShown ? 'Taken off the website' : 'Shown on the website', isShown
        ? 'Buyers can no longer find it.'
        : 'Buyers see the facts and photos — never the seller.');
    } catch (err) {
      toast.error('Could not change that', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownItem icon={<Globe className="h-3.5 w-3.5" />} onClick={() => { void toggle(); }}>
      {saving ? 'Saving…' : isShown ? 'Hide from website' : 'Show on website'}
    </DropdownItem>
  );
}
