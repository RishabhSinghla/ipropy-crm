/**
 * Speech-to-text for call recordings.
 *
 * Talks to an OpenAI-compatible `/audio/transcriptions` endpoint (defaults to
 * OpenAI Whisper). Degrades gracefully: without an API key the caller gets a
 * clear "not configured" signal and call analysis keeps requiring a manual
 * transcript — nothing throws, nothing blocks.
 */
import { logger } from '../../utils/logger.js';

export interface SttSettings {
  provider: 'none' | 'openai';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function isSttConfigured(s: SttSettings): boolean {
  return s.provider === 'openai' && Boolean(s.apiKey);
}

export class SttError extends Error {}

/** Download the recording and transcribe it. Throws SttError on any failure. */
export async function transcribeRecording(url: string, s: SttSettings): Promise<string> {
  const audio = await downloadRecording(url);
  if (!audio) throw new SttError('Could not download the recording — the URL may be unreachable or expired');

  const endpoint = `${s.baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
  const form = new FormData();
  form.append('model', s.model);
  form.append('response_format', 'text');
  form.append('file', new Blob([audio.body]), audio.name || 'recording.mp3');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new SttError(`Transcription failed (${res.status}): ${detail || res.statusText}`);
  }

  const raw = (await res.text()).trim();
  if (!raw) throw new SttError('Transcription returned an empty result');
  // Some providers ignore response_format and return JSON anyway — unwrap it.
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    if (typeof parsed.text === 'string') return parsed.text;
  } catch {
    // not JSON — plain text
  }
  return raw;
}

async function downloadRecording(url: string): Promise<{ body: ArrayBuffer; name: string | null } | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    const ext = contentType.includes('mp3')
      ? 'mp3'
      : contentType.includes('wav')
        ? 'wav'
        : contentType.includes('ogg') || contentType.includes('opus')
          ? 'ogg'
          : 'mp3';
    return { body: await res.arrayBuffer(), name: `recording.${ext}` };
  } catch (err) {
    logger.warn({ err }, 'recording download failed for STT');
    return null;
  }
}
