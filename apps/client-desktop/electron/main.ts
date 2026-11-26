import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { applyAgent, detectAgents, restoreAgent, revealAgentConfig, type ApplyInput } from './agents';
import {
  connectLocalToAdminNode,
  connectLocalToHost,
  disconnectLocalFromHost,
  getGuestLocalStatus,
  type AdminNodePayload,
  type HostBindingPayload,
} from './guest-bridge';
import { registerUpdater } from './updater';

export interface ClientDesktopConfig {
  serverUrl: string;
  theme: 'system' | 'light' | 'dark';
  lastUsername?: string;
}

const DEFAULT_CONFIG: ClientDesktopConfig = {
  serverUrl: 'https://hub.sandrobina.me',
  theme: 'dark',
  lastUsername: '',
};

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'client-config.json');
}

function readConfig(): ClientDesktopConfig {
  try {
    const file = getConfigPath();
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ClientDesktopConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(patch: Partial<ClientDesktopConfig>): ClientDesktopConfig {
  const next = { ...readConfig(), ...patch };
  const file = getConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1260,
    height: 840,
    minWidth: 920,
    minHeight: 620,
    title: 'smac 客户端',
    icon: path.join(__dirname, '../build/icon.png'),
    backgroundColor: '#05070e',
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
  ipcMain.handle('config:set', (_event, patch: Partial<ClientDesktopConfig>) =>
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

  ipcMain.handle('agents:detect', (_event, baseUrl: string) =>
    detectAgents(String(baseUrl || '')),
  );
  ipcMain.handle('agents:apply', (_event, id: string, input: ApplyInput) =>
    applyAgent(String(id), input),
  );
  ipcMain.handle('agents:restore', (_event, id: string) => restoreAgent(String(id)));
  ipcMain.handle('agents:reveal', (_event, id: string) => {
    const file = revealAgentConfig(String(id));
    if (file) shell.showItemInFolder(file);
    return file;
  });
  ipcMain.handle('guest:status', (_event, hostPublicKey?: string) =>
    getGuestLocalStatus(hostPublicKey ? String(hostPublicKey) : undefined),
  );
  ipcMain.handle(
    'guest:connect',
    (_event, hostBinding: HostBindingPayload, deviceName?: string) =>
      connectLocalToHost(hostBinding, deviceName ? String(deviceName) : undefined),
  );
  ipcMain.handle(
    'guest:connect-node',
    (_event, adminNode: AdminNodePayload, deviceName?: string) =>
      connectLocalToAdminNode(adminNode, deviceName ? String(deviceName) : undefined),
  );
  ipcMain.handle('guest:disconnect', (_event, hostPublicKey?: string) =>
    disconnectLocalFromHost(hostPublicKey ? String(hostPublicKey) : undefined),
  );
  registerUpdater(ipcMain, 'client', () => BrowserWindow.getAllWindows()[0]?.webContents);

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
