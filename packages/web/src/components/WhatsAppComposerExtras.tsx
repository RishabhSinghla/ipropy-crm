import { type JSX, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Smile } from 'lucide-react';
import { api } from '../lib/api';

const EMOJI = ['😀', '😊', '🙂', '😉', '😍', '🙏', '👍', '👌', '🎉', '✅', '🏠', '🏡', '📍', '📞', '💰', '⭐', '🔑', '📅', '🕐', '❤️', '😂', '🤝', '👋', '🙌'];

/** The admin's one-tap replies (Admin → Dropdowns → WhatsApp Quick Replies). Empty list shows nothing. */
export function QuickReplies({ onPick }: { onPick: (text: string) => void }): JSX.Element | null {
  const { data } = useQuery({ queryKey: ['picklist', 'wa_quick_reply'], queryFn: () => api.picklist('wa_quick_reply'), staleTime: 5 * 60_000 });
  const replies = (data ?? [])
    .filter((o) => (o as { isActive?: boolean }).isActive !== false)
    .map((o) => o.label || o.value)
    .filter((t) => t.trim());
  if (!replies.length) return null;
  return (
    <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1" aria-label="Quick replies">
      {replies.map((text) => (
        <button
          key={text}
          type="button"
          title={text}
          onClick={() => onPick(text)}
          className="max-w-[16rem] shrink-0 truncate rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function EmojiButton({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button type="button" className="btn-ghost btn-sm" aria-label="Add an emoji" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)}>
        <Smile className="h-4 w-4" />
      </button>
      {open && (
        <div className="popover absolute bottom-full left-0 z-20 mb-1 grid w-56 grid-cols-6 gap-1 p-2" role="menu">
          {EMOJI.map((e) => (
            <button key={e} type="button" role="menuitem" className="rounded p-1 text-lg hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => { onPick(e); setOpen(false); }}>{e}</button>
          ))}
        </div>
      )}
    </div>
  );
}
