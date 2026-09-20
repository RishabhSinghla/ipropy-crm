import { type JSX, lazy, Suspense, useMemo } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { BarChart3, MessageCircle, Megaphone, MessagesSquare } from 'lucide-react';
import { useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { Skeleton } from '../components/ui';

/**
 * WhatsApp, as one place, because nobody thinks in drawers.
 *
 * **The owner, 20 September 2026:** *"why don't we get most of its things
 * (whatsmarketing) inside our CRM to that max … maybe never ever in this life
 * I would be required to open whatsmarketing"* — and a mixture of that and the
 * WhatsApp Web everybody already knows.
 *
 * Until now the four halves of WhatsApp lived in four places and three of them
 * were inside Admin, where a rep never goes: the inbox at `/chats`, health,
 * templates and campaigns each their own admin tab. A person does not think
 * *"I need the campaigns admin page"*; they think *"I want to do WhatsApp"*.
 * So this is one destination with four tabs, in the order the day runs:
 * answer people, reach people, keep the wording, check it is working.
 *
 * **Nothing here is a new screen.** Each tab renders the component that
 * already existed, still reachable at its old address — a second copy of the
 * inbox would drift from the first, and the one at `/chats` is what the
 * WhatsApp icon beside a phone number opens. This moves the door, not the room.
 *
 * Two decisions the owner made when asked, on the same day:
 *
 *  * **Everybody sees Chats.** No capability on that tab. The inbox already
 *    decides *what* each person sees — their own threads and the unassigned
 *    queue, an admin everything — so gating the tab as well would hide the
 *    screen from the very people whose conversations it holds.
 *  * **Chats and the record are both the daily driver**, so neither is
 *    demoted. Chats is the front page here, and the record's own WhatsApp tab
 *    keeps every message beside the person's budget and history.
 */
const BusinessChats = lazy(() => import('./BusinessChats'));
const CampaignsAdmin = lazy(() => import('./admin/CampaignsAdmin'));
const WhatsAppTemplatesAdmin = lazy(() => import('./admin/WhatsAppTemplatesAdmin'));
const WhatsAppAdmin = lazy(() => import('./admin/WhatsAppAdmin'));

interface Tab {
  path: string;
  label: string;
  icon: typeof MessageCircle;
  /** Undefined means everybody — see the note above about Chats. */
  capability?: string;
  element: JSX.Element;
}

const TABS: Tab[] = [
  { path: 'chats', label: 'Chats', icon: MessagesSquare, element: <BusinessChats /> },
  {
    path: 'campaigns',
    label: 'Campaigns',
    // Building one is `whatsapp.send`; approving one is `whatsapp.templates`.
    // The screen itself enforces that split — this only decides who sees a tab.
    capability: 'whatsapp.send',
    icon: Megaphone,
    element: <CampaignsAdmin />,
  },
  {
    path: 'templates',
    label: 'Templates',
    capability: 'whatsapp.templates',
    icon: MessageCircle,
    element: <WhatsAppTemplatesAdmin />,
  },
  {
    path: 'health',
    label: 'Health',
    capability: 'admin.integrations',
    icon: BarChart3,
    element: <WhatsAppAdmin />,
  },
];

export default function WhatsAppPage(): JSX.Element {
  const { user } = useApp();
  const allowed = useMemo(() => new Set(user?.capabilities ?? []), [user?.capabilities]);
  const tabs = TABS.filter((t) => !t.capability || allowed.has(t.capability));

  // A rep with only Chats sees no tab strip at all: one tab is not a choice,
  // and a row of one reads as something missing rather than as the whole thing.
  const showStrip = tabs.length > 1;

  return (
    <div className="flex h-full flex-col">
      {showStrip && (
        <nav className="flex gap-1 border-b border-slate-200 px-4 pt-3 dark:border-slate-800" aria-label="WhatsApp">
          {tabs.map((tab) => (
            <NavLink
              key={tab.path}
              to={tab.path}
              className={({ isActive }) => cn(
                'flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-sm font-medium',
                isActive
                  ? 'border-b-2 border-brand-600 text-brand-700 dark:text-brand-300'
                  : 'text-muted hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              <tab.icon className="h-4 w-4" aria-hidden />
              {tab.label}
            </NavLink>
          ))}
        </nav>
      )}

      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="p-4 sm:p-6"><Skeleton className="h-96 w-full" /></div>}>
          <Routes>
            {tabs.map((tab) => <Route key={tab.path} path={tab.path} element={tab.element} />)}
            {/* The first tab this person may open, not a fixed one: a rep with
                only Chats must not be bounced to a page they cannot see. */}
            <Route path="*" element={<Navigate to={tabs[0]?.path ?? 'chats'} replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
