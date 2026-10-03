/**
 * The keypad, as the owner's prototype draws it.
 *
 * **3 October 2026, with a four-screen prototype:** *"rebuild my Android app
 * according to this prototype as a default Dailer/Phone app … we want to see
 * exact/True as UI/UX on my android app with full features/function according
 * to my CRM."*
 *
 * Top to bottom as drawn: the search, the typed number with its T9 count, the
 * contacts those keys match, the pad, and the row of three — SIM, call,
 * WhatsApp.
 *
 * **Every contact on this screen is a CRM record, not the phone's address
 * book.** That is the whole reason a broker would make this their phone app:
 * the person who rings is a lead with a budget and a stage, and the handset's
 * own contact list knows none of that. Reading the phone's contacts would also
 * need a permission this app deliberately does not ask for.
 *
 * **It draws itself the same whether or not iPropy is the default dialler.**
 * Becoming the default phone app is what makes the in-call controls real; it
 * is not what makes this screen work. A rep who has not switched over still
 * gets the keypad, the T9 search and a call that goes through the handset's
 * own dialler — which is what every installed copy does today.
 */
import { type JSX, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Delete, MessageSquare, Phone, Search, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { toast, useApp } from '../lib/store';
import { groupForDisplay, t9Matches, type Dialable } from '../lib/t9';
import { placeCallFromPhone, callSyncSupported } from '../lib/callSync';
import { Avatar } from './primitives';
import { useBottomBarHeight } from './useBottomBarHeight';

/*
  The pad, as data rather than as twelve copies of one button.

  The letters are what T9 is spelled with, so they are not decoration — a pad
  drawn without them is a pad nobody can use to find a name.
*/
const KEYS: Array<{ digit: string; letters: string }> = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

/**
 * Green calls, red ends, and neither is the brand.
 *
 * Everywhere else in this CRM a colour goes through `badgeVars` or a brand
 * token, because the brand is an admin's to change. A dialler is the one
 * screen where that rule would do harm: green-means-call is older than this
 * product and a rep's thumb finds it without reading. An admin who picks a red
 * brand must not end up with a red call button.
 */
const CALL_GREEN = 'bg-[#16a34a] hover:bg-[#15803d] text-white';

/** Which fields on a module hold a number somebody could ring. */
function phoneFieldNames(fields: Array<{ name: string; uitype: string }>): string[] {
  return fields.filter((field) => field.uitype === 'phone').map((field) => field.name);
}

export default function MobileDialer(): JSX.Element {
  const { modules } = useApp();
  const navigate = useNavigate();
  const measureBottomBar = useBottomBarHeight<HTMLDivElement>();
  const [typed, setTyped] = useState('');

  /*
    The module a contact lives in is metadata, never the word "leads": this
    screen has to keep working on a CRM whose party module is called something
    else. The first entity module is the one a rep means by "contacts", which
    is the same decision the app's own home tab makes.
  */
  const summary = modules.find((module) => module.isEntity);
  /*
    The fields come from the describe, not from the store's module list — that
    one carries a name and a label and no fields at all, which is what tells
    this screen which columns hold a phone number.
  */
  const { data: contactModule } = useQuery({
    queryKey: ['module', summary?.name],
    queryFn: () => api.module(summary!.name),
    enabled: Boolean(summary),
    staleTime: 5 * 60_000,
  });

  const digits = typed.replace(/\D+/g, '');

  const phoneFields = useMemo(
    () => (contactModule ? phoneFieldNames(contactModule.fields) : []),
    [contactModule],
  );

  /*
    Finding somebody from the keys, and the one thing a browser proved that no
    test could.

    **The CRM's text search does not match a phone number.** Searching
    `9830132657` against a database holding exactly that number answers zero —
    measured on 3 October 2026, against the endpoint every other screen uses.
    It searches names. On a keypad that is the one search that matters, so this
    asks with the **filter grammar** instead: `contains` on each of the
    module's phone fields, OR'd together. Against the same database that
    answers 8.

    It is permission-scoped like every other list read, so a rep is offered the
    people they may open and nobody else.
  */
  const numberFilter = useMemo(() => ({
    logic: 'OR' as const,
    conditions: phoneFields.map((name) => ({ field: name, operator: 'contains' as const, value: digits })),
  }), [phoneFields, digits]);

  const { data: byNumber } = useQuery({
    queryKey: ['dialer-number', contactModule?.name, digits, phoneFields],
    queryFn: () => api.list(contactModule!.name, {
      page: 1, pageSize: 12, columns: phoneFields, filter: numberFilter,
    }),
    enabled: Boolean(contactModule) && phoneFields.length > 0 && digits.length >= 3,
    staleTime: 30_000,
  });

  /*
    **Spelling a name on the keys is a different question, and it is bounded on
    purpose.** T9 has to compare the keys against every candidate's *letters*,
    which no SQL index can do — so it runs here, over the people already to
    hand rather than over 22,988 contacts a phone could never hold. "To hand"
    is this rep's own recent calls, which on a dialler is very nearly the right
    set: the people somebody rings are overwhelmingly the people they rang
    last week.

    Said plainly because it is a real limit: typing a name finds somebody you
    have called before. Typing their number finds anybody in the CRM.
  */
  const { data: recent = [] } = useQuery({
    queryKey: ['dialer-recent-names'],
    queryFn: () => api.calls({ pageSize: 200, mine: 'true' }),
    enabled: Boolean(contactModule),
    staleTime: 5 * 60_000,
  });

  const dialable: Dialable[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Dialable[] = [];
    for (const row of byNumber?.rows ?? []) {
      seen.add(row.id);
      out.push({
        id: row.id,
        name: row.label ?? '',
        numbers: phoneFields
          .map((name) => row.values?.[name])
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      });
    }
    for (const call of recent) {
      const id = call.recordId ? String(call.recordId) : '';
      const name = String(call.recordLabel ?? '');
      const number = String(call.phoneNumber ?? '');
      // A call with no record behind it has no name to spell, and one already
      // found by its number must not be listed twice.
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name, numbers: number ? [number] : [] });
    }
    return out;
  }, [byNumber, recent, phoneFields]);

  /*
    **Three, not five.** Measured on a 390px screen: five cards push the pad
    off the bottom, so a rep has to scroll to reach the keys they are in the
    middle of typing on — which is the one thing a keypad may never do. The
    prototype draws two; three keeps the pad in view and offers one more.
  */
  const matches = useMemo(() => t9Matches(dialable, digits, 3), [dialable, digits]);

  const press = (key: string): void => setTyped((current) => current + key);
  const backspace = (): void => setTyped((current) => current.slice(0, -1));

  /*
    Ringing somebody, and the one decision in this screen worth reading twice.

    **A known contact is rung through their own record**, by opening it with
    `?dial=1` — the flag the call console already answers, the same one Save &
    Next uses. That is what gets the rep the call deck, the outcome cards and
    the follow-up rules, and it is why this screen does not start a call
    itself: a second call path would be a second place for those rules to
    drift, and this repo has paid for that kind of copy before.

    **An unknown number goes straight to the handset.** There is no record to
    open and nothing to log against yet — the call-log sync picks it up minutes
    later and `matchContact` attaches it if the number turns out to be known.
  */
  const ring = (number: string, recordId?: string): void => {
    if (!number.trim()) { toast.error('Type a number first'); return; }
    if (recordId && contactModule) { navigate(`/${contactModule.name}/${recordId}?dial=1`); return; }
    if (!callSyncSupported) { toast.error('Calling needs the iPropy app on an Android phone'); return; }
    void placeCallFromPhone(number).then((result) => {
      if (!result.placed) { toast.error('Your phone did not take that call', result.reason); return; }
      /*
        The call screen, which is reachable from here and from nowhere else:
        a number nobody in the CRM owns has no record to open, so the record's
        own call deck — what a known contact gets — does not exist for it.
        One deck per call, never two for the same one.
      */
      navigate(`/in-call?to=${encodeURIComponent(number)}`);
    });
  };

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]" data-testid="mobile-dialer">
      {/* ----------------------------------------------------------------- */}
      {/* Search, as drawn: one pill across the top.                        */}
      {/* ----------------------------------------------------------------- */}
      <div className="shrink-0 px-4 pb-2 pt-3">
        <button
          type="button"
          onClick={() => navigate(contactModule ? `/${contactModule.name}` : '/')}
          className="flex w-full items-center gap-3 rounded-full border border-[var(--border)] bg-white px-4 py-3 text-left text-sm text-slate-500 shadow-2xs dark:bg-slate-900"
        >
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="truncate">Search contacts, leads, properties…</span>
        </button>
      </div>

      {/* The ref measures the app's own bottom bar and keeps the pad clear of
          it — a call button under the tab strip is one a thumb cannot reach. */}
      <div ref={measureBottomBar} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {/* --------------------------------------------------------------- */}
        {/* What has been typed, and how many contacts those keys reach.    */}
        {/* --------------------------------------------------------------- */}
        <div className="rounded-2xl border border-[var(--border)] bg-white p-4 shadow-2xs dark:bg-slate-900">
          <div className="flex items-center gap-2">
            {/* Drawn only when it has something to say. A chip reading
                "T9 MATCH (0)" on every keystroke is noise a rep reads past. */}
            {matches.length > 0 && (
              <span className="rounded-full bg-[#dcfce7] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#15803d]">
                T9 match ({matches.length})
              </span>
            )}
            <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {contactModule?.label ?? 'Contacts'}
            </span>
            <button
              type="button"
              aria-label="Delete last digit"
              onClick={backspace}
              disabled={!typed}
              className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition disabled:opacity-30 dark:bg-slate-800"
            >
              <Delete className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-2 flex items-center gap-2">
            {/* `tabular-nums` so the number does not jitter as it is typed —
                the design file asks for it by name, and on a dialler it is the
                difference between reading a number back and re-reading it. */}
            <span className="min-w-0 flex-1 truncate text-[30px] font-semibold tabular-nums tracking-tight text-slate-900 dark:text-white">
              {groupForDisplay(typed) || <span className="text-slate-300">Enter a number</span>}
            </span>
            {digits.length >= 6 && contactModule && (
              <button
                type="button"
                aria-label="Add as a new contact"
                onClick={() => navigate(`/${contactModule.name}/new?mobile=${encodeURIComponent(digits)}`)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#2563eb]"
              >
                <UserPlus className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>

        {/* --------------------------------------------------------------- */}
        {/* Who those keys reach.                                           */}
        {/* --------------------------------------------------------------- */}
        {matches.map(({ record }) => (
          <button
            key={record.id}
            type="button"
            onClick={() => navigate(`/${contactModule!.name}/${record.id}`)}
            className="mt-2 flex w-full items-center gap-3 rounded-2xl border border-[var(--border)] bg-white p-3 text-left shadow-2xs dark:bg-slate-900"
          >
            <Avatar name={record.name} size={44} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-bold text-slate-900 dark:text-white">{record.name}</span>
              <span className="block truncate text-xs tabular-nums text-slate-500">{record.numbers[0] ?? ''}</span>
            </span>
            {/* The two a rep reaches for, on the row itself — the prototype's
                own pair. Stopping the card's own tap, or ringing somebody
                would also open their record underneath. */}
            <span
              role="button"
              tabIndex={0}
              aria-label={`WhatsApp ${record.name}`}
              onClick={(event) => { event.stopPropagation(); navigate(`/chats?to=${encodeURIComponent(record.numbers[0] ?? '')}`); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); navigate(`/chats?to=${encodeURIComponent(record.numbers[0] ?? '')}`); } }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800"
            >
              <MessageSquare className="h-4 w-4" />
            </span>
            <span
              role="button"
              tabIndex={0}
              aria-label={`Call ${record.name}`}
              onClick={(event) => { event.stopPropagation(); ring(record.numbers[0] ?? '', record.id); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); ring(record.numbers[0] ?? '', record.id); } }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#dcfce7] text-[#15803d]"
            >
              <Phone className="h-4 w-4" />
            </span>
          </button>
        ))}

        {/* --------------------------------------------------------------- */}
        {/* The pad.                                                        */}
        {/* --------------------------------------------------------------- */}
        <div className="mt-3 rounded-2xl border border-[var(--border)] bg-white p-3 shadow-2xs dark:bg-slate-900">
          <div className="grid grid-cols-3 gap-2">
            {KEYS.map(({ digit, letters }) => (
              <button
                key={digit}
                type="button"
                aria-label={letters ? `${digit} ${letters}` : digit}
                onClick={() => press(digit)}
                /*
                  `active:` rather than `hover:` — a thumb has no hover, and a
                  key that only answers a mouse feels dead on the device this
                  screen exists for.
                */
                className="flex h-16 flex-col items-center justify-center rounded-full bg-[var(--surface-muted)] transition-colors active:bg-slate-200 dark:bg-slate-800 dark:active:bg-slate-700"
              >
                <span className="text-2xl font-normal leading-none text-slate-900 dark:text-white">{digit}</span>
                {letters && <span className="mt-0.5 text-[10px] font-medium tracking-wider text-slate-500">{letters}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* --------------------------------------------------------------- */}
        {/* Call, and the WhatsApp hand-off beside it.                      */}
        {/* --------------------------------------------------------------- */}
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => navigate(`/chats?to=${encodeURIComponent(digits)}`)}
            disabled={digits.length < 6}
            className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-2xs disabled:opacity-40 dark:bg-slate-900 dark:text-slate-200"
          >
            <MessageSquare className="h-4 w-4 text-[#16a34a]" />
            WhatsApp
          </button>

          <button
            type="button"
            aria-label="Call this number"
            onClick={() => ring(typed, matches[0]?.record.id)}
            className={cn(
              'flex h-16 w-16 items-center justify-center rounded-full shadow-lg transition-colors',
              CALL_GREEN,
            )}
          >
            <Phone className="h-7 w-7" />
          </button>

          {/* A spacer the width of the WhatsApp pill, so the call button sits
              in the middle of the screen rather than in the middle of what is
              left over. The prototype centres it and a thumb expects it there. */}
          <span className="invisible flex items-center gap-2 px-4 py-3 text-sm font-semibold" aria-hidden>
            <MessageSquare className="h-4 w-4" />
            WhatsApp
          </span>
        </div>
      </div>
    </div>
  );
}
