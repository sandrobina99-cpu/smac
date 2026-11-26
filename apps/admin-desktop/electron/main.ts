import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { registerUpdater } from './updater';

export interface DesktopAppConfig {
  serverUrl: string;
  theme: 'system' | 'light' | 'dark';
  lastUsername?: string;
}

const DEFAULT_CONFIG: DesktopAppConfig = {
  serverUrl: 'https://hub.sandrobina.me',
  theme: 'system',
  lastUsername: 'admin',
};

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'admin-config.json');
}

function readConfig(): DesktopAppConfig {
  try {
    const file = getConfigPath();
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DesktopAppConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(patch: Partial<DesktopAppConfig>): DesktopAppConfig {
  const next = { ...readConfig(), ...patch };
  const file = getConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    title: 'smac 管理端',
    icon: path.join(__dirname, '../build/icon.png'),
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl).catch((err) => {
      console.error('Failed to load dev URL:', err);
    });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html')).catch((err) => {
      console.error('Failed to load index.html:', err);
    });
  }
}

app.whenReady().then(() => {
  ipcMain.handle('config:get', () => readConfig());
  ipcMain.handle('config:set', (_event, patch: Partial<DesktopAppConfig>) =>
    writeConfig(patch || {}),
  );
  ipcMain.handle('clipboard:writeText', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }));

  registerUpdater(ipcMain, 'admin', () => BrowserWindow.getAllWindows()[0]?.webContents);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
