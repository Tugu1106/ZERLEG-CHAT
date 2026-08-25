import { app, BrowserWindow, screen, shell } from 'electron';

/**
 * macOS needs different handling in two places: native fullscreen moves a window
 * into its own Space (animating away from whatever the user is looking at, which
 * is the opposite of what an alert wants), and flashFrame does nothing there.
 */
const IS_MAC = process.platform === 'darwin';

import { randomUUID } from 'node:crypto';

import { settings } from './settings.js';
import { loadRendererPage, preloadPath } from './windows.js';
import { URGENT_THEME_INFO } from '../shared/ipc.js';
import { coerceTheme, type ChatMessage } from '../shared/protocol.js';

/**
 * Owns the fullscreen urgent alert.
 *
 * There is at most one alert window; if more urgent messages land while it is up
 * they join a queue and the window steps through them, so a burst of alerts can
 * never bury each other or spawn a dozen fullscreen windows.
 */
export class UrgentAlerts {
  private win: BrowserWindow | null = null;
  private queue: ChatMessage[] = [];
  /** Guards the close handler so only our own code can actually close the window. */
  private allowClose = false;
  /** Bounds of the display the alert was raised on, for the fullscreen fallback. */
  private displayBounds: Electron.Rectangle | null = null;
  /** Set while showing a preview, so acknowledging it tells nobody. */
  private previewIds = new Set<string>();

  constructor(
    private readonly onAcknowledge: (messageId: string) => void,
    /** Fired whenever the queue goes from empty to busy, or back. */
    private readonly onActiveChange: (active: boolean) => void = () => {},
  ) {}

  /** Raise (or add to) the fullscreen alert for an incoming urgent message. */
  raise(message: ChatMessage): void {
    // A sender re-delivers unacknowledged alerts when we reappear, so ignore repeats.
    if (this.queue.some((m) => m.id === message.id)) {
      this.bringToFront();
      return;
    }
    this.queue.push(message);
    this.onActiveChange(true);

    if (this.isAlive()) {
      this.pushQueue();
      this.bringToFront();
      return;
    }
    this.createWindow();
  }

  /**
   * Shows a sample alert so the theme picker can be judged full screen. It is
   * never sent anywhere and acknowledging it notifies nobody.
   */
  preview(): void {
    const id = `preview-${randomUUID()}`;
    this.previewIds.add(id);
    this.raise({
      id,
      from: 'preview',
      fromName: settings().all.displayName,
      to: 'all',
      body: 'COME TO THE MEETING ROOM',
      urgent: true,
      ts: Date.now(),
      theme: settings().all.urgentTheme,
    });
  }

  /** Called from the alert window's ACKNOWLEDGE button. */
  acknowledge(messageId: string): void {
    if (this.previewIds.has(messageId)) {
      this.previewIds.delete(messageId);
    } else {
      this.onAcknowledge(messageId);
    }
    this.dismiss(messageId);
  }

  /** Drops a message from the queue without telling the server it was seen. */
  dismiss(messageId: string): void {
    this.queue = this.queue.filter((m) => m.id !== messageId);
    if (this.queue.length === 0) {
      this.onActiveChange(false);
      this.closeWindow();
      return;
    }
    this.pushQueue();
  }

  /** The renderer asks for this on load, since it may mount after we sent the queue. */
  getQueue(): ChatMessage[] {
    return [...this.queue];
  }

  isShowing(): boolean {
    return this.isAlive();
  }

  private isAlive(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  private createWindow(): void {
    // Put the alert on whichever display the user is actually looking at.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.bounds;

    this.displayBounds = display.bounds;

    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: false,
      frame: false,
      // "Simple" fullscreen on macOS covers the current Space instantly instead
      // of sliding the alert off to a new one.
      fullscreen: !IS_MAC,
      simpleFullscreen: IS_MAC,
      fullscreenable: true,
      alwaysOnTop: true,
      // Windows refuses to put a non-resizable window into real fullscreen - it
      // silently maximizes instead, leaving the taskbar on top of the alert.
      resizable: true,
      movable: false,
      minimizable: false,
      maximizable: true,
      skipTaskbar: false,
      autoHideMenuBar: true,
      // Match the incoming sender's theme, so there is no colour flash before
      // first paint.
      backgroundColor: URGENT_THEME_INFO[coerceTheme(this.queue[0]?.theme)].background,
      title: 'URGENT MESSAGE',
      webPreferences: {
        preload: preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Above other always-on-top windows, and present on every virtual desktop.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // An urgent alert that Alt+F4 can flick away is not an urgent alert. Only
    // our own acknowledge/dismiss paths are allowed to close it.
    win.on('close', (event) => {
      if (this.allowClose) return;
      event.preventDefault();
    });

    win.on('closed', () => {
      this.win = null;
      this.allowClose = false;
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    win.once('ready-to-show', () => {
      this.pushQueue();
      this.bringToFront();
    });

    this.win = win;
    loadRendererPage(win, 'urgent');
  }

  /** Everything Windows/macOS need to actually surface a window from the background. */
  private bringToFront(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;

    if (win.isMinimized()) win.restore();
    win.setAlwaysOnTop(true, 'screen-saver');

    if (IS_MAC) {
      if (!win.isSimpleFullScreen()) win.setSimpleFullScreen(true);
    } else if (!win.isFullScreen()) {
      win.setFullScreen(true);
    }

    win.show();
    win.moveTop();
    win.focus();
    // Focus stealing is normally suppressed for background apps; for an alert
    // this is exactly the behaviour we want.
    app.focus({ steal: true });

    if (IS_MAC) {
      // flashFrame is a no-op on macOS; bouncing the dock is the equivalent.
      app.dock?.bounce('critical');
    } else {
      win.flashFrame(true);
    }

    // Belt and braces: if the window manager declined fullscreen, cover the
    // display manually so the alert can never end up behind the taskbar.
    setTimeout(() => this.ensureCoversScreen(), 120);

    if (settings().all.soundEnabled) {
      // The renderer plays the real siren; this is a belt-and-braces OS beep for
      // the moment before audio starts.
      shell.beep();
    }
  }

  /**
   * Fullscreen can be refused (or silently downgraded to "maximized") depending
   * on the window manager. If the window is not actually covering the display,
   * force its bounds to the full screen rect instead.
   */
  private ensureCoversScreen(): void {
    const win = this.win;
    const target = this.displayBounds;
    if (!win || win.isDestroyed() || !target) return;

    const actual = win.getBounds();
    const covers = actual.width >= target.width && actual.height >= target.height;
    if (covers) return;

    win.setBounds(target);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }

  private pushQueue(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    // No theme here: each message carries its sender's own, so the window
    // restyles itself as you step through a queue from different people.
    win.webContents.send('urgent:queue', {
      queue: this.queue,
      soundEnabled: settings().all.soundEnabled,
    });
  }

  private closeWindow(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) {
      this.win = null;
      return;
    }
    this.allowClose = true;
    if (IS_MAC) {
      if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false);
    } else {
      win.flashFrame(false);
    }
    win.close();
    this.win = null;
  }
}
