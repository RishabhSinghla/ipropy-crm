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
  /** Start, or stop and hand the recording to `onRecorded`. */
  toggle: () => void;
}

export function useVoiceCapture(
  onRecorded: (audio: Blob) => Promise<void> | void,
): VoiceCapture {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const handler = useRef(onRecorded);
  handler.current = onRecorded;

  const supported = typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined';

  // A microphone left live after the panel closes is a red dot in the browser
  // tab that nobody can explain and nothing turns off.
  useEffect(() => () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const toggle = useCallback(() => {
    if (recording) {
      if (recorder.current?.state === 'recording') recorder.current.stop();
      return;
    }
    if (!supported) {
      toast.error('This browser cannot record audio');
      return;
    }

    void navigator.mediaDevices.getUserMedia({ audio: true }).then((live) => {
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
        setBusy(true);
        void Promise.resolve(handler.current(audio)).finally(() => setBusy(false));
      };
      rec.start();
      setRecording(true);
    }).catch((err: Error) => {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      toast.error('Microphone unavailable', err.message);
    });
  }, [recording, supported]);

  return { recording, busy, supported, toggle };
}
