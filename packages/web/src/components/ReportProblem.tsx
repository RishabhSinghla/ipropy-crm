/**
 * "Report a Problem" — the owner's direct line to the engineering pipeline.
 *
 * Design constraints this component is built around:
 *
 *  - The reporter is not technical and works in Hinglish. Every label is
 *    Hinglish; every hint says what to write, not what the engineers call it.
 *  - A screenshot is worth a paragraph. Paste (Ctrl/Cmd-V), tap-to-choose and
 *    drag-drop all work; the same browser-side shrink as photo uploads applies
 *    so a 5MB phone screenshot becomes a 200KB JPEG.
 *  - Voice beats typing for many people. The browser's own speech recognition
 *    (Web Speech API, hi-IN) transcribes free — no key, no quota. Where the
 *    browser lacks it (Firefox, Safari on iOS before 14.5), the button hides
 *    rather than breaking.
 *  - The screen he is on is captured automatically from the route, because
 *    naming the screen is the hardest part of a bug report for a non-technical
 *    person and the router already knows it.
 */
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Camera, Lightbulb, Loader2, Mic, MicOff, MessageCircleQuestion, Paperclip, Send, Trash2, X } from 'lucide-react';
import { Modal, Spinner } from './ui';
import { toast } from '../lib/store';
import { api } from '../lib/api';
import { compressImage } from '../lib/compressImage';
import { useApp } from '../lib/store';

type Kind = 'bug' | 'idea' | 'question';
type Severity = 'blocking' | 'important' | 'minor';

const KINDS: { value: Kind; label: string; icon: JSX.Element; hint: string }[] = [
  { value: 'bug', label: 'Kuch galat hai', icon: <Camera className="h-4 w-4" />, hint: 'Jo hona chahiye tha, wo nahi ho raha' },
  { value: 'idea', label: 'Naya chahiye', icon: <Lightbulb className="h-4 w-4" />, hint: 'Aisa hota to kaam aasan ho jata' },
  { value: 'question', label: 'Samajh nahi aaya', icon: <MessageCircleQuestion className="h-4 w-4" />, hint: 'Kaise use karein, ya kya hua' },
];

const SEVERITIES: { value: Severity; label: string; tone: string }[] = [
  { value: 'blocking', label: 'Kaam ruk gaya', tone: 'text-red-600 dark:text-red-400' },
  { value: 'important', label: 'Jaldi chahiye', tone: 'text-amber-600 dark:text-amber-400' },
  { value: 'minor', label: 'Chhoti baat', tone: 'text-emerald-600 dark:text-emerald-400' },
];

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: { length: number; [index: number]: { 0: { transcript: string }; isFinal: boolean } } }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export function ReportProblemButton(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn-ghost gap-1.5 px-2.5 text-red-600 dark:text-red-400"
        title="Report a Problem — koi gadbad ho to yahan batayein"
        aria-label="Report a Problem"
      >
        <span className="text-base leading-none">🐞</span>
        <span className="hidden text-xs font-medium sm:inline">Report</span>
      </button>
      {open && <ReportProblemModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function ReportProblemModal({ onClose }: { onClose: () => void }): JSX.Element {
  const location = useLocation();
  const user = useApp((s) => s.user);
  const [kind, setKind] = useState<Kind>('bug');
  const [severity, setSeverity] = useState<Severity>('important');
  const [text, setText] = useState('');
  const [shots, setShots] = useState<{ file: File; preview: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // The screen he is on, so he never names it himself. /leads/<id>/edit
  // becomes "leads ke edit page par".
  const whereAmI = useMemo(() => {
    const parts = location.pathname.split('/').filter(Boolean);
    if (!parts.length) return 'Dashboard';
    if (parts[0] === 'dashboard') return 'Dashboard';
    const module = parts[0];
    if (parts.length === 1) return module;
    if (parts[1] === 'new') return `${module} — naya record`;
    if (parts[2] === 'edit') return `${module} — record edit`;
    if (parts[1]) return `${module} — ek record`;
    return module;
  }, [location.pathname]);

  // Paste a screenshot straight in. This is the path of least resistance for
  // anyone who has ever taken a screenshot with Cmd-Shift-4.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) { void addShot(file); e.preventDefault(); }
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Voice, through the browser. Only Chromium-family exposes it — the button
  // simply does not render anywhere else, rather than showing a dead button.
  const speech = useMemo((): SpeechRecognitionLike | null => {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    return Ctor ? new Ctor() : null;
  }, []);

  useEffect(() => {
    if (!speech) return;
    speech.lang = 'hi-IN';
    speech.continuous = true;
    speech.interimResults = false;
    speech.onresult = (e) => {
      // Get the final transcript from the last result in this batch.
      // With interimResults=false only final results are returned.
      const transcript = e.results[e.results.length - 1]?.[0]?.transcript ?? '';
      if (!transcript.trim()) return;
      setText((prev) => (prev ? `${prev} ${transcript.trim()}` : transcript.trim()));
    };
    speech.onend = () => setListening(false);
    speech.onerror = () => setListening(false);
    return () => { try { speech.stop(); } catch { /* not started */ } };
  }, [speech]);

  const toggleListen = (): void => {
    if (!speech) return;
    if (listening) { speech.stop(); setListening(false); }
    else { speech.start(); setListening(true); }
  };

  const addShot = async (file: File): Promise<void> => {
    const shrunk = await compressImage(file, { maxEdge: 1600 }).catch(() => ({ file, compressed: false } as { file: File; compressed: boolean }));
    const preview = URL.createObjectURL(shrunk.file);
    setShots((prev) => [...prev.slice(0, 3), { file: shrunk.file, preview }]);
  };

  const onFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
    for (const f of Array.from(e.target.files ?? [])) void addShot(f);
    e.target.value = '';
  };

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length < 3) {
      toast.error('Thoda likhein', 'Kam se kam ek line mein bataayein ki kya hua.');
      textRef.current?.focus();
      return;
    }
    setSending(true);
    try {
      const form = new FormData();
      form.set('text', trimmed);
      form.set('kind', kind);
      form.set('severity', severity);
      form.set('route', whereAmI);
      // The module for context, without the record id — the record itself is
      // none of GitHub's business.
      const moduleGuess = location.pathname.split('/')[1];
      if (moduleGuess && moduleGuess !== 'dashboard' && moduleGuess !== 'capture'
        && moduleGuess !== 'settings' && moduleGuess !== 'reports' && moduleGuess !== 'admin') {
        form.set('moduleName', moduleGuess);
      }
      shots.forEach((s, i) => form.append('screenshots', s.file, s.file.name || `screenshot-${i + 1}.png`));
      const res = await api.submitFeedback(form);
      toast.success('Report bhej di gayi!', res.message);
      shots.forEach((s) => URL.revokeObjectURL(s.preview));
      onClose();
      window.location.href = '/feedback';
    } catch (err) {
      toast.error('Nahi bhej paaye', err instanceof Error ? err.message : 'Dobara try karein.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Report a Problem" size="md">
      <div className="space-y-4 px-5 py-4">
        <div className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 dark:bg-brand-950 dark:text-brand-200">
          Aap <strong>{whereAmI}</strong> par hain — ye automatically bataya jayega. Bas likhein (ya bolien) ki kya hua.
          {user?.fullName ? ` — ${user.fullName}` : ''}
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Kya hai baat?</legend>
          <div className="grid grid-cols-3 gap-2">
            {KINDS.map((k) => (
              <button
                key={k.value}
                onClick={() => setKind(k.value)}
                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-center text-xs font-medium transition-colors ${
                  kind === k.value
                    ? 'border-brand-600 bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-400'
                }`}
                aria-pressed={kind === k.value}
              >
                {k.icon}
                {k.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="feedback-text" className="mb-1.5 block text-sm font-medium">
            Detail mein batayein
          </label>
          <div className="relative">
            <textarea
              id="feedback-text"
              ref={textRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder={
                kind === 'bug'
                  ? 'Jaise: "Property edit karne par locality field khali ho jati hai." Jo hone ki ummeed thi, wo bhi likh dein.'
                  : kind === 'idea'
                    ? 'Jaise: "Aisa feature chahiye jahan main mark kar sakoon ki owner abhi bechne ka mann hai."'
                    : 'Jaise: "Dashboard ka Budget widget kaise padhein?"'
              }
              className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 pr-12 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-800"
            />
            {speech && (
              <button
                onClick={toggleListen}
                className={`absolute right-2 top-2 rounded-full p-2 transition-colors ${
                  listening
                    ? 'animate-pulse bg-red-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                }`}
                title={listening ? 'Sun rahe hain... rokne ke liye dabayein' : 'Bol kar likhein (Hindi)'}
                aria-label={listening ? 'Stop dictation' : 'Start dictation'}
              >
                {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
            )}
          </div>
          {speech && (
            <p className="mt-1 text-xs text-muted">
              {listening ? 'Sun rahe hain — Hindi mein bolte jayein.' : 'Mic button dabakar Hindi mein bol bhi sakte hain.'}
            </p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Kitna zaroori hai?</label>
          <div className="flex gap-2">
            {SEVERITIES.map((s) => (
              <button
                key={s.value}
                onClick={() => setSeverity(s.value)}
                className={`flex-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  severity === s.value
                    ? `border-current bg-slate-50 dark:bg-slate-800 ${s.tone}`
                    : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-slate-700 dark:text-slate-400'
                }`}
                aria-pressed={severity === s.value}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Screenshot (optional)</label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => fileInput.current?.click()}
              className="btn-ghost gap-1.5 border border-dashed border-slate-300 px-3 py-2 text-xs dark:border-slate-700"
            >
              <Paperclip className="h-3.5 w-3.5" /> Photo chunein
            </button>
            <span className="text-xs text-muted">ya seedha paste karein (Ctrl/Cmd+V)</span>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={onFiles} />
          </div>
          {shots.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {shots.map((s, i) => (
                <div key={s.preview} className="relative">
                  <img src={s.preview} alt={`screenshot ${i + 1}`} className="h-16 w-24 rounded-md border border-slate-200 object-cover dark:border-slate-700" />
                  <button
                    onClick={() => { URL.revokeObjectURL(s.preview); setShots((prev) => prev.filter((x) => x.preview !== s.preview)); }}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-red-600 p-1 text-white shadow"
                    aria-label="Remove screenshot"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3.5 dark:border-slate-800">
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={() => void submit()} disabled={sending} className="btn-primary gap-1.5">
          {sending ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {sending ? 'Bhej rahe hain…' : 'Bhejein'}
        </button>
      </div>
    </Modal>
  );
}
