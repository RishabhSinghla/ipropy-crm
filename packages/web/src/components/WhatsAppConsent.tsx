/**
 * Unsubscribing a customer from WhatsApp, and putting them back.
 *
 * Both halves live here so the Chats screen and a record's WhatsApp tab say
 * the same thing in the same words. The list itself is on the server
 * (`ipy_channel_optout`): a customer who writes STOP lands on it, every send
 * checks it, and these two buttons are the only other way on or off.
 */
import { type JSX, useState } from 'react';
import { BellOff } from 'lucide-react';
import { ConfirmDialog } from './ui';

/** Shown in place of the message box once somebody has unsubscribed. */
export function UnsubscribedPanel({ who, onSubscribeAgain }: {
  who: string;
  onSubscribeAgain: () => Promise<unknown>;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 dark:border-rose-900 dark:bg-rose-950/40">
      <BellOff className="h-4 w-4 shrink-0 text-rose-700 dark:text-rose-300" />
      <p className="min-w-0 flex-1 text-xs text-rose-900 dark:text-rose-200">
        <span className="font-semibold">Unsubscribed.</span>{' '}
        {who} asked not to get WhatsApp messages, so nothing can be sent to them — no reply,
        no template and no campaign.
      </p>
      <button type="button" className="btn-secondary btn-sm" onClick={() => setAsking(true)}>
        Subscribe again
      </button>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={async () => { await onSubscribeAgain(); setAsking(false); }}
        title="Subscribe them again?"
        body={`Only do this if ${who} has asked to hear from you again. Your name is recorded against the change.`}
        confirmLabel="Subscribe again"
      />
    </div>
  );
}

/** The small link under the message box, for a customer who asked on a call. */
export function UnsubscribeLink({ who, onUnsubscribe }: {
  who: string;
  onUnsubscribe: () => Promise<unknown>;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="inline-flex items-center gap-1 text-2xs font-medium text-muted transition-colors hover:text-rose-700 dark:hover:text-rose-300"
      >
        <BellOff className="h-3 w-3" />
        Unsubscribe from WhatsApp
      </button>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={async () => { await onUnsubscribe(); setAsking(false); }}
        title="Stop all WhatsApp messages?"
        body={`Nothing more will go to ${who} on WhatsApp — no reply, no template and no campaign — until they are subscribed again. They are also unsubscribed if they write STOP themselves.`}
        confirmLabel="Unsubscribe"
        danger
      />
    </>
  );
}
