import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

import { URGENT_THEMES, type Settings } from '../shared/ipc.js';

export type { Settings };

/**
 * Reads a JSON file, tolerating a UTF-8 BOM. Windows editors (Notepad,
 * PowerShell's Set-Content) add one, and JSON.parse throws on it - which would
 * otherwise silently reset the user's identity to a fresh deviceId.
 */
function readJson(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function defaults(): Settings {
  return {
    deviceId: randomUUID(),
    displayName: os.userInfo().username || 'Anonymous',
    urgentTheme: 'signal',
    soundEnabled: true,
    launchAtLogin: false,
    showWindowOnLaunch: true,
  };
}

/**
 * Tiny JSON-file settings store in userData. Deliberately dependency-free -
 * we only ever hold a dozen scalar values.
 */
class SettingsStore {
  private file = join(app.getPath('userData'), 'settings.json');
  private data: Settings;

  constructor() {
    this.data = this.load();
  }

  private load(): Settings {
    try {
      const raw = JSON.parse(readJson(this.file)) as Partial<Settings>;
      // Merge over defaults so a settings file written by an older version still loads.
      const merged = { ...defaults(), ...raw };
      if (!merged.deviceId) merged.deviceId = randomUUID();
      // A theme removed in a later version must not leave the alert unstyled.
      if (!URGENT_THEMES.includes(merged.urgentTheme)) merged.urgentTheme = 'signal';
      return merged;
    } catch {
      const fresh = defaults();
      this.persist(fresh);
      return fresh;
    }
  }

  private persist(data: Settings): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Write-then-rename so a crash mid-write cannot truncate the real file.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('[settings] save failed:', err);
    }
  }

  get all(): Settings {
    return { ...this.data };
  }

  update(patch: Partial<Settings>): Settings {
    // deviceId is identity - never let the renderer overwrite it.
    const { deviceId: _ignored, ...safe } = patch;
    this.data = { ...this.data, ...safe };
    this.persist(this.data);
    return this.all;
  }
}

let instance: SettingsStore | null = null;

export function settings(): SettingsStore {
  if (!instance) instance = new SettingsStore();
  return instance;
}

/** Reflects the launchAtLogin preference into the OS. */
export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return; // dev runs would register the electron binary itself
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Start straight into the tray on a login launch. Windows and Linux take a
    // command-line flag; macOS has its own switch for the same idea.
    args: ['--hidden'],
    openAsHidden: true,
  });
}
