import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** Events the main process is allowed to push at a renderer. */
const INBOUND_CHANNELS = [
  'state',
  'settings',
  'chat:message',
  'chat:history',
  'chat:urgent-acked',
  'urgent:queue',
] as const;

export type InboundChannel = (typeof INBOUND_CHANNELS)[number];

const api = {
  getSnapshot: () => ipcRenderer.invoke('app:getSnapshot'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('app:setSettings', patch),

  send: (payload: unknown) => ipcRenderer.invoke('chat:send', payload),
  refresh: () => ipcRenderer.invoke('chat:refresh'),

  getUrgentQueue: () => ipcRenderer.invoke('urgent:getQueue'),
  previewUrgent: () => ipcRenderer.invoke('urgent:preview'),
  acknowledgeUrgent: (messageId: string) => ipcRenderer.invoke('urgent:acknowledge', messageId),
  dismissUrgent: (messageId: string) => ipcRenderer.invoke('urgent:dismiss', messageId),

  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),

  /** Subscribe to a main-process event. Returns an unsubscribe function. */
  on: (channel: InboundChannel, listener: (payload: unknown) => void): (() => void) => {
    if (!INBOUND_CHANNELS.includes(channel)) {
      throw new Error(`Refusing to listen on unknown channel: ${channel}`);
    }
    const handler = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type PreloadApi = typeof api;
