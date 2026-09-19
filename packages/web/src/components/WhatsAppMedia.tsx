import type { JSX } from 'react';
import { FileText, Download } from 'lucide-react';
import type { MessageMedia } from '../lib/whatsapp';

export { readMessageMedia, type MessageMedia } from '../lib/whatsapp';

/**
 * The file inside a WhatsApp message, drawn once for every screen that shows
 * one — the Chats inbox, the contact's WhatsApp tab and the composer.
 *
 * One component on purpose. Three renderers of the same thing drift, and the
 * way they drift is that one of them keeps working with the provider's own
 * expiring URL while the others were moved to the CRM's copy — so a photo
 * shows on one screen and is a broken square on another, months later, for
 * reasons nobody can reconstruct.
 *
 * Everything here points at `/api/files/<attachment id>`: the CRM's own copy,
 * fetched from the provider when the message arrived. The vendor's id is still
 * on the row beside it and is deliberately not what gets rendered.
 */

function readableSize(bytes?: number): string {
  if (!bytes) return '';
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function WhatsAppMedia({ media, dark }: { media: MessageMedia; dark?: boolean }): JSX.Element | null {
  const href = `/api/files/${media.attachmentId}`;
  const mime = media.mimeType ?? '';
  const name = media.fileName ?? 'file';

  if (mime.startsWith('image/')) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="block">
        <img
          src={href}
          alt={name}
          loading="lazy"
          className="max-h-64 w-full rounded-lg object-cover"
        />
      </a>
    );
  }

  if (mime.startsWith('video/')) {
    // `controls` and nothing else: autoplay in a conversation is somebody's
    // phone making noise in a meeting.
    return <video src={href} controls preload="metadata" className="max-h-64 w-full rounded-lg" />;
  }

  if (mime.startsWith('audio/')) {
    // A WhatsApp voice note lands here. The browser's own player is the right
    // control — it has play, pause and a scrubber, and it is what the rep
    // already knows from the timeline's call recordings.
    return <audio src={href} controls preload="metadata" className="w-full" />;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
        dark ? 'bg-emerald-700/40' : 'bg-slate-100 dark:bg-slate-700/60'
      }`}
    >
      <FileText className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 opacity-70">{readableSize(media.size)}</span>
      <Download className="h-3.5 w-3.5 shrink-0 opacity-70" />
    </a>
  );
}
