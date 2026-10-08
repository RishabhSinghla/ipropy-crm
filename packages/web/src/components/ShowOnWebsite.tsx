import { type JSX, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe } from 'lucide-react';
import type { ModuleMeta, RecordEnvelope } from '@ipropy/shared';
import { api } from '../lib/api';
import { invalidateRecordQueries } from '../lib/invalidate';
import { toast } from '../lib/store';
import { DropdownItem, Toggle } from './ui';

/*
  The tick that puts an inventory on the property portal, property.ipropy.com.

  **1 October 2026, the owner:** only the properties staff tick go public. The
  tick is the `publish_to_web` field, which production keeps hidden from the
  forms — so without these controls there was no way to set it at all. Two
  places offer it, one decision behind both: the record's More menu, and a
  switch at the top of the right-hand details pane (8 October 2026, the owner:
  *"show in the right details pane that toggle nicely"*).

  Offered only where the server says the record can go on the portal, and only
  to somebody who may edit it. The server is asked rather than the screen's
  field list, because that list leaves hidden fields out — which is why the
  menu item was invisible on production the day it shipped. What a buyer then
  sees is decided on the server (core/sharing/publicListings.ts), and the
  seller's name and number are never part of it.
*/

/** Where a published property can be seen, so the team can check it as a buyer would. */
export const PORTAL_ADDRESS = 'https://property.ipropy.com';

/** The field the switch writes. The portal's own feed reads the same name. */
const WEBSITE_FIELD = 'publish_to_web';

/** The switch's state and the one way to flip it, shared by the menu item and the pane row. */
function useWebsiteSwitch(module: ModuleMeta, record: RecordEnvelope) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const canEdit = Boolean(record.can?.edit);
  const { data: state } = useQuery({
    queryKey: ['website', module.name, record.id],
    queryFn: () => api.websiteState(module.name, record.id),
    enabled: canEdit,
  });

  const flip = async () => {
    if (!state || saving) return;
    const goingLive = !state.shown;
    setSaving(true);
    try {
      await api.update(module.name, record.id, { [WEBSITE_FIELD]: goingLive });
      invalidateRecordQueries(qc, module.name, record.id);
      await qc.invalidateQueries({ queryKey: ['website', module.name, record.id] });
      toast.success(goingLive ? 'Shown on the website' : 'Taken off the website', goingLive
        ? 'Buyers see the facts and photos — never the seller. It appears within a minute.'
        : 'Buyers can no longer find it.');
    } catch (err) {
      toast.error('Could not change that', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return { offered: canEdit && Boolean(state?.offered), shown: Boolean(state?.shown), saving, flip };
}

/** The item in the record's More menu. */
export function ShowOnWebsiteItem({ module, record, close }: {
  module: ModuleMeta;
  record: RecordEnvelope;
  close: () => void;
}): JSX.Element | null {
  const website = useWebsiteSwitch(module, record);
  if (!website.offered) return null;
  return (
    <DropdownItem icon={<Globe className="h-3.5 w-3.5" />} onClick={() => { close(); void website.flip(); }}>
      {website.saving ? 'Saving…' : website.shown ? 'Hide from website' : 'Show on website'}
    </DropdownItem>
  );
}

/** The switch at the top of the right-hand details pane, with a link to the live page when it is on. */
export function ShowOnWebsiteRow({ module, record }: { module: ModuleMeta; record: RecordEnvelope }): JSX.Element | null {
  const website = useWebsiteSwitch(module, record);
  if (!website.offered) return null;
  return (
    <div className="flex items-center gap-2" data-testid="website-switch">
      <span className="flex w-28 shrink-0 items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <Globe className="h-3 w-3" /> On website
      </span>
      <Toggle
        checked={website.shown}
        disabled={website.saving}
        onChange={() => { void website.flip(); }}
        ariaLabel={website.shown ? 'Shown on the website — switch off to hide it' : 'Not on the website — switch on to show it'}
      />
      <span className="text-xs text-slate-600 dark:text-slate-300">
        {website.saving ? 'Saving…' : website.shown ? 'Live' : 'Hidden'}
      </span>
      {website.shown && !website.saving && (
        <a
          href={`${PORTAL_ADDRESS}/properties/${record.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          View <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

/** True for the field the switch owns, so the pane does not draw it twice. */
export function isWebsiteField(name: string): boolean {
  return name === WEBSITE_FIELD;
}
