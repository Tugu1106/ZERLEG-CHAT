import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

export type RendererPage = 'index' | 'urgent';

export const preloadPath = join(__dirname, '../preload/index.js');

/**
 * In dev, electron-vite serves the renderer from a dev server and exposes its
 * URL; in a packaged build we load the built HTML off disk.
 */
export function loadRendererPage(win: BrowserWindow, page: RendererPage): void {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) {
    void win.loadURL(`${devServer}/${page}.html`);
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}.html`));
  }
}

let mainWindow: BrowserWindow | null = null;
/** Set during app quit so the close handler stops hiding the window instead. */
let quitting = false;

export function setQuitting(value: boolean): void {
  quitting = value;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function createMainWindow(show: boolean): BrowserWindow {
  const existing = getMainWindow();
  if (existing) {
    if (show) revealMainWindow();
    return existing;
  }

  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 780,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f17',
    title: 'Zerleg Chat',
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    if (show) win.show();
  });

  // Closing the window only hides it - the app keeps running in the tray so
  // urgent messages still get through. Real exit goes through the tray menu.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  // Keep external links out of the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  loadRendererPage(win, 'index');
  mainWindow = win;
  return win;
}

export function revealMainWindow(): void {
  const win = getMainWindow() ?? createMainWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function toggleMainWindow(): void {
  const win = getMainWindow();
  if (win && win.isVisible() && !win.isMinimized()) {
    win.hide();
    return;
  }
  revealMainWindow();
}
