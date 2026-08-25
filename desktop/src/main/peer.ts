import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { Presence, localAddress, type Peer as RemotePeer } from './presence.js';
import { Store } from './store.js';
import { Transport } from './transport.js';
import { settings } from './settings.js';
import {
  BROADCAST_TARGET,
  coerceTheme,
  isValidMessage,
  sanitizeBody,
  sanitizeName,
  type ChatMessage,
  type Frame,
  type SendPayload,
  type SendResult,
  type Target,
  type UrgentAck,
  type UserId,
} from '../shared/protocol.js';
import type { NetState } from '../shared/ipc.js';

/** How long an undelivered urgent message keeps trying to reach someone. */
const PENDING_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The whole networking stack for one app instance.
 *
 * Owns presence (who is out there), transport (getting bytes to them) and the
 * local store (what we have seen). Lives in the main process so it keeps
 * running while the chat window is closed and the app is only a tray icon.
 */
export class PeerNode extends EventEmitter {
  private readonly presence = new Presence();
  private readonly transport = new Transport();
  private store: Store | null = null;

  private state: NetState = {
    status: 'starting',
    error: null,
    me: null,
    address: null,
    port: null,
    users: [],
  };

  getState(): NetState {
    return { ...this.state, users: [...this.state.users] };
  }

  getHistory(): ChatMessage[] {
    return this.store?.messages() ?? [];
  }

  getAcks(): UrgentAck[] {
    return this.store?.acks() ?? [];
  }

  /**
   * Delivers a frame to a peer, trying each address we have heard it announce
   * from until one works. The winner is remembered so the next message goes
   * straight there.
   */
  private async deliver(peer: RemotePeer, frame: Frame): Promise<boolean> {
    for (const host of peer.hosts) {
      const ok = await this.transport.send(host, peer.port, frame);
      if (ok) {
        this.presence.promoteHost(peer.id, host);
        return true;
      }
    }
    return false;
  }

  private patch(patch: Partial<NetState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  private refreshUsers(): void {
    const store = this.store;
    if (!store) return;
    const live = new Map<UserId, string>();
    for (const peer of this.presence.list()) live.set(peer.id, peer.name);
    this.patch({ users: store.users(new Set(live.keys()), live) });
  }

  async start(): Promise<void> {
    const config = settings().all;
    this.store ??= new Store();

    this.patch({
      status: 'starting',
      error: null,
      me: { id: config.deviceId, name: config.displayName, online: true, lastSeen: Date.now() },
    });

    let port: number;
    try {
      port = await this.transport.listen();
    } catch (err) {
      this.patch({
        status: 'error',
        error: `Could not open a network port: ${(err as Error).message}`,
      });
      return;
    }

    this.transport.on('frame', (frame: Frame, remote: string) => this.onFrame(frame, remote));

    this.presence.on('found', (peer: RemotePeer) => this.onPeerFound(peer));
    this.presence.on('changed', (peer: RemotePeer) => {
      this.store?.rememberPeer(peer.id, peer.name);
      this.refreshUsers();
    });
    this.presence.on('gone', () => this.refreshUsers());

    this.presence.start({ id: config.deviceId, name: config.displayName, port });

    this.patch({ status: 'online', error: null, address: localAddress(), port });
    this.refreshUsers();
  }

  stop(): void {
    this.presence.stop();
    this.transport.close();
    this.store?.saveNow();
    this.patch({ status: 'starting', users: [] });
  }

  /** Re-announce under a new display name without restarting the stack. */
  updateIdentity(): void {
    const config = settings().all;
    const port = this.transport.getPort();
    if (port === null) return;
    this.presence.refresh({ id: config.deviceId, name: config.displayName, port });
    this.patch({
      me: { id: config.deviceId, name: config.displayName, online: true, lastSeen: Date.now() },
    });
  }

  // ------------------------------------------------------------------ incoming

  private onPeerFound(peer: RemotePeer): void {
    this.store?.rememberPeer(peer.id, peer.name);
    this.refreshUsers();
    void this.flushPending(peer);
  }

  /** Deliver anything that was waiting for this peer to come back. */
  private async flushPending(peer: RemotePeer): Promise<void> {
    const store = this.store;
    if (!store) return;
    const waiting = store.takePendingFor(peer.id);
    if (waiting.length === 0) return;

    for (const message of waiting) {
      const ok = await this.deliver(peer, { type: 'message', message });
      if (!ok) {
        // Still unreachable - put it back and try again next time they appear.
        store.queuePending(peer.id, message, PENDING_TTL_MS);
      }
    }
    this.emit('pending-changed');
  }

  private onFrame(frame: Frame, remote: string): void {
    const store = this.store;
    if (!store) return;

    if (frame.type === 'message') {
      const message = frame.message;
      if (!isValidMessage(message)) return;
      if (message.from === this.state.me?.id) return; // never alert ourselves

      // Trust the network for nothing: re-clamp anything we will display.
      const clean: ChatMessage = {
        ...message,
        fromName: sanitizeName(message.fromName),
        body: sanitizeBody(message.body),
        ...(message.urgent ? { theme: coerceTheme(message.theme) } : {}),
      };
      if (!clean.body) return;

      const isNew = store.addMessage(clean);
      store.rememberPeer(clean.from, clean.fromName);
      if (!isNew) return; // duplicate delivery, e.g. a retry we already have

      this.refreshUsers();
      this.emit('message', clean);
      if (clean.urgent) this.emit('urgent', clean);
      return;
    }

    if (frame.type === 'urgent-ack') {
      const ack = frame.ack;
      if (!ack || typeof ack.messageId !== 'string' || typeof ack.by !== 'string') return;
      const clean: UrgentAck = {
        messageId: ack.messageId,
        by: ack.by,
        byName: sanitizeName(ack.byName),
        ts: Number(ack.ts) || Date.now(),
      };
      if (store.addAck(clean)) this.emit('urgent:acked', clean);
      return;
    }

    void remote;
  }

  // ------------------------------------------------------------------ outgoing

  async send(payload: SendPayload): Promise<SendResult> {
    const store = this.store;
    const me = this.state.me;
    if (!store || !me || this.state.status !== 'online') {
      return { ok: false, error: 'Not ready yet - still starting up.' };
    }

    const body = sanitizeBody(payload?.body);
    if (!body) return { ok: false, error: 'Message is empty' };

    const to: Target = payload.to === BROADCAST_TARGET ? BROADCAST_TARGET : String(payload.to);
    const urgent = Boolean(payload.urgent);
    const message: ChatMessage = {
      id: randomUUID(),
      from: me.id,
      fromName: me.name,
      to,
      body,
      urgent,
      ts: Date.now(),
      // The sender's look travels with the message; plain messages carry none.
      ...(urgent ? { theme: settings().all.urgentTheme } : {}),
    };

    // Our own copy is saved regardless of whether anyone is reachable.
    store.addMessage(message);
    this.emit('message', message);

    if (to === BROADCAST_TARGET) {
      const peers = this.presence.list();
      if (peers.length === 0) {
        return { ok: false, error: 'Nobody else is online right now.', message, delivered: 0 };
      }
      const results = await Promise.all(
        peers.map((peer) => this.deliver(peer, { type: 'message', message })),
      );
      const delivered = results.filter(Boolean).length;
      return delivered > 0
        ? { ok: true, message, delivered }
        : { ok: false, error: 'Could not reach anyone.', message, delivered: 0 };
    }

    const peer = this.presence.get(to);
    if (!peer) {
      // Offline: hold urgent messages and deliver the moment they reappear.
      if (message.urgent) {
        store.queuePending(to, message, PENDING_TTL_MS);
        return { ok: true, message, delivered: 0, queued: true };
      }
      return { ok: false, error: 'They are offline right now.', message, delivered: 0 };
    }

    const ok = await this.deliver(peer, { type: 'message', message });
    if (ok) return { ok: true, message, delivered: 1 };

    if (message.urgent) {
      store.queuePending(to, message, PENDING_TTL_MS);
      return { ok: true, message, delivered: 0, queued: true };
    }
    return { ok: false, error: 'Could not reach them.', message, delivered: 0 };
  }

  /** Tell the sender of an urgent message that we have seen it. */
  ackUrgent(messageId: string): void {
    const store = this.store;
    const me = this.state.me;
    if (!store || !me) return;

    const message = store.messages().find((m) => m.id === messageId);
    if (!message) return;

    const ack: UrgentAck = { messageId, by: me.id, byName: me.name, ts: Date.now() };
    store.addAck(ack);

    const peer = this.presence.get(message.from);
    if (peer) void this.deliver(peer, { type: 'urgent-ack', ack });
  }
}
