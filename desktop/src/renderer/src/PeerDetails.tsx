import { useState } from 'react';

import type { User } from '../../shared/ipc';

interface Props {
  peer: User;
  onClose: () => void;
  onForget: (id: string) => Promise<void>;
}

function formatWhen(ts: number | undefined): string {
  if (!ts) return 'unknown';
  return new Date(ts).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * "Who is this?" - the app has no accounts and no authentication, so anyone on
 * the network can pick any display name. The device id and address are the only
 * things that actually identify a peer, and this is where you can see them.
 */
export function PeerDetails({ peer, onClose, onForget }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  const forget = async (): Promise<void> => {
    setWorking(true);
    await onForget(peer.id);
    setWorking(false);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2>Who is this?</h2>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            &#10005;
          </button>
        </header>

        <div className="dialog__body">
          <dl className="facts">
            <dt>Display name</dt>
            <dd>
              {peer.name}
              <small>Self-chosen and unverified. Anyone can pick any name.</small>
            </dd>

            <dt>Status</dt>
            <dd>
              <span className="facts__inline">
                <span className={`dot dot--${peer.online ? 'online' : 'offline'}`} />
                {peer.online ? 'Online now' : 'Offline'}
              </span>
            </dd>

            <dt>Device ID</dt>
            <dd>
              <code className="facts__id">{peer.id}</code>
              <small>
                Generated once per installation. This is the only thing that actually
                identifies them.
              </small>
            </dd>

            <dt>Address</dt>
            <dd>
              {peer.online && peer.address ? (
                <code>
                  {peer.address}:{peer.port}
                </code>
              ) : (
                <span className="facts__none">Only known while they are online</span>
              )}
            </dd>

            <dt>First seen</dt>
            <dd>{formatWhen(peer.firstSeen)}</dd>

            <dt>Last seen</dt>
            <dd>{peer.online ? 'Now' : formatWhen(peer.lastSeen)}</dd>
          </dl>

          {!confirming ? (
            <button type="button" className="ghost ghost--wide" onClick={() => setConfirming(true)}>
              Forget this person
            </button>
          ) : (
            <div className="confirm">
              <p>
                Remove <strong>{peer.name}</strong> and your conversation with them from this
                machine?
                {peer.online && ' They are online, so they will reappear within a few seconds.'}
              </p>
              <div className="confirm__actions">
                <button type="button" className="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="send send--danger"
                  onClick={() => void forget()}
                  disabled={working}
                >
                  {working ? 'Removing…' : 'Forget'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
