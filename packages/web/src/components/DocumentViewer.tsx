import type { JSX } from 'react';
/**
 * In-CRM viewer for whatever anyone attaches.
 *
 * Before this, every attachment was a download link: opening a KYC PDF or a
 * site photo meant leaving the CRM, finding it in Downloads, and coming back —
 * and on a phone that round trip loses your place entirely.
 *
 * What renders here is what the browser can render *natively* — images, PDF,
 * video, audio, text and anything text-shaped (CSV, JSON, Markdown, code).
 * Office formats (.docx/.xlsx/.pptx) are a zip of XML no browser can draw, so
 * rather than embed a third-party viewer — which would mean uploading a
 * customer's KYC document to someone else's server — those get an honest
 * "download to open" with the reason. See UNSUPPORTED_NOTE.
 *
 * Auth: `<img>`, `<iframe>` and `<video>` cannot carry the Authorization
 * header, so URLs use the `?access_token=` fallback requireAuth already
 * supports (the same pattern gallery thumbnails and CSV export use). This
 * keeps range requests working, which matters — a Blob URL would force the
 * whole video into memory before playback.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download, ExternalLink, FileQuestion, FileText, ChevronLeft, ChevronRight,
  Maximize2, RotateCw, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { api, tokenStore } from '../lib/api';
import { cn, renderMarkdown } from '../lib/utils';
import { Spinner } from './ui';

export interface ViewableFile {
  id: string;
  fileName: string;
  mimeType?: string | null;
  fileSize?: number | null;
}

type Kind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'markdown' | 'csv' | 'code' | 'unsupported';

const EXT_KINDS: Record<string, Kind> = {
  // images
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  avif: 'image', bmp: 'image', svg: 'image', ico: 'image', heic: 'image', heif: 'image',
  // documents
  pdf: 'pdf',
  // video / audio
  mp4: 'video', webm: 'video', ogv: 'video', mov: 'video', m4v: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', oga: 'audio', ogg: 'audio', flac: 'audio',
  // text-shaped
  txt: 'text', log: 'text', rtf: 'text',
  md: 'markdown', markdown: 'markdown',
  csv: 'csv', tsv: 'csv',
  json: 'code', xml: 'code', yaml: 'code', yml: 'code', html: 'code', htm: 'code',
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', css: 'code', sql: 'code', sh: 'code', py: 'code',
};

/** Why a format has no preview, in the user's terms rather than the browser's. */
const UNSUPPORTED_NOTE: Record<string, string> = {
  docx: 'Word documents are a zip of XML — no browser can draw one without sending it to an outside service.',
  doc: 'Legacy Word documents cannot be rendered in a browser.',
  xlsx: 'Excel workbooks are a zip of XML — no browser can draw one without sending it to an outside service.',
  xls: 'Legacy Excel workbooks cannot be rendered in a browser.',
  pptx: 'PowerPoint decks are a zip of XML — no browser can draw one without sending it to an outside service.',
  ppt: 'Legacy PowerPoint decks cannot be rendered in a browser.',
  zip: 'Archives have to be extracted before anything inside can be read.',
  rar: 'Archives have to be extracted before anything inside can be read.',
  '7z': 'Archives have to be extracted before anything inside can be read.',
  dwg: 'CAD drawings need CAD software.',
};

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > -1 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/** Extension first, MIME as the fallback — uploads often arrive as octet-stream. */
export function kindOf(file: ViewableFile): Kind {
  const byExt = EXT_KINDS[extensionOf(file.fileName)];
  if (byExt) return byExt;

  const mime = (file.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv';
  if (mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text';
  return 'unsupported';
}

export function isPreviewable(file: ViewableFile): boolean {
  return kindOf(file) !== 'unsupported';
}

function fileUrl(id: string, download = false): string {
  const params = new URLSearchParams();
  const token = tokenStore.get();
  if (token) params.set('access_token', token);
  if (download) params.set('download', '1');
  return `/api/files/${id}?${params.toString()}`;
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function DocumentViewer({
  file, files, onNavigate, onClose,
}: {
  file: ViewableFile;
  /** the surrounding set, so the viewer can page through without closing */
  files?: ViewableFile[];
  onNavigate?: (file: ViewableFile) => void;
  onClose: () => void;
}): JSX.Element {
  const kind = kindOf(file);
  const index = files?.findIndex((f) => f.id === file.id) ?? -1;
  const prev = index > 0 ? files![index - 1] : null;
  const next = index >= 0 && files && index < files.length - 1 ? files[index + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && prev) onNavigate?.(prev);
      else if (e.key === 'ArrowRight' && next) onNavigate?.(next);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onNavigate, prev, next]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${file.fileName}`}
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/95 backdrop-blur-sm"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 sm:px-4">
        <FileText className="hidden h-4 w-4 shrink-0 text-slate-400 sm:block" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{file.fileName}</p>
          <p className="text-2xs text-slate-400">
            {[formatSize(file.fileSize), file.mimeType].filter(Boolean).join(' · ')}
            {index >= 0 && files && files.length > 1 && ` · ${index + 1} of ${files.length}`}
          </p>
        </div>

        {files && files.length > 1 && (
          <div className="hidden items-center gap-0.5 sm:flex">
            <button
              onClick={() => prev && onNavigate?.(prev)}
              disabled={!prev}
              className="rounded-lg p-2 text-slate-300 hover:bg-white/10 disabled:opacity-30"
              aria-label="Previous file"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => next && onNavigate?.(next)}
              disabled={!next}
              className="rounded-lg p-2 text-slate-300 hover:bg-white/10 disabled:opacity-30"
              aria-label="Next file"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        <a
          href={fileUrl(file.id)}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-lg p-2 text-slate-300 hover:bg-white/10"
          title="Open in a new tab"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <a
          href={fileUrl(file.id, true)}
          download={file.fileName}
          className="rounded-lg p-2 text-slate-300 hover:bg-white/10"
          title="Download"
        >
          <Download className="h-4 w-4" />
        </a>
        <button onClick={onClose} className="rounded-lg p-2 text-slate-300 hover:bg-white/10" aria-label="Close preview">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* Keyed on id so switching files resets zoom, scroll and any fetch. */}
        <Body key={file.id} file={file} kind={kind} />
      </div>
    </div>
  );
}

function Body({ file, kind }: { file: ViewableFile; kind: Kind }): JSX.Element {
  switch (kind) {
    case 'image': return <ImageBody file={file} />;
    case 'pdf': return <PdfBody file={file} />;
    case 'video': return (
      <div className="flex h-full items-center justify-center p-4">
        {/* No preload="auto": a site-visit video can be hundreds of MB and the
            user may only want to scrub to one moment. */}
        <video src={fileUrl(file.id)} controls preload="metadata" className="max-h-full max-w-full rounded-lg" />
      </div>
    );
    case 'audio': return (
      <div className="flex h-full items-center justify-center p-6">
        <audio src={fileUrl(file.id)} controls className="w-full max-w-lg" />
      </div>
    );
    case 'csv': return <TextBody file={file} mode="csv" />;
    case 'markdown': return <TextBody file={file} mode="markdown" />;
    case 'code': return <TextBody file={file} mode="code" />;
    case 'text': return <TextBody file={file} mode="text" />;
    default: return <UnsupportedBody file={file} />;
  }
}

function ImageBody({ file }: { file: ViewableFile }): JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  return (
    <div className="relative flex h-full items-center justify-center p-4">
      <img
        src={fileUrl(file.id)}
        alt={file.fileName}
        style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
        className="max-h-full max-w-full rounded-lg object-contain transition-transform"
      />

      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-slate-800/90 px-2 py-1.5 backdrop-blur">
        <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} className="rounded-full p-1.5 text-slate-300 hover:bg-white/10" aria-label="Zoom out">
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="min-w-[3rem] text-center text-2xs text-slate-300 tnum">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(6, z + 0.25))} className="rounded-full p-1.5 text-slate-300 hover:bg-white/10" aria-label="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </button>
        <button onClick={() => { setZoom(1); setRotation(0); }} className="rounded-full p-1.5 text-slate-300 hover:bg-white/10" aria-label="Reset">
          <Maximize2 className="h-4 w-4" />
        </button>
        <button onClick={() => setRotation((r) => (r + 90) % 360)} className="rounded-full p-1.5 text-slate-300 hover:bg-white/10" aria-label="Rotate">
          <RotateCw className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PdfBody({ file }: { file: ViewableFile }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);

  // iOS Safari renders only the first page of a framed PDF and gives no error,
  // so on touch devices the honest move is to hand it to the OS viewer.
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIos || failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <FileText className="h-10 w-10 text-slate-500" />
        <p className="max-w-sm text-sm text-slate-300">
          {isIos
            ? 'iOS only renders the first page of an embedded PDF. Open it full-screen instead.'
            : 'This PDF could not be displayed inline.'}
        </p>
        <a href={fileUrl(file.id)} target="_blank" rel="noreferrer noopener" className="btn-primary btn-sm">
          <ExternalLink className="h-3.5 w-3.5" /> Open PDF
        </a>
      </div>
    );
  }

  return (
    <iframe
      ref={ref}
      src={fileUrl(file.id)}
      title={file.fileName}
      className="h-full w-full border-0 bg-white"
      onError={() => setFailed(true)}
    />
  );
}

function UnsupportedBody({ file }: { file: ViewableFile }): JSX.Element {
  const ext = extensionOf(file.fileName);
  const note = UNSUPPORTED_NOTE[ext];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileQuestion className="h-10 w-10 text-slate-500" />
      <p className="text-sm font-medium text-white">No in-browser preview for .{ext || 'this format'}</p>
      <p className="max-w-md text-xs leading-relaxed text-slate-400">
        {note ?? 'This format cannot be displayed in a browser.'}
      </p>
      <a href={fileUrl(file.id, true)} download={file.fileName} className="btn-primary btn-sm">
        <Download className="h-3.5 w-3.5" /> Download to open
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text-shaped formats
// ---------------------------------------------------------------------------

/** Big enough for any document; a stray 200MB log should not hang the tab. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function TextBody({ file, mode }: { file: ViewableFile; mode: 'text' | 'code' | 'markdown' | 'csv' }): JSX.Element {
  const [state, setState] = useState<{ loading: boolean; text?: string; error?: string; truncated?: boolean }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    void api.request<Response>(`/api/files/${file.id}`, { raw: true })
      .then(async (res) => {
        const blob = await res.blob();
        const truncated = blob.size > MAX_TEXT_BYTES;
        const text = await (truncated ? blob.slice(0, MAX_TEXT_BYTES) : blob).text();
        if (!cancelled) setState({ loading: false, text, truncated });
      })
      .catch((err: Error) => { if (!cancelled) setState({ loading: false, error: err.message }); });
    return () => { cancelled = true; };
  }, [file.id]);

  if (state.loading) return <div className="flex h-full items-center justify-center"><Spinner className="text-slate-400" /></div>;
  if (state.error) return <p className="p-6 text-center text-sm text-red-400">{state.error}</p>;

  const text = state.text ?? '';

  return (
    <div className="mx-auto min-h-full max-w-5xl bg-white p-4 dark:bg-slate-900 sm:p-6">
      {state.truncated && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Showing the first {formatSize(MAX_TEXT_BYTES)} — download the file to read all of it.
        </p>
      )}
      {mode === 'csv' ? <CsvTable text={text} delimiter={extensionOf(file.fileName) === 'tsv' ? '\t' : ','} />
        : mode === 'markdown' ? <div className="prose-ai" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        : <pre className={cn('overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed', mode === 'code' && 'font-mono')}>{text}</pre>}
    </div>
  );
}

function CsvTable({ text, delimiter }: { text: string; delimiter: string }): JSX.Element {
  const rows = useMemo(() => parseDelimited(text, delimiter).slice(0, 2000), [text, delimiter]);
  if (!rows.length) return <p className="text-sm text-muted">This file is empty.</p>;

  const [header, ...body] = rows;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
          <tr>
            {header.map((cell, i) => (
              <th key={i} className="whitespace-nowrap border border-slate-200 px-2 py-1.5 text-left font-semibold dark:border-slate-700">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="even:bg-slate-50/60 dark:even:bg-slate-800/40">
              {header.map((_, c) => (
                <td key={c} className="border border-slate-200 px-2 py-1 align-top dark:border-slate-700">{row[c] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length >= 1999 && (
        <p className="mt-2 text-2xs text-muted">Showing the first 2,000 rows.</p>
      )}
    </div>
  );
}

/**
 * A correct-enough CSV/TSV reader.
 *
 * `text.split(',')` is the obvious version and it is wrong for real exports:
 * an address field routinely contains a comma, and a quoted field can span
 * newlines. This is a character scanner, which handles quoting, escaped
 * quotes ("") and CRLF — the cases that actually appear in portal exports.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } // escaped quote
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      // Swallow the LF of a CRLF pair so it doesn't produce a blank row.
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}
