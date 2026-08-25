/**
 * Synthesised alert siren.
 *
 * Generating the tone with the Web Audio API instead of shipping an audio file
 * keeps the repo binary-free and lets the alert start instantly, with no decode.
 */

const TONE_HIGH = 880;
const TONE_LOW = 620;
const PATTERN_MS = 1400;
/** Stop after ~20s. The window stays up until acknowledged - only the noise stops. */
const MAX_REPEATS = 14;

function playTone(ctx: AudioContext, frequency: number, startAt: number, duration: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(frequency, startAt);

  // Exponential ramps avoid the click you get from stepping gain instantly.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.3, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

/** Starts the siren; returns a stop function. */
export function startAlertSound(): () => void {
  let ctx: AudioContext | null = null;
  let timer: number | undefined;
  let repeats = 0;

  try {
    ctx = new AudioContext();
  } catch {
    return () => {};
  }

  // Electron allows autoplay by default, but resume() costs nothing and covers
  // the case where the context starts suspended.
  void ctx.resume();

  const burst = (): void => {
    if (!ctx || ctx.state === 'closed') return;
    const now = ctx.currentTime;
    playTone(ctx, TONE_HIGH, now, 0.3);
    playTone(ctx, TONE_LOW, now + 0.35, 0.3);

    repeats += 1;
    if (repeats >= MAX_REPEATS) stop();
  };

  const stop = (): void => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
    if (ctx && ctx.state !== 'closed') {
      void ctx.close();
    }
    ctx = null;
  };

  burst();
  timer = window.setInterval(burst, PATTERN_MS);

  return stop;
}
