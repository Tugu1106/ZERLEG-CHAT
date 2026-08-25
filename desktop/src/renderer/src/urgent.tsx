import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { startAlertSound } from './alertSound';
import { coerceTheme } from '../../shared/protocol';
import type { ChatMessage, UrgentQueuePayload } from '../../shared/ipc';
import './urgent.css';

/**
 * A keystroke already travelling towards the app must not dismiss an alert the
 * user has not read yet, so the button stays inert for a beat after it appears.
 */
const ARM_DELAY_MS = 1200;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function UrgentOverlay() {
  const [queue, setQueue] = useState<ChatMessage[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [armed, setArmed] = useState(false);

  const current = queue[0] ?? null;
  // The look belongs to whoever sent this particular message.
  const theme = coerceTheme(current?.theme);
  const stopSoundRef = useRef<(() => void) | null>(null);

  // Main pushes the queue whenever it changes; also pull once in case the window
  // finished loading after the first push.
  useEffect(() => {
    const off = window.api.on<UrgentQueuePayload>('urgent:queue', (payload) => {
      setQueue(payload.queue);
      setSoundEnabled(payload.soundEnabled);
    });
    void window.api.getUrgentQueue().then((initial) => {
      setQueue((existing) => (existing.length ? existing : initial));
    });
    return off;
  }, []);

  // The theme is a whole-document concern, so it rides on the root element.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Re-arm and re-sound for each message in the queue.
  useEffect(() => {
    if (!current) return;
    setArmed(false);
    const timer = window.setTimeout(() => setArmed(true), ARM_DELAY_MS);

    stopSoundRef.current?.();
    stopSoundRef.current = soundEnabled ? startAlertSound() : null;

    return () => {
      window.clearTimeout(timer);
      stopSoundRef.current?.();
      stopSoundRef.current = null;
    };
  }, [current?.id, soundEnabled]);

  const acknowledge = useCallback(() => {
    if (!current || !armed) return;
    stopSoundRef.current?.();
    stopSoundRef.current = null;
    void window.api.acknowledgeUrgent(current.id);
  }, [current, armed]);

  // Enter/Space acknowledge once armed. Escape deliberately does nothing - an
  // urgent alert should not be dismissible by reflex.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        acknowledge();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [acknowledge]);

  if (!current) return null;

  const waiting = queue.length - 1;

  return (
    <div className="alert">
      <div className="alert__wedge" aria-hidden="true" />
      <div className="alert__disc" aria-hidden="true" />
      <div className="alert__bars" aria-hidden="true" />

      <main className="alert__inner" role="alertdialog" aria-labelledby="alert-title">
        {/* Two fixed zones: cream type stays on the red band, ink type on paper. */}
        <header className="alert__top">
          <p className="alert__tag">Zerleg Chat &mdash; Priority</p>
          <h1 className="alert__title" id="alert-title">
            Urgent
          </h1>
        </header>

        <section className="alert__bottom">
          <p className="alert__from">
            {current.fromName}
            <span>
              {formatTime(current.ts)}
              {current.to === 'all' && ' — to everyone'}
            </span>
          </p>

          <blockquote className="alert__body">{current.body}</blockquote>

          <div className="alert__foot">
            <button
              type="button"
              className="alert__ack"
              onClick={acknowledge}
              disabled={!armed}
              autoFocus
            >
              {armed ? 'Acknowledge' : 'Read it…'}
            </button>

            {waiting > 0 && <p className="alert__queue">+{waiting} more waiting</p>}
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <UrgentOverlay />
  </StrictMode>,
);
