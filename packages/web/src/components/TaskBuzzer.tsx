import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BellRing, CheckCircle2, ChevronRight, Columns2 } from 'lucide-react';
import type { FieldMeta } from '@ipropy/shared';
import { api, type ModuleSummary } from '../lib/api';
import { useApp } from '../lib/store';
import { isNative } from '../lib/native';
import { assignmentField } from '../lib/fields';
import { playBuzzer } from '../lib/buzzer';
import {
  closesAfter, FIRST_ROUND_AFTER_MS, nextRoundAt, readMemory, taskDateFields, todaysTasksFilter,
  type TodayTask, whichToShow, writeMemory, skipTasks, taskSkipUntil,
} from '../lib/taskBuzzer';
import type { DescribedModule } from '../lib/recordPanes';
import { ChatRecordPane, ChatRecordPaneSkeleton, useChatRecord } from './ChatRecordPane';
import { FollowUpChipCell } from './RecordBlocks';
import { Modal } from './ui';

/*
  The today-task buzzer.

  **9 October 2026, the owner:** *"i need to pressurised to team for the
  complete today task asap … every lead form auto open like popup … with
  buzz/High alert format with a buzzer sound also, so that team are always in
  alert mode … if they want to ignore the tasks but they cant ignore anyway."*

  Mounted once, in the app's frame, so it runs whichever page somebody is on.
  The rules live in `lib/taskBuzzer.ts`; this file is the clock and the popup.
  Laptops and desktops only — the phone app has its own notifications, and a
  popup over a phone call is worse than none.
*/

/** How often the clock looks at whether a round is due. */
const CHECK_EVERY_MS = 15_000;

interface Round {
  tasks: TodayTask[];
  /** Every task due today, not only those in this round — it decides the busy-day rules. */
  dueToday: number;
  index: number;
}

export function TaskBuzzer(): JSX.Element | null {
  const user = useApp((state) => state.user);
  const modules = useApp((state) => state.modules);
  const settings = user?.ui?.taskBuzzer;
  const queryClient = useQueryClient();
  const [round, setRound] = useState<Round | null>(null);
  const running = useRef(false);

  const userId = user?.id ?? null;
  const active = Boolean(userId && settings?.on && !isNative && modules.length);

  useEffect(() => {
    if (!active || !userId || !settings) return undefined;
    let hiddenNudgeFor: number | null = null;

    const check = async (): Promise<void> => {
      if (Date.now() < taskSkipUntil(userId)) return;
      if (running.current) return;
      const memory = readMemory(userId);
      // A new day, or the first visit today: give them a minute to sit down.
      if (memory.nextAt === null) {
        writeMemory(userId, { ...memory, nextAt: Date.now() + FIRST_ROUND_AFTER_MS });
        return;
      }
      if (Date.now() < memory.nextAt) return;

      // Nobody is looking at this tab: buzz once to bring them back, and wait.
      if (document.visibilityState !== 'visible') {
        if (hiddenNudgeFor !== memory.nextAt) {
          hiddenNudgeFor = memory.nextAt;
          playBuzzer();
          nudgeTheDesktop();
        }
        return;
      }

      running.current = true;
      try {
        const tasks = await loadTodaysTasks(queryClient, modules, userId);
        if (Date.now() < taskSkipUntil(userId)) { running.current = false; return; }
        const due = whichToShow(tasks, new Set(memory.shown), settings);
        if (!due.length) {
          writeMemory(userId, { ...readMemory(userId), nextAt: nextRoundAt(Date.now(), settings) });
          running.current = false;
          return;
        }
        setRound({ tasks: due, dueToday: tasks.length, index: 0 });
      } catch {
        // The list could not be read. Try again next round rather than every fifteen seconds.
        writeMemory(userId, { ...readMemory(userId), nextAt: nextRoundAt(Date.now(), settings) });
        running.current = false;
      }
    };

    void check();
    const timer = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
    const onVisible = (): void => { void check(); };
    document.addEventListener('visibilitychange', onVisible);
    const onStorage = (): void => {
      if (Date.now() < taskSkipUntil(userId)) { setRound(null); running.current = false; }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }, [active, userId, settings, modules, queryClient]);

  // Every popup buzzes as it opens, and a busy day remembers it was shown.
  const current = round?.tasks[round.index];
  useEffect(() => {
    if (!current || !userId) return;
    playBuzzer();
    const memory = readMemory(userId);
    if (!memory.shown.includes(current.id)) {
      writeMemory(userId, { ...memory, shown: [...memory.shown, current.id] });
    }
  }, [current, userId]);

  const next = useCallback(() => {
    setRound((now) => {
      if (!now) return now;
      if (now.index + 1 < now.tasks.length) return { ...now, index: now.index + 1 };
      if (userId && settings) {
        writeMemory(userId, { ...readMemory(userId), nextAt: nextRoundAt(Date.now(), settings) });
      }
      running.current = false;
      return null;
    });
  }, [userId, settings]);

  if (!round || !current || !settings) return null;
  return (
    <TaskPopup
      key={`${current.module}:${current.id}:${round.index}`}
      task={current}
      position={round.index + 1}
      inRound={round.tasks.length}
      dueToday={round.dueToday}
      closeAfterSeconds={closesAfter(round.dueToday, settings)}
      onNext={next}
      onSkip={() => {
        if (userId) skipTasks(userId);
        running.current = false;
        setRound(null);
      }}
    />
  );
}

/**
 * Every record assigned to this person with a task date of today, module by
 * module, earliest first. The module descriptions come through the same query
 * key the record screens use, so they are usually already in memory.
 */
async function loadTodaysTasks(queryClient: QueryClient, modules: ModuleSummary[], userId: string): Promise<TodayTask[]> {
  const tasks: TodayTask[] = [];
  const entities = modules
    .filter((module) => module.isEntity && module.permissions.view)
    .sort((a, b) => a.sequence - b.sequence);
  for (const summary of entities) {
    const module = await queryClient.fetchQuery({
      queryKey: ['module', summary.name],
      queryFn: () => api.module(summary.name),
      staleTime: 5 * 60_000,
    });
    const dates = taskDateFields(module.fields);
    const owner = assignmentField(module.fields);
    const filter = owner ? todaysTasksFilter(dates, owner.name, userId) : null;
    if (!filter) continue;
    const page = await api.list(summary.name, { filter, pageSize: 500, sortBy: dates[0]!.name, sortDir: 'asc' });
    for (const row of page.rows) {
      tasks.push({ module: summary.name, moduleLabel: summary.singularLabel, id: row.id, label: row.label });
    }
  }
  return tasks;
}

/** A tab nobody is looking at gets a desktop notification, when the browser allows one. */
function nudgeTheDesktop(): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const shown = new Notification("Today's tasks are waiting", {
    body: 'Your follow-ups due today are popping up in the CRM.',
    tag: 'ipropy-task-buzzer',
    icon: '/icons/icon-192.png',
    requireInteraction: true,
  });
  shown.onclick = () => { window.focus(); shown.close(); };
}

/**
 * The task dates as they stood when the popup opened, so moving any of them
 * reads as done.
 *
 * Deliberately not "is it still today by this laptop's clock": the server
 * decides "today" in the organisation's timezone, and a laptop set to another
 * one would call a task done, or not done, while the server disagreed.
 */
function datesOf(values: Record<string, unknown>, dates: FieldMeta[]): string {
  return dates.map((field) => String(values[field.name] ?? '')).join('|');
}

function TaskPopup({ task, position, inRound, dueToday, closeAfterSeconds, onNext, onSkip }: {
  task: TodayTask;
  position: number;
  inRound: number;
  dueToday: number;
  /** Null when the popup waits for the rep. */
  closeAfterSeconds: number | null;
  onNext: () => void;
  onSkip: () => void;
}): JSX.Element {
  const { module, record, loading, failed } = useChatRecord(task.module, task.id);
  const [secondsLeft, setSecondsLeft] = useState(closeAfterSeconds);
  const dates = module ? taskDateFields(module.fields) : [];
  const now = record && dates.length ? datesOf(record.values, dates) : null;
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    if (now !== null && opened === null) setOpened(now);
  }, [now, opened]);
  const done = opened !== null && now !== null && now !== opened;

  // A busy day: the popup closes itself, date changed or not.
  useEffect(() => {
    if (closeAfterSeconds === null) return undefined;
    const timer = window.setInterval(() => {
      setSecondsLeft((left) => (left === null ? null : left - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [closeAfterSeconds]);
  useEffect(() => {
    if (secondsLeft !== null && secondsLeft <= 0) onNext();
  }, [secondsLeft, onNext]);

  // The date was moved: that is the task done. Say so, then move on.
  useEffect(() => {
    if (!done) return undefined;
    const timer = window.setTimeout(onNext, 1500);
    return () => window.clearTimeout(timer);
  }, [done, onNext]);

  // Deleted, or no longer theirs to open: nothing to chase.
  useEffect(() => {
    if (failed) onNext();
  }, [failed, onNext]);

  const isLast = position === inRound;
  const followUp = dates[0];
  const canEdit = Boolean(record && module && (record.can?.edit ?? module.permissions.edit));

  const header = (
    <div
      data-testid="task-buzzer"
      className="flex flex-wrap items-center gap-3 border-b-4 border-red-600 bg-red-50 px-4 py-3 dark:bg-red-950/60"
    >
      <span className="flex h-10 w-10 shrink-0 animate-pulse items-center justify-center rounded-full bg-red-600 text-white">
        <BellRing className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-extrabold uppercase tracking-wider text-red-700 dark:text-red-300">
          Task due today · {position} of {inRound}
          {dueToday !== inRound && <span className="font-semibold normal-case tracking-normal"> ({dueToday} due today)</span>}
        </p>
        <h2 className="truncate text-lg font-extrabold text-slate-900 dark:text-white">
          {record?.label ?? task.label}
          <span className="ml-2 text-xs font-semibold text-muted">{task.moduleLabel}</span>
        </h2>
      </div>
      {record && module && followUp && (
        <div className="shrink-0" title="Move the date off today to finish this task">
          <FollowUpChipCell module={module as DescribedModule} row={record} field={followUp} canEdit={canEdit} />
        </div>
      )}
    </div>
  );

  return (
    <Modal open onClose={onNext} title={`Task due today: ${task.label}`} header={header} size="lg" footer={(
      <div className="flex w-full flex-wrap items-center gap-2">
        {done ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-positive">
            <CheckCircle2 className="h-4 w-4" /> Done — date moved
          </span>
        ) : (
          <span className="text-xs text-muted">
            {secondsLeft !== null
              ? `Closes in ${secondsLeft}s. It is still due today until its date is moved.`
              : 'This keeps coming back every round until its date is moved off today.'}
          </span>
        )}
        <button type="button" className="btn-secondary" onClick={onSkip} data-testid="task-buzzer-skip">Skip all · 3 hours</button>
        <Link
          to={`/${task.module}?open=${task.id}`}
          onClick={onNext}
          className="btn-secondary ml-auto"
        >
          <Columns2 className="h-4 w-4" /> Open to call
        </Link>
        <button type="button" className="btn-primary" onClick={onNext} data-testid="task-buzzer-next">
          {isLast ? 'Finish' : 'Next task'} <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    )}>
      {loading || !record || !module
        ? <ChatRecordPaneSkeleton />
        : <ChatRecordPane module={module as DescribedModule} record={record} />}
    </Modal>
  );
}

