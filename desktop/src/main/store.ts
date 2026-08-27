import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ChatMessage, UrgentAck, User, UserId } from '../shared/protocol.js';

/** Keep the on-disk history bounded; this is a chat app, not an archive. */
const MAX_MESSAGES = 5000;

interface PendingDelivery {
  to: UserId;
  message: ChatMessage;
  /** Stop retrying eventually so a queue cannot grow forever. */
  expiresAt: number;
}

interface Data {
  messages: ChatMessage[];
  /** Everyone we have ever seen, so offline people still appear in the list. */
  knownPeers: Record<UserId, { name: string; lastSeen: number; firstSeen?: number }>;
  /** Acknowledgements for urgent messages we sent. */
  acks: UrgentAck[];
  /** Urgent messages waiting for a recipient to come back online. */
  pending: PendingDelivery[];
}

const empty = (): Data => ({ messages: [], knownPeers: {}, acks: [], pending: [] });

/**
 * Local, per-machine persistence.
 *
 * With no server there is nowhere central to keep anything, so each app stores
 * its own copy of what it has seen. A plain JSON file avoids pulling a native
 * SQLite binding into the Electron build for what is a few thousand rows.
 */
export class Store {
  private file: string;
  private data: Data;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(fileName = 'history.json') {
    this.file = join(app.getPath('userData'), fileName);
    this.data = this.load();
  }

  private load(): Data {
    try {
      // Tolerate a UTF-8 BOM; Windows editors add one and JSON.parse rejects it.
      const text = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(
        text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
      ) as Partial<Data>;
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        knownPeers: parsed.knownPeers ?? {},
        acks: Array.isArray(parsed.acks) ? parsed.acks : [],
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      };
    } catch {
      return empty(); // first run, or a corrupt file we should not die on
    }
  }

  /** Debounced so a burst of messages costs one write. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 400);
  }

  saveNow(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      renameSync(tmp, this.file); // atomic-ish: never truncate the real file
    } catch (err) {
      console.error('[store] save failed:', err);
    }
  }

  // ------------------------------------------------------------------ messages

  /** Returns false if we already had this message (duplicate delivery). */
  addMessage(message: ChatMessage): boolean {
    if (this.data.messages.some((m) => m.id === message.id)) return false;
    this.data.messages.push(message);
    this.data.messages.sort((a, b) => a.ts - b.ts);
    if (this.data.messages.length > MAX_MESSAGES) {
      this.data.messages = this.data.messages.slice(-MAX_MESSAGES);
    }
    this.scheduleSave();
    return true;
  }

  messages(): ChatMessage[] {
    return [...this.data.messages];
  }

  hasMessage(id: string): boolean {
    return this.data.messages.some((m) => m.id === id);
  }

  // --------------------------------------------------------------------- peers

  rememberPeer(id: UserId, name: string): void {
    const existing = this.data.knownPeers[id];
    this.data.knownPeers[id] = {
      name,
      lastSeen: Date.now(),
      // Keep the original sighting; it is the useful half of "who is this?".
      firstSeen: existing?.firstSeen ?? Date.now(),
    };
    this.scheduleSave();
  }

  /**
   * Drops a peer and everything tied to them. Someone still on the network will
   * reappear within a heartbeat - this is for clearing out stale entries.
   */
  forgetPeer(id: UserId): void {
    delete this.data.knownPeers[id];
    this.data.messages = this.data.messages.filter((m) => m.from !== id && m.to !== id);
    this.data.acks = this.data.acks.filter((a) => a.by !== id);
    this.data.pending = this.data.pending.filter((p) => p.to !== id);
    this.saveNow();
  }

  /** Everyone ever seen; entries in `live` are marked online and carry an address. */
  users(live: Map<UserId, { name: string; address: string; port: number }>): User[] {
    const all = new Map<UserId, User>();

    for (const [id, info] of Object.entries(this.data.knownPeers)) {
      all.set(id, {
        id,
        name: info.name,
        online: false,
        lastSeen: info.lastSeen,
        firstSeen: info.firstSeen,
      });
    }
    // Live data wins: someone may have renamed or moved since we last saw them.
    for (const [id, peer] of live) {
      const known = all.get(id);
      all.set(id, {
        id,
        name: peer.name || known?.name || 'Unknown',
        online: true,
        lastSeen: Date.now(),
        firstSeen: known?.firstSeen,
        address: peer.address,
        port: peer.port,
      });
    }

    return [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------------- acks

  addAck(ack: UrgentAck): boolean {
    if (this.data.acks.some((a) => a.messageId === ack.messageId && a.by === ack.by)) return false;
    this.data.acks.push(ack);
    this.scheduleSave();
    return true;
  }

  acks(): UrgentAck[] {
    return [...this.data.acks];
  }

  // ------------------------------------------------------------------- pending

  queuePending(to: UserId, message: ChatMessage, ttlMs: number): void {
    if (this.data.pending.some((p) => p.to === to && p.message.id === message.id)) return;
    this.data.pending.push({ to, message, expiresAt: Date.now() + ttlMs });
    this.scheduleSave();
  }

  /** Undelivered messages for a peer, dropping any that have expired. */
  takePendingFor(to: UserId): ChatMessage[] {
    const now = Date.now();
    const mine = this.data.pending.filter((p) => p.to === to && p.expiresAt > now);
    this.data.pending = this.data.pending.filter((p) => p.to !== to && p.expiresAt > now);
    this.scheduleSave();
    return mine.map((p) => p.message);
  }

  pendingCountFor(to: UserId): number {
    const now = Date.now();
    return this.data.pending.filter((p) => p.to === to && p.expiresAt > now).length;
  }

  clear(): void {
    this.data = empty();
    this.saveNow();
  }
}
