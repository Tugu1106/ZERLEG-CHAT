import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';

import { settings, applyLaunchAtLogin } from './settings.js';
import type { NetState } from '../shared/ipc.js';

const IS_MAC = process.platform === 'darwin';

function resourcePath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, file)
    : join(__dirname, '../../resources', file);
}

export interface TrayActions {
  onOpen: () => void;
  onRefresh: () => void;
  onQuit: () => void;
  onSettingsChanged: () => void;
}

const STATUS_LABEL: Record<NetState['status'], string> = {
  starting: 'Starting...',
  online: 'On the network',
  error: 'Network problem',
};

/**
 * The tray icon is the app's real home - the window is just a viewer that comes
 * and goes, so status has to be legible from here.
 */
export class TrayController {
  private tray: Tray | null = null;
  private state: NetState | null = null;
  /** True while an urgent alert is on screen and unacknowledged. */
  private alerting = false;

  constructor(private readonly actions: TrayActions) {}

  /**
   * Three states, because the tray is the app's most-visible surface. On macOS
   * the normal states are template images so they invert with the menu bar;
   * the alert state stays coloured on purpose, so it stands out up there.
   */
  private icon(live: boolean): Electron.NativeImage {
    if (this.alerting) return nativeImage.createFromPath(resourcePath('tray-alert.png'));

    if (IS_MAC) {
      const file = live ? 'trayTemplate.png' : 'trayOfflineTemplate.png';
      const image = nativeImage.createFromPath(resourcePath(file));
      image.setTemplateImage(true);
      return image;
    }
    return nativeImage.createFromPath(resourcePath(live ? 'tray.png' : 'tray-offline.png'));
  }

  create(): void {
    this.tray = new Tray(this.icon(false));
    this.tray.setToolTip('Zerleg Chat');
    this.tray.on('click', () => this.actions.onOpen());
    this.tray.on('double-click', () => this.actions.onOpen());
    this.render();
  }

  update(state: NetState): void {
    this.state = state;
    this.render();
  }

  /** Switches the tray to the attention icon while an alert is unacknowledged. */
  setAlerting(alerting: boolean): void {
    if (this.alerting === alerting) return;
    this.alerting = alerting;
    this.render();
  }

  private render(): void {
    const tray = this.tray;
    if (!tray) return;

    const config = settings().all;
    const state = this.state;
    const live = state?.status === 'online';
    const online = state?.users.filter((u) => u.online).length ?? 0;

    tray.setImage(this.icon(live));

    const peopleLine = live
      ? online === 0
        ? 'Nobody else online yet'
        : `${online} ${online === 1 ? 'person' : 'people'} online`
      : (state?.error ?? 'Starting up');

    tray.setToolTip(
      this.alerting
        ? 'Zerleg Chat - URGENT MESSAGE WAITING'
        : `Zerleg Chat - ${live ? peopleLine : STATUS_LABEL[state?.status ?? 'starting']}`,
    );

    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `You are ${config.displayName}`, enabled: false },
        { label: this.alerting ? 'URGENT MESSAGE WAITING' : peopleLine, enabled: false },
        { type: 'separator' },
        { label: 'Open chat', click: () => this.actions.onOpen() },
        { label: 'Re-scan the network', click: () => this.actions.onRefresh() },
        { type: 'separator' },
        {
          label: 'Alert sound',
          type: 'checkbox',
          checked: config.soundEnabled,
          click: (item) => {
            settings().update({ soundEnabled: item.checked });
            this.actions.onSettingsChanged();
            this.render();
          },
        },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: config.launchAtLogin,
          click: (item) => {
            settings().update({ launchAtLogin: item.checked });
            applyLaunchAtLogin(item.checked);
            this.actions.onSettingsChanged();
            this.render();
          },
        },
        { type: 'separator' },
        { label: 'Quit Zerleg Chat', click: () => this.actions.onQuit() },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
