/**
 * Types crossing the main <-> renderer boundary. Both sides import from here so
 * the preload surface cannot drift away from what the renderer expects.
 */
import { URGENT_THEMES, type UrgentTheme } from './protocol.js';
import type { ChatMessage, SendPayload, SendResult, UrgentAck, User } from './protocol.js';

export { URGENT_THEMES };
export type { UrgentTheme };

/** Presentation metadata for the picker; the themes themselves live in the protocol. */
export interface UrgentThemeInfo {
  name: string;
  note: string;
  /** [background, mid, accent] - drives the picker swatches. */
  swatch: [string, string, string];
  /** Painted behind the window before first paint, to avoid a flash. */
  background: string;
}

export const URGENT_THEME_INFO: Record<UrgentTheme, UrgentThemeInfo> = {
  signal: {
    name: 'Signal',
    note: 'Matches the app. Dark, minimal, one neon accent.',
    swatch: ['#0a0f14', '#132029', '#2de1a3'],
    background: '#0a0f14',
  },
  constructivist: {
    name: 'Constructivist',
    note: 'Cream paper, red diagonal, poster type.',
    swatch: ['#f0e9da', '#d92b1c', '#14110e'],
    background: '#f0e9da',
  },
  terminal: {
    name: 'Terminal',
    note: 'Monospace, hairlines, no decoration.',
    swatch: ['#080b0e', '#1b2730', '#2de1a3'],
    background: '#080b0e',
  },
  panel: {
    name: 'Panel',
    note: 'Hazard stripes and a warning lamp.',
    swatch: ['#141210', '#f5a524', '#ff3b18'],
    background: '#141210',
  },
  phosphor: {
    name: 'Phosphor',
    note: 'CRT scanlines and green glow.',
    swatch: ['#030603', '#0b1a0f', '#46ff8c'],
    background: '#030603',
  },
};

export interface Settings {
  /** Stable identity for this installation. Generated once, never changes. */
  deviceId: string;
  displayName: string;
  /** The look YOUR urgent messages wear on everyone else's screen. */
  urgentTheme: UrgentTheme;
  soundEnabled: boolean;
  launchAtLogin: boolean;
  /** Show the chat window on launch instead of starting silently in the tray. */
  showWindowOnLaunch: boolean;
}

/** There is no server to connect to, so this describes our own readiness. */
export type ConnectionStatus = 'starting' | 'online' | 'error';

export interface NetState {
  status: ConnectionStatus;
  error: string | null;
  me: User | null;
  /** Our LAN address and listening port, shown for troubleshooting. */
  address: string | null;
  port: number | null;
  /** Everyone we know about; `online` means visible on the network right now. */
  users: User[];
}

export interface Snapshot {
  settings: Settings;
  state: NetState;
  /** Messages already on disk, so a newly opened window is not blank. */
  history: ChatMessage[];
  acks: UrgentAck[];
}

export interface UrgentQueuePayload {
  queue: ChatMessage[];
  soundEnabled: boolean;
}

export type InboundChannel =
  | 'state'
  | 'settings'
  | 'chat:message'
  | 'chat:history'
  | 'chat:urgent-acked'
  | 'urgent:queue';

export interface RendererApi {
  getSnapshot(): Promise<Snapshot>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;

  send(payload: SendPayload): Promise<SendResult>;
  /** Re-announce ourselves and re-scan the network. */
  refresh(): Promise<void>;

  getUrgentQueue(): Promise<ChatMessage[]>;
  /** Raises a fake alert so your own theme can be judged on a real screen. */
  previewUrgent(): Promise<void>;
  acknowledgeUrgent(messageId: string): Promise<void>;
  dismissUrgent(messageId: string): Promise<void>;

  hideWindow(): Promise<void>;
  quit(): Promise<void>;

  on<T = unknown>(channel: InboundChannel, listener: (payload: T) => void): () => void;
}

export type { ChatMessage, SendPayload, SendResult, UrgentAck, User };
