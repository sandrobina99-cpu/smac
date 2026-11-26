import { spawn, type ChildProcess } from 'node:child_process';
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
  theme: 'dark',
  lastUsername: 'admin',
};

let mainWindow: BrowserWindow | null = null;
let embeddedServer: ChildProcess | null = null;
let embeddedServerUrl = '';
let serverStartingPromise: Promise<string> | null = null;
let quitting = false;

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

function resolveRuntimeServerScript(): string {
  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'smac-runtime', 'web', 'server.js'));
  } else {
    candidates.push(path.resolve(__dirname, '../../../web/server.js'));
    candidates.push(path.resolve(__dirname, '../runtime/web/server.js'));
    candidates.push(path.join(process.resourcesPath, 'smac-runtime', 'web', 'server.js'));
  }
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`未找到内嵌控制台服务端脚本（已检查: ${candidates.join(', ')}）`);
}

async function probeLocalConsolePort(port: number, expectedPid?: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; app?: string; pid?: number };
    if (data && data.ok && data.app === 'smac') {
      if (expectedPid && Number(data.pid) !== expectedPid) {
        return null;
      }
      return `http://127.0.0.1:${port}/`;
    }
  } catch {
    // not listening
  }
  return null;
}

function stopEmbeddedServer(): void {
  const proc = embeddedServer;
  embeddedServer = null;
  embeddedServerUrl = '';
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 1500).unref();
}

function ensureEmbeddedConsoleServer(): Promise<string> {
  if (embeddedServerUrl && embeddedServer && !embeddedServer.killed) {
    return Promise.resolve(embeddedServerUrl);
  }
  if (serverStartingPromise) return serverStartingPromise;

  serverStartingPromise = new Promise<string>((resolve, reject) => {
    let serverScript: string;
    try {
      serverScript = resolveRuntimeServerScript();
    } catch (err) {
      reject(err);
      return;
    }

    const basePort = Number(process.env.SMAC_PORT) || 8788;
    const child = spawn(process.execPath, [serverScript], {
      cwd: path.dirname(serverScript),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SMAC_ELECTRON_HOST: '1',
        SMAC_PORT: String(basePort),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    embeddedServer = child;

    let settled = false;
    let outBuf = '';
    let errBuf = '';

    const finishOk = (url: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poller);
      embeddedServerUrl = url;
      resolve(url);
    };

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poller);
      if (embeddedServer === child) embeddedServer = null;
      reject(err);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      outBuf += chunk;
      const match = /smac web console:\s*(http:\/\/127\.0\.0\.1:\d+\/?)/i.exec(outBuf);
      if (match && match[1]) {
        const url = match[1].endsWith('/') ? match[1] : `${match[1]}/`;
        finishOk(url);
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      errBuf = (errBuf + chunk).slice(-4000);
    });

    child.once('error', (err) => {
      finishErr(new Error(`启动内嵌控制台服务失败: ${err.message}`));
    });

    child.once('exit', (code, signal) => {
      if (embeddedServer === child) {
        embeddedServer = null;
        embeddedServerUrl = '';
      }
      if (!settled && !quitting) {
        finishErr(
          new Error(
            `内嵌控制台服务提前退出 (code=${code ?? 'null'}, signal=${signal ?? 'none'})\n${errBuf || outBuf}`,
          ),
        );
      }
    });

    // Fallback health probe in case stdout buffering delays the banner
    // Strictly match child.pid so we NEVER attach to an old legacy smac-host-app on 8788.
    const poller = setInterval(async () => {
      if (settled) return;
      for (let offset = 0; offset <= 8; offset += 1) {
        const found = await probeLocalConsolePort(basePort + offset, child.pid);
        if (found) {
          finishOk(found);
          return;
        }
      }
    }, 600);

    const timeout = setTimeout(() => {
      finishErr(new Error(`等待内嵌控制台服务启动超时 (15s)\n${errBuf || outBuf}`));
    }, 15_000);
  }).finally(() => {
    serverStartingPromise = null;
  });

  return serverStartingPromise;
}

function buildErrorHtml(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>smac 管理端启动失败</title>
<style>body{margin:0;padding:40px;background:#05070e;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
.box{max-width:720px;margin:40px auto;padding:24px;border-radius:16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);}
h1{margin:0 0 10px;font-size:18px;color:#fda4af;}pre{white-space:pre-wrap;font-size:12px;color:#cbd5e1;background:rgba(0,0,0,0.35);padding:14px;border-radius:10px;overflow:auto;}</style>
</head><body><div class="box"><h1>smac 管理端内嵌控制台启动异常</h1><p>请重启应用或检查以下诊断信息：</p><pre>${safe}</pre></div></body></html>`;
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 980,
    minHeight: 660,
    title: 'smac 管理端',
    icon: path.join(__dirname, '../build/icon.png'),
    backgroundColor: '#05070e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  try {
    const consoleUrl = await ensureEmbeddedConsoleServer();
    await win.loadURL(consoleUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[admin-desktop] Failed to start embedded smac console:', msg);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildErrorHtml(msg))}`);
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
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    if (/^https?:\/\//i.test(String(url || ''))) {
      return shell.openExternal(String(url));
    }
    return Promise.resolve();
  });
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }));

  registerUpdater(ipcMain, 'admin', () => (mainWindow ?? BrowserWindow.getAllWindows()[0])?.webContents);

  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('before-quit', () => {
  quitting = true;
  stopEmbeddedServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
