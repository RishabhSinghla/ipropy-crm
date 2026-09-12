import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from './store';

/**
 * Hold the microphone, hand back a recording.
 *
 * Written once because there are now two places that want it — the assistant's
 * compose box and the notes panel on a lead — and a second copy of MediaRecorder
 * handling is a second set of the same three bugs: a stream left open when the
 * component unmounts, a mime type Safari refuses, and a stop that never fires.
 *
 * It knows nothing about what the audio is for. The caller decides what to send
 * it to, which is what keeps this reusable rather than a notes feature with a
 * microphone welded on.
 */
export interface VoiceCapture {
  recording: boolean;
  busy: boolean;
  supported: boolean;
  /** What the browser has heard so far, while it is still listening. */
  interim: string;
  /** Start, or stop and hand the recording to `onRecorded`. */
  toggle: () => void;
  /** Stop without submitting, used when its popup is dismissed. */
  cancel: () => void;
}

/*
  Chrome's own recogniser, when there is no transcription service to post to.

  Whisper is the better ear for this team — they speak Hinglish and write it in
  Latin script, and Chrome's recogniser is poor at that — so the recording path
  above stays the default *when a key is configured*. Without one the mic
  recorded, posted, and came back "Speech-to-text is not configured": a button
  that looks like it works and never does, which is how it has been on
  production all along.

  So this is the floor. It is free, needs no key, runs on the device, and shows
  the words as they are said, which the recording path cannot do at all. Not
  every browser has it — Firefox does not — and there the recording path is
  still tried, which at least produces an honest error about a missing key
  rather than silence.
*/
type SpeechCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function speechRecognition(): SpeechCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoiceCapture(
  onRecorded: (audio: Blob) => Promise<void> | void,
  opts: {
    /*
      Called with text the browser recognised itself, instead of `onRecorded`.
      Only used on the fallback path — the caller puts it straight in the box.
    */
    onTranscript?: (text: string) => void;
    /** False when no transcription service is configured, which turns the fallback on. */
    serverTranscription?: boolean;
  } = {},
): VoiceCapture {
  const [interim, setInterim] = useState('');
  const recogniser = useRef<InstanceType<SpeechCtor> | null>(null);
  const heard = useRef('');
  const onTranscript = useRef(opts.onTranscript);
  onTranscript.current = opts.onTranscript;

  // Only when there is nowhere better to send it. `undefined` means the caller
  // has not said, and the old behaviour — post to the server — is the safer
  // default for a caller that has not been updated.
  const useBrowser = opts.serverTranscription === false
    && Boolean(speechRecognition())
    && Boolean(opts.onTranscript);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const starting = useRef(false);
  const discard = useRef(false);
  const handler = useRef(onRecorded);
  handler.current = onRecorded;

  const supported = typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined';

  // A microphone left live after the panel closes is a red dot in the browser
  // tab that nobody can explain and nothing turns off.
  const cancel = useCallback(() => {
    discard.current = true;
    starting.current = false;
    setInterim('');
    if (recogniser.current) { recogniser.current.onend = null; recogniser.current.stop(); recogniser.current = null; }
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setRecording(false);
    setBusy(false);
  }, []);

  useEffect(() => () => {
    discard.current = true;
    if (recogniser.current) { recogniser.current.onend = null; recogniser.current.stop(); }
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const toggle = useCallback(() => {
    if (recording) {
      if (recogniser.current) { recogniser.current.stop(); return; }
      if (recorder.current?.state === 'recording') recorder.current.stop();
      return;
    }
    if (starting.current) return;
    if (!supported) {
      toast.error('This browser cannot record audio');
      return;
    }

    /*
      The browser's own ear, when there is no service to post to.

      `en-IN` rather than `en-US`: it is what the recogniser is tuned on for
      Indian English, and it is the difference between "Sector twenty one" and
      "Sector 21". Interim results are on because watching the words appear is
      how somebody knows it is listening at all — the recording path can only
      show a pulsing dot.
    */
    if (useBrowser) {
      const Ctor = speechRecognition()!;
      const rec = new Ctor();
      rec.lang = 'en-IN';
      rec.continuous = true;
      rec.interimResults = true;
      heard.current = '';
      rec.onresult = (event) => {
        let live = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const chunk = event.results[i][0].transcript;
          if (event.results[i].isFinal) heard.current += chunk;
          else live += chunk;
        }
        setInterim((heard.current + live).trim());
      };
      rec.onerror = (event) => {
        // "no-speech" is somebody thinking, not a failure worth a red toast.
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          toast.error('Could not hear you', event.error === 'not-allowed'
            ? 'Allow microphone access for this site and try again.'
            : event.error);
        }
      };
      rec.onend = () => {
        recogniser.current = null;
        setRecording(false);
        const text = heard.current.trim();
        setInterim('');
        heard.current = '';
        if (discard.current) { discard.current = false; return; }
        if (text) onTranscript.current?.(text);
      };
      recogniser.current = rec;
      discard.current = false;
      setRecording(true);
      try {
        rec.start();
      } catch {
        recogniser.current = null;
        setRecording(false);
        toast.error('Could not start the microphone');
      }
      return;
    }

    starting.current = true;
    discard.current = false;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then((live) => {
      starting.current = false;
      stream.current = live;
      chunks.current = [];
      // Safari will not produce webm and Chrome prefers opus. Asking for the
      // first supported type rather than a fixed one is the difference between
      // working on a rep's iPhone and not.
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(live, mime ? { mimeType: mime } : undefined);
      recorder.current = rec;
      rec.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      rec.onstop = () => {
        const audio = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
        live.getTracks().forEach((track) => track.stop());
        stream.current = null;
        recorder.current = null;
        setRecording(false);
        if (discard.current) { discard.current = false; return; }
        if (!audio.size) {
          toast.error('Nothing was recorded', 'Please allow microphone access and try again.');
          return;
        }
        setBusy(true);
        void Promise.resolve(handler.current(audio)).finally(() => setBusy(false));
      };
      rec.onerror = () => toast.error('Recording stopped unexpectedly', 'Please try the microphone again.');
      // Regular chunks are more reliable than waiting for one final browser
      // event, especially on Safari and when the phone briefly backgrounds.
      rec.start(250);
      setRecording(true);
    }).catch((err: Error) => {
      starting.current = false;
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      toast.error('Microphone unavailable', err.message);
    });
  }, [recording, supported, useBrowser]);

  return { recording, busy, supported: supported || useBrowser, interim, toggle, cancel };
}
