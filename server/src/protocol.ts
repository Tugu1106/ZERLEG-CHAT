/**
 * LAN Urgent Chat - wire protocol.
 *
 * This file is duplicated verbatim at desktop/src/shared/protocol.ts so that the
 * server and the desktop app can be installed/built independently. If you change
 * one, run `npm run sync:protocol` (see scripts/sync-protocol.mjs) to update the other.
 */

export const PROTOCOL_VERSION = 1;

/** TCP port the Socket.IO/HTTP server listens on. */
export const DEFAULT_SERVER_PORT = 41890;
/** UDP port used for zero-config LAN discovery. */
export const DISCOVERY_PORT = 41891;
/** Guards our UDP packets against unrelated broadcast traffic. */
export const DISCOVERY_MAGIC = 'LAN-URGENT-CHAT';

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_NAME_LENGTH = 32;

/** Conversation target meaning "everyone on the server". */
export const BROADCAST_TARGET = 'all';

export type UserId = string;
export type Target = UserId | typeof BROADCAST_TARGET;

export interface User {
  id: UserId;
  name: string;
  online: boolean;
  lastSeen: number;
}

export interface ChatMessage {
  id: string;
  from: UserId;
  fromName: string;
  to: Target;
  body: string;
  urgent: boolean;
  ts: number;
}

export interface UrgentAck {
  messageId: string;
  by: UserId;
  byName: string;
  ts: number;
}

export interface LoginPayload {
  /** Stable per-installation id, generated once and persisted by the client. */
  deviceId: string;
  name: string;
  protocolVersion: number;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  user?: User;
  serverName?: string;
  protocolVersion?: number;
}

export interface SendPayload {
  to: Target;
  body: string;
  urgent: boolean;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  message?: ChatMessage;
}

/** Shape of the UDP announce packet a server replies with, and of `GET /health`. */
export interface ServerInfo {
  magic: typeof DISCOVERY_MAGIC;
  type: 'announce';
  protocolVersion: number;
  name: string;
  port: number;
  onlineUsers: number;
}

export interface ServerToClientEvents {
  users: (users: User[]) => void;
  history: (messages: ChatMessage[]) => void;
  message: (message: ChatMessage) => void;
  /** Only ever sent to *recipients* - this is what triggers the fullscreen window. */
  urgent: (message: ChatMessage) => void;
  'urgent:acked': (ack: UrgentAck) => void;
}

export interface ClientToServerEvents {
  login: (payload: LoginPayload, cb: (result: LoginResult) => void) => void;
  'message:send': (payload: SendPayload, cb: (result: SendResult) => void) => void;
  'urgent:ack': (payload: { messageId: string }) => void;
}

/** Trims and clamps a user-supplied display name. */
export function sanitizeName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name || 'Anonymous';
}

/** Trims and clamps a message body. Returns '' for messages that are only whitespace. */
export function sanitizeBody(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
}
