/**
 * A buzzer, made in the browser rather than shipped as a file.
 *
 * Three hard, square-wave bursts — the sound of an alarm clock, not of a
 * notification somebody has learned to ignore. No audio file means nothing to
 * load, nothing to cache and nothing that can 404.
 *
 * Browsers refuse to make a sound until the person has clicked something on
 * the page. Anybody who has signed in has clicked, so in practice it plays;
 * when it cannot, it stays silent rather than throwing, and the popup still
 * opens.
 */
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    return context;
  } catch {
    return null;
  }
}

/** Three short bursts, about a second and a half in all. */
export function playBuzzer(): void {
  const ctx = audio();
  if (!ctx) return;
  const start = ctx.currentTime + 0.02;
  for (let burst = 0; burst < 3; burst += 1) {
    const at = start + burst * 0.45;
    const tone = ctx.createOscillator();
    const volume = ctx.createGain();
    tone.type = 'square';
    tone.frequency.setValueAtTime(880, at);
    tone.frequency.setValueAtTime(660, at + 0.15);
    volume.gain.setValueAtTime(0.0001, at);
    volume.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
    volume.gain.setValueAtTime(0.35, at + 0.28);
    volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
    tone.connect(volume).connect(ctx.destination);
    tone.start(at);
    tone.stop(at + 0.34);
  }
}
