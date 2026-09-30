/**
 * A small emoji button for the notes box.
 *
 * The owner, 3 October 2026: *"Emojis icon to get emojis into comments/notes"*.
 * A short, hand-picked set in four rows rather than a library of three thousand:
 * a comment on a customer needs a thumbs-up, a house and a handshake, and a
 * picker nobody can scan is one nobody uses. Every phone and laptop keyboard can
 * still type any other emoji straight into the box.
 */
import { type JSX, useEffect, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import { cn } from '../lib/utils';

const EMOJI_GROUPS: { title: string; emojis: string[] }[] = [
  { title: 'Reactions', emojis: ['👍', '👌', '🙏', '👏', '🙌', '💪', '🤝', '✅', '❌', '⚠️'] },
  { title: 'Faces', emojis: ['😀', '😊', '😂', '😍', '🤔', '😅', '😐', '😟', '😡', '🥳'] },
  { title: 'Property', emojis: ['🏠', '🏡', '🏢', '🏗️', '🔑', '🛏️', '🚗', '🌳', '📍', '🧭'] },
  { title: 'Work', emojis: ['📞', '📲', '💬', '📅', '⏰', '💰', '📄', '📝', '🔥', '⭐'] },
];

export function EmojiPicker({ onPick, className }: { onPick: (emoji: string) => void; className?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);

  // Clicking anywhere else, or Escape, puts it away.
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: PointerEvent): void => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <span ref={holder} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        title="Add an emoji"
        aria-label="Add an emoji"
        aria-expanded={open}
        className={className}
      >
        <Smile className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          role="dialog"
          aria-label="Emojis"
          className="popover absolute bottom-full left-0 z-30 mb-1 w-64 p-2"
          data-testid="emoji-picker"
        >
          {EMOJI_GROUPS.map((group) => (
            <span key={group.title} className="mb-1 block last:mb-0">
              <span className="block px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{group.title}</span>
              <span className="grid grid-cols-10">
                {group.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => onPick(emoji)}
                    aria-label={`Add ${emoji}`}
                    className={cn('rounded p-0.5 text-base leading-none transition hover:bg-slate-100 dark:hover:bg-slate-700')}
                  >
                    {emoji}
                  </button>
                ))}
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
