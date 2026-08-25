import { useState } from 'react';

import { URGENT_THEMES, URGENT_THEME_INFO } from '../../shared/ipc';
import type { NetState, Settings, UrgentTheme } from '../../shared/ipc';

interface Props {
  settings: Settings;
  state: NetState | null;
  onClose: () => void;
  onSave: (patch: Partial<Settings>) => Promise<void>;
}

export function SettingsDialog({ settings, state, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  /**
   * Commit the chosen theme before previewing: the sample alert is built from
   * settings, the same way a real outgoing message is.
   */
  const preview = async (): Promise<void> => {
    setPreviewing(true);
    await window.api.setSettings({ urgentTheme: draft.urgentTheme });
    await window.api.previewUrgent();
    setPreviewing(false);
  };

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const save = async (): Promise<void> => {
    setSaving(true);
    await onSave({
      displayName: draft.displayName.trim() || 'Anonymous',
      urgentTheme: draft.urgentTheme,
      soundEnabled: draft.soundEnabled,
      launchAtLogin: draft.launchAtLogin,
      showWindowOnLaunch: draft.showWindowOnLaunch,
    });
    setSaving(false);
  };

  const online = state?.users.filter((u) => u.online && u.id !== state?.me?.id).length ?? 0;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2>Settings</h2>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            &#10005;
          </button>
        </header>

        <div className="dialog__body">
          <label className="field">
            <span>Display name</span>
            <input
              value={draft.displayName}
              maxLength={32}
              onChange={(event) => set('displayName', event.target.value)}
            />
            <small>How you appear to everyone else on the network.</small>
          </label>

          <div className="field">
            <span>Network</span>
            <p className="field__note">
              {state?.status === 'online' ? (
                <>
                  Listening on <strong>{state.address ?? 'this machine'}:{state.port}</strong>.
                  {online === 0
                    ? ' Nobody else is online yet.'
                    : ` ${online} ${online === 1 ? 'person' : 'people'} online.`}
                </>
              ) : (
                (state?.error ?? 'Starting up...')
              )}
            </p>
            <small>
              There is no server to configure. The app finds everyone else running it on this
              network automatically.
            </small>
          </div>

          <div className="field">
            <span>Your urgent alert style</span>
            <p className="field__hint">
              How <em>your</em> urgent messages look when they take over someone else's
              screen. It travels with the message, so everyone sees your alert your way.
            </p>

            <div className="themes">
              {URGENT_THEMES.map((id: UrgentTheme) => {
                const info = URGENT_THEME_INFO[id];
                return (
                  <button
                    key={id}
                    type="button"
                    className={`theme ${draft.urgentTheme === id ? 'theme--on' : ''}`}
                    onClick={() => set('urgentTheme', id)}
                  >
                    <span className="theme__swatch">
                      {info.swatch.map((colour) => (
                        <i key={colour} style={{ background: colour }} />
                      ))}
                    </span>
                    <span className="theme__text">
                      <strong>{info.name}</strong>
                      <small>{info.note}</small>
                    </span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="ghost ghost--wide"
              onClick={() => void preview()}
              disabled={previewing}
            >
              {previewing ? 'Showing…' : 'Preview what they will see'}
            </button>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={draft.soundEnabled}
              onChange={(event) => set('soundEnabled', event.target.checked)}
            />
            Play a sound for urgent alerts
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={draft.launchAtLogin}
              onChange={(event) => set('launchAtLogin', event.target.checked)}
            />
            Start automatically when I sign in
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={draft.showWindowOnLaunch}
              onChange={(event) => set('showWindowOnLaunch', event.target.checked)}
            />
            Open the chat window on launch (otherwise start in the tray)
          </label>
        </div>

        <footer className="dialog__foot">
          <button type="button" className="ghost" onClick={() => void window.api.quit()}>
            Quit app
          </button>
          <div className="dialog__foot-right">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="send" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
