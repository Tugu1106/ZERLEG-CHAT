/**
 * ZERLEG - peer-to-peer wire protocol.
 *
 * There is no server. Every app instance is a peer that:
 *   1. announces itself over UDP (multicast + broadcast) so others can find it,
 *   2. listens on a TCP port so others can deliver messages straight to it.
 *
 * Messages therefore travel sender -> recipient with nothing in between.
 */

export const PROTOCOL_VERSION = 2;

/** UDP port every peer listens on for presence announcements. */
export const DISCOVERY_PORT = 41891;
/**
 * Admin-scoped multicast group. Multicast (rather than broadcast alone) is what
 * lets several instances on ONE machine all receive announcements, which plain
 * unicast cannot do - the same trick mDNS/Bonjour uses.
 */
export const MULTICAST_ADDRESS = '239.255.41.89';
/** Preferred TCP port for incoming messages; falls back to an ephemeral one. */
export const PREFERRED_TCP_PORT = 41890;
/** Guards our packets against unrelated broadcast traffic. */
export const DISCOVERY_MAGIC = 'LAN-URGENT-CHAT';

/** How often each peer re-announces itself. */
export const HEARTBEAT_MS = 5_000;
/** A peer that has not been heard from for this long is considered offline. */
export const PEER_TIMEOUT_MS = 16_000;
/** Give up on a single TCP delivery attempt after this long. */
export const DELIVERY_TIMEOUT_MS = 6_000;

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_NAME_LENGTH = 32;
/** Refuse absurd TCP frames rather than buffering them forever. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** Conversation target meaning "everyone I can currently see". */
export const BROADCAST_TARGET = 'all';

export type UserId = string;
export type Target = UserId | typeof BROADCAST_TARGET;

/**
 * Look of the fullscreen alert. The *sender* picks this, and it rides along on
 * the message - so an alert from Bataa looks like Bataa's alert on every screen
 * it lands on. Lives in the protocol because it crosses the network.
 */
export const URGENT_THEMES = ['signal', 'constructivist', 'terminal', 'panel', 'phosphor'] as const;

export type UrgentTheme = (typeof URGENT_THEMES)[number];

export const DEFAULT_URGENT_THEME: UrgentTheme = 'signal';

/** Falls back to the default for anything unrecognised off the wire. */
export function coerceTheme(value: unknown): UrgentTheme {
  return URGENT_THEMES.includes(value as UrgentTheme) ? (value as UrgentTheme) : DEFAULT_URGENT_THEME;
}

export interface User {
  id: UserId;
  name: string;
  online: boolean;
  lastSeen: number;
  /** When this peer was first seen. Absent for entries saved before v1.1. */
  firstSeen?: number;
  /** Where we currently reach them. Only set while they are online. */
  address?: string;
  port?: number;
}

export interface ChatMessage {
  id: string;
  from: UserId;
  fromName: string;
  to: Target;
  body: string;
  urgent: boolean;
  ts: number;
  /** Only set on urgent messages: the look the sender chose. */
  theme?: UrgentTheme;
}

export interface UrgentAck {
  messageId: string;
  by: UserId;
  byName: string;
  ts: number;
}

// ------------------------------------------------------------------ discovery

/** What a peer shouts over UDP so others can find it. */
export interface Announce {
  magic: typeof DISCOVERY_MAGIC;
  protocolVersion: number;
  /** `hello` = I am here (also used as a heartbeat); `bye` = I am leaving. */
  type: 'hello' | 'bye';
  id: UserId;
  name: string;
  /** TCP port this peer accepts messages on. */
  port: number;
  ts: number;
}

// ------------------------------------------------------------------ transport

/** Frames exchanged over a direct TCP connection, one JSON object per line. */
export type Frame =
  | { type: 'message'; message: ChatMessage }
  | { type: 'urgent-ack'; ack: UrgentAck }
  | { type: 'ok'; id?: string }
  | { type: 'error'; error: string };

export interface SendPayload {
  to: Target;
  body: string;
  urgent: boolean;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  message?: ChatMessage;
  /** How many peers actually received it. */
  delivered?: number;
  /** True when the recipient was offline and the message is waiting to be sent. */
  queued?: boolean;
}

/** Trims and clamps a user-supplied display name. */
export function sanitizeName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name || 'Anonymous';
}

/** Trims and clamps a message body. Returns '' for whitespace-only messages. */
export function sanitizeBody(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
}

/** Rejects anything that is not a plausible chat message from the network. */
export function isValidMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    m.id.length > 0 &&
    m.id.length <= 64 &&
    typeof m.from === 'string' &&
    typeof m.fromName === 'string' &&
    typeof m.to === 'string' &&
    typeof m.body === 'string' &&
    typeof m.urgent === 'boolean' &&
    typeof m.ts === 'number' &&
    Number.isFinite(m.ts)
  );
}
