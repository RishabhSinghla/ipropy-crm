/**
 * What needs doing — follow-ups falling due, leads assigned to you, anything
 * the CRM decided was worth interrupting somebody for.
 *
 * A tab rather than a bell tucked into a header. It is the second thing a rep
 * opens the app for, after looking somebody up, and the web version buries it
 * in a dropdown that has to be opened deliberately. On a phone that is how a
 * follow-up goes cold.
 *
 * Tapping one goes where it points and marks it read. There is no other
 * gesture: no swipe to dismiss, no select-several, no "mark all read" hidden
 * behind a menu — an alert is either something you dealt with or something
 * still waiting, and the list should say which without being operated.
 */
import { type JSX, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { relativeTime } from '@ipropy/shared';
import { BellOff } from 'lucide-react';
import { api } from '../lib/api';
import { Spinner } from '../components/ui';
import { AppBar, Avatar, Row } from './primitives';

interface Alert {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  kind: string;
  created_at: string;
}

export default function MobileAlerts(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications(),
    // The same interval the web header uses. The socket pushes new ones as
    // they happen; this is the net under a dropped connection.
    refetchInterval: 40_000,
  });

  const markRead = useMutation({
    mutationFn: (ids: string[]) => api.markNotificationsRead(ids),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const alerts = (data?.notifications ?? []) as unknown as Alert[];
  const unread = data?.unreadCount ?? 0;

  /*
    Opening the screen does not mark everything read.

    A rep who glances at the tab on the way to something else has not dealt
    with anything, and a counter that empties itself on sight is a counter that
    stops being believed. Reading happens on the alert you actually open.
  */
  useEffect(() => { /* deliberately nothing */ }, [alerts.length]);

  const open = (alert: Alert): void => {
    if (!alert.is_read) markRead.mutate([alert.id]);
    if (alert.link?.startsWith('/')) navigate(alert.link);
  };

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]">
      <AppBar large title="Alerts" subtitle={unread ? `${unread} unread` : undefined} />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {isPending ? (
          <div className="flex h-40 items-center justify-center"><Spinner className="h-6 w-6 text-brand-600" /></div>
        ) : alerts.length === 0 ? (
          <div className="px-8 pt-20 text-center">
            <BellOff className="mx-auto h-10 w-10 text-slate-300 dark:text-slate-700" />
            <p className="mt-3 text-[17px] font-medium">Nothing waiting</p>
            <p className="mt-1 text-[15px] text-muted">
              Follow-ups and anything assigned to you will show up here.
            </p>
          </div>
        ) : (
          <div className="bg-[var(--surface)]">
            {alerts.map((alert) => (
              <Row
                key={alert.id}
                onClick={() => open(alert)}
                leading={<Avatar name={alert.title} size={40} />}
                title={alert.title}
                subtitle={[alert.body, relativeTime(alert.created_at)].filter(Boolean).join(' · ')}
                bold={!alert.is_read}
                trailing={!alert.is_read
                  ? <span className="mt-1 inline-block h-2.5 w-2.5 rounded-full bg-brand-600" aria-label="Unread" />
                  : undefined}
                className="border-b border-[var(--border)]"
              />
            ))}
          </div>
        )}
        <div style={{ height: 'calc(var(--bottom-nav-h, 0px) + 32px)' }} />
      </div>
    </div>
  );
}
