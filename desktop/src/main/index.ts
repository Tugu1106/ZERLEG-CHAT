import { app, BrowserWindow, ipcMain, Notification } from 'electron';

import { PeerNode } from './peer.js';
import { applyLaunchAtLogin, settings, type Settings } from './settings.js';
import { TrayController } from './tray.js';
import { UrgentAlerts } from './urgent.js';
import {
  createMainWindow,
  getMainWindow,
  revealMainWindow,
  setQuitting,
  toggleMainWindow,
} from './windows.js';
import type { ChatMessage, SendPayload, UrgentAck } from '../shared/protocol.js';

/**
 * `--profile <name>` gives this instance its own settings/history directory, so
 * two copies can run on one machine (which is how you test peer-to-peer without
 * a second computer). Without it, a second launch just surfaces the first.
 */
const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex === -1 ? null : process.argv[profileIndex + 1];

if (profile) {
  app.setPath('userData', `${app.getPath('userData')}-${profile}`);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const startHidden = process.argv.includes('--hidden');

let node: PeerNode;
let tray: TrayController;
let alerts: UrgentAlerts;

/** Pushes an event to the chat window if it currently exists. */
function toChatWindow(channel: string, payload?: unknown): void {
  const win = getMainWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function quit(): void {
  setQuitting(true);
  node?.stop();
  tray?.destroy();
  app.quit();
}

function registerIpc(): void {
  ipcMain.handle('app:getSnapshot', () => ({
    settings: settings().all,
    state: node.getState(),
    history: node.getHistory(),
    acks: node.getAcks(),
  }));

  ipcMain.handle('app:setSettings', (_event, patch: Partial<Settings>) => {
    const before = settings().all;
    const after = settings().update(patch);

    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin) {
      applyLaunchAtLogin(after.launchAtLogin);
    }
    // A new display name has to go back out over the network.
    if (after.displayName !== before.displayName) node.updateIdentity();

    toChatWindow('settings', after);
    tray.update(node.getState());
    return after;
  });

  ipcMain.handle('chat:send', (_event, payload: SendPayload) => node.send(payload));
  ipcMain.handle('chat:refresh', () => node.updateIdentity());

  ipcMain.handle('urgent:getQueue', () => alerts.getQueue());
  ipcMain.handle('urgent:preview', () => alerts.preview());
  ipcMain.handle('urgent:acknowledge', (_event, messageId: string) => {
    alerts.acknowledge(messageId);
  });
  ipcMain.handle('urgent:dismiss', (_event, messageId: string) => {
    alerts.dismiss(messageId);
  });

  ipcMain.handle('peers:forget', (_event, id: string) => node.forgetPeer(id));

  ipcMain.handle('window:hide', () => getMainWindow()?.hide());
  ipcMain.handle('app:quit', () => quit());
}

function wireNetwork(): void {
  node.on('state', (state) => {
    tray.update(state);
    toChatWindow('state', state);
  });

  node.on('urgent:acked', (ack: UrgentAck) => toChatWindow('chat:urgent-acked', ack));

  node.on('message', (message: ChatMessage) => {
    toChatWindow('chat:message', message);

    // Quiet nudge for normal messages that arrive while we are out of sight.
    const win = getMainWindow();
    const hidden = !win || !win.isVisible() || win.isMinimized();
    const fromSomeoneElse = message.from !== node.getState().me?.id;
    if (!message.urgent && hidden && fromSomeoneElse && Notification.isSupported()) {
      const notification = new Notification({
        title: message.fromName,
        body: message.body.slice(0, 180),
        silent: !settings().all.soundEnabled,
      });
      notification.on('click', () => revealMainWindow());
      notification.show();
    }
  });

  // The whole point of the app.
  node.on('urgent', (message: ChatMessage) => alerts.raise(message));
}

app.on('second-instance', () => revealMainWindow());

// Closing every window must not quit - we live in the tray.
app.on('window-all-closed', () => {
  /* intentionally empty */
});

/*
 * macOS: clicking the dock icon must bring the chat back. Our window is hidden
 * rather than destroyed when closed, so the usual "create one if none exist"
 * check would find a window and do nothing.
 */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow(true);
  else revealMainWindow();
});

app.on('before-quit', () => {
  setQuitting(true);
  // Say goodbye so peers drop us immediately instead of waiting for a timeout.
  node?.stop();
});

void app.whenReady().then(async () => {
  app.setAppUserModelId('com.zerleg.app');

  const config = settings().all;
  applyLaunchAtLogin(config.launchAtLogin);

  node = new PeerNode();
  alerts = new UrgentAlerts(
    (messageId) => node.ackUrgent(messageId),
    (active) => tray.setAlerting(active),
  );
  tray = new TrayController({
    onOpen: () => toggleMainWindow(),
    onRefresh: () => node.updateIdentity(),
    onQuit: () => quit(),
    onSettingsChanged: () => toChatWindow('settings', settings().all),
  });

  registerIpc();
  wireNetwork();
  tray.create();

  createMainWindow(config.showWindowOnLaunch && !startHidden);
  await node.start();
});
