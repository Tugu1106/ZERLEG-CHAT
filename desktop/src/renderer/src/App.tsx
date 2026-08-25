import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SettingsDialog } from './SettingsDialog';
import { BROADCAST_TARGET } from '../../shared/protocol';
import type { ChatMessage, NetState, Settings, User } from '../../shared/ipc';
import type { UrgentAck } from '../../shared/protocol';

type ConversationKey = string;

const STATUS_TEXT: Record<NetState['status'], string> = {
  starting: 'Starting up',
  online: 'On the network',
  error: 'Network problem',
};

/** Which conversation a message belongs to, from my point of view. */
function conversationOf(message: ChatMessage, myId: string | undefined): ConversationKey {
  if (message.to === BROADCAST_TARGET) return BROADCAST_TARGET;
  return message.from === myId ? message.to : message.from;
}

function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  // Tolerate a missing/!malformed payload rather than blanking the whole window.
  if (!Array.isArray(incoming)) return previous;
  const byId = new Map(previous.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) return 'Today';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function App() {
  const [state, setState] = useState<NetState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [acks, setAcks] = useState<Record<string, UrgentAck[]>>({});
  const [active, setActive] = useState<ConversationKey>(BROADCAST_TARGET);
  const [unread, setUnread] = useState<Record<ConversationKey, number>>({});
  const [draft, setDraft] = useState('');
  const [urgentMode, setUrgentMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const myId = state?.me?.id;
  // Read inside the message listener, which is registered once.
  const activeRef = useRef(active);
  activeRef.current = active;
  const myIdRef = useRef(myId);
  myIdRef.current = myId;

  useEffect(() => {
    void window.api.getSnapshot().then((snapshot) => {
      setState(snapshot.state);
      setSettings(snapshot.settings);
      setMessages((prev) => mergeMessages(prev, snapshot.history));
      setAcks(() => {
        const grouped: Record<string, UrgentAck[]> = {};
        for (const ack of snapshot.acks ?? []) {
          (grouped[ack.messageId] ??= []).push(ack);
        }
        return grouped;
      });
    });

    const offs = [
      window.api.on<NetState>('state', setState),
      window.api.on<Settings>('settings', setSettings),
      window.api.on<ChatMessage[]>('chat:history', (history) => {
        setMessages((prev) => mergeMessages(prev, history));
      }),
      window.api.on<ChatMessage>('chat:message', (message) => {
        setMessages((prev) => mergeMessages(prev, [message]));
        const key = conversationOf(message, myIdRef.current);
        if (key !== activeRef.current && message.from !== myIdRef.current) {
          setUnread((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
        }
      }),
      window.api.on<UrgentAck>('chat:urgent-acked', (ack) => {
        setAcks((prev) => {
          const existing = prev[ack.messageId] ?? [];
          if (existing.some((a) => a.by === ack.by)) return prev;
          return { ...prev, [ack.messageId]: [...existing, ack] };
        });
      }),
    ];

    return () => offs.forEach((off) => off());
  }, []);

  // Opening a conversation clears its badge and any stale composer feedback.
  useEffect(() => {
    setUnread((prev) => (prev[active] ? { ...prev, [active]: 0 } : prev));
    setError(null);
    setNotice(null);
  }, [active]);

  const peers = useMemo(
    () => (state?.users ?? []).filter((u) => u.id !== myId),
    [state?.users, myId],
  );

  const activePeer: User | undefined = useMemo(
    () => peers.find((u) => u.id === active),
    [peers, active],
  );

  const visible = useMemo(
    () => messages.filter((m) => conversationOf(m, myId) === active),
    [messages, myId, active],
  );

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, active]);

  const ready = state?.status === 'online';
  const onlineCount = peers.filter((p) => p.online).length;
  const canSend = ready && draft.trim().length > 0 && !sending;

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body || !ready || sending) return;

    setSending(true);
    setError(null);
    setNotice(null);
    const result = await window.api.send({ to: active, body, urgent: urgentMode });
    setSending(false);

    if (!result.ok) {
      setError(result.error ?? 'Could not send the message.');
      return;
    }
    // With no server holding messages, the sender is the one queueing them.
    setNotice(
      result.queued
        ? `${title} is offline. This will be delivered as soon as they are back - keep this app running.`
        : null,
    );
    setDraft('');
    setUrgentMode(false);
  }, [draft, ready, sending, active, urgentMode]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const title = active === BROADCAST_TARGET ? 'Everyone' : (activePeer?.name ?? 'Unknown user');

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar__head">
          <div className="identity">
            <span className={`dot dot--${ready ? 'online' : 'offline'}`} />
            <div className="identity__text">
              <strong>{settings?.displayName ?? '...'}</strong>
              <small>
                {ready
                  ? onlineCount === 0
                    ? 'Waiting for others'
                    : `${onlineCount} ${onlineCount === 1 ? 'person' : 'people'} online`
                  : STATUS_TEXT[state?.status ?? 'starting']}
              </small>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Settings"
            onClick={() => setShowSettings(true)}
          >
            &#9881;
          </button>
        </header>

        <nav className="channels">
          <button
            type="button"
            className={`channel ${active === BROADCAST_TARGET ? 'channel--active' : ''}`}
            onClick={() => setActive(BROADCAST_TARGET)}
          >
            <span className="channel__avatar channel__avatar--all">#</span>
            <span className="channel__name">Everyone</span>
            {(unread[BROADCAST_TARGET] ?? 0) > 0 && (
              <span className="badge">{unread[BROADCAST_TARGET]}</span>
            )}
          </button>

          <p className="channels__label">
            People
            <span>{peers.filter((p) => p.online).length} online</span>
          </p>

          {peers.length === 0 && <p className="channels__empty">Nobody else has joined yet.</p>}

          {peers.map((peer) => (
            <button
              key={peer.id}
              type="button"
              className={`channel ${active === peer.id ? 'channel--active' : ''}`}
              onClick={() => setActive(peer.id)}
            >
              <span className="channel__avatar">{peer.name.slice(0, 1).toUpperCase()}</span>
              <span className="channel__name">{peer.name}</span>
              <span className={`dot dot--${peer.online ? 'online' : 'offline'}`} />
              {(unread[peer.id] ?? 0) > 0 && <span className="badge">{unread[peer.id]}</span>}
            </button>
          ))}
        </nav>
      </aside>

      <main className="chat">
        <header className="chat__head">
          <div>
            <h1>{title}</h1>
            <p>
              {active === BROADCAST_TARGET
                ? `Everyone on the network right now (${onlineCount})`
                : activePeer?.online
                  ? 'Online'
                  : 'Offline - urgent messages will be delivered when they return'}
            </p>
          </div>
          {state?.address && (
            <span className="server-chip" title="This machine on the network">
              {state.address}:{state.port}
            </span>
          )}
        </header>

        {!ready && (
          <div className="banner">
            <span className="banner__spinner" />
            <div>
              <strong>{STATUS_TEXT[state?.status ?? 'starting']}</strong>
              <p>{state?.error ?? 'Opening the network port.'}</p>
            </div>
            <button type="button" onClick={() => void window.api.refresh()}>
              Retry
            </button>
          </div>
        )}

        <div className="messages" ref={listRef}>
          {visible.length === 0 && (
            <div className="messages__empty">
              <p>No messages here yet.</p>
              <span>
                {active === BROADCAST_TARGET
                  ? 'Say something to the whole room.'
                  : `Start the conversation with ${title}.`}
              </span>
            </div>
          )}

          {visible.map((message, index) => {
            const mine = message.from === myId;
            const previous = visible[index - 1];
            const showDay = !previous || formatDay(previous.ts) !== formatDay(message.ts);
            const messageAcks = acks[message.id] ?? [];

            return (
              <div key={message.id}>
                {showDay && <div className="day-divider">{formatDay(message.ts)}</div>}
                <article
                  className={`message ${mine ? 'message--mine' : ''} ${
                    message.urgent ? 'message--urgent' : ''
                  }`}
                >
                  <div className="message__meta">
                    {!mine && <span className="message__author">{message.fromName}</span>}
                    {message.urgent && <span className="chip chip--urgent">URGENT</span>}
                    <time>{formatTime(message.ts)}</time>
                  </div>
                  <p className="message__body">{message.body}</p>
                  {message.urgent && mine && (
                    <p className="message__ack">
                      {messageAcks.length > 0
                        ? `Acknowledged by ${messageAcks.map((a) => a.byName).join(', ')}`
                        : 'Waiting for acknowledgement'}
                    </p>
                  )}
                </article>
              </div>
            );
          })}
        </div>

        <footer className={`composer ${urgentMode ? 'composer--urgent' : ''}`}>
          {error && <p className="composer__error">{error}</p>}
          {notice && <p className="composer__notice">{notice}</p>}

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={2000}
            placeholder={
              ready
                ? urgentMode
                  ? `This will take over ${title}'s screen. Make it count.`
                  : `Message ${title}`
                : 'Starting up...'
            }
            disabled={!ready}
          />

          <div className="composer__actions">
            <label className={`urgent-toggle ${urgentMode ? 'urgent-toggle--on' : ''}`}>
              <input
                type="checkbox"
                checked={urgentMode}
                onChange={(event) => setUrgentMode(event.target.checked)}
                disabled={!ready}
              />
              <span className="urgent-toggle__track">
                <span className="urgent-toggle__thumb" />
              </span>
              <span className="urgent-toggle__label">
                Urgent
                <small>Fullscreen alert on their machine</small>
              </span>
            </label>

            <button
              type="button"
              className={`send ${urgentMode ? 'send--urgent' : ''}`}
              onClick={() => void submit()}
              disabled={!canSend}
            >
              {sending ? 'Sending...' : urgentMode ? 'SEND URGENT' : 'Send'}
            </button>
          </div>
        </footer>
      </main>

      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          state={state}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => {
            const updated = await window.api.setSettings(patch);
            setSettings(updated);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}
