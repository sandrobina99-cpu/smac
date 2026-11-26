import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, net, type IpcMain, type WebContents } from 'electron';

/**
 * Remote update checker / installer backed by public GitHub Releases.
 * Source repo is private, so installers are published to a separate public
 * releases-only repository. Tags are namespaced per app: `client-v1.2.3`, `admin-v1.2.3`.
 */
export const RELEASES_REPO = 'sandrobina99-cpu/sandrobina-api-hub-releases';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  tag: string;
  notes: string;
  publishedAt: string | null;
  htmlUrl: string;
  assetName: string | null;
  assetSize: number;
  canAutoInstall: boolean;
}

interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string | null;
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string | null;
  assets: GhAsset[];
}

function parseVersion(v: string): number[] {
  return v
    .replace(/^[a-z-]*v?/i, '')
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function pickAsset(appKey: string, release: GhRelease): GhAsset | null {
  const suffix =
    process.platform === 'darwin'
      ? `-mac-${process.arch}.zip`
      : process.platform === 'win32'
        ? '-win-setup.exe'
        : null;
  if (!suffix) return null;
  return (
    release.assets.find(
      (a) => a.name.startsWith(`sandrobina-${appKey}-`) && a.name.endsWith(suffix),
    ) ?? null
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await net.fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sandrobina-desktop-updater',
    },
  });
  if (!res.ok) {
    throw new Error(`检查更新失败：GitHub 返回 HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function checkForUpdate(appKey: string): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();
  const releases = await fetchJson<GhRelease[]>(
    `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`,
  );
  const prefix = `${appKey}-v`;
  const candidates = releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(prefix))
    .sort((x, y) => compareVersions(y.tag_name.slice(prefix.length), x.tag_name.slice(prefix.length)));
  const latest = candidates[0];
  if (!latest) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      tag: '',
      notes: '',
      publishedAt: null,
      htmlUrl: `https://github.com/${RELEASES_REPO}/releases`,
      assetName: null,
      assetSize: 0,
      canAutoInstall: false,
    };
  }
  const latestVersion = latest.tag_name.slice(prefix.length);
  const asset = pickAsset(appKey, latest);
  return {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    tag: latest.tag_name,
    notes: latest.body ?? '',
    publishedAt: latest.published_at,
    htmlUrl: latest.html_url,
    assetName: asset?.name ?? null,
    assetSize: asset?.size ?? 0,
    canAutoInstall: Boolean(asset),
  };
}

async function downloadAsset(
  asset: GhAsset,
  destDir: string,
  onProgress: (received: number, total: number) => void,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, asset.name);
  const res = await net.fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'sandrobina-desktop-updater' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败：HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        received += value.length;
        if (!out.write(value)) {
          await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
        onProgress(received, total);
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  const expected = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : '';
  if (expected && expected.toLowerCase() !== hash.digest('hex')) {
    fs.rmSync(dest, { force: true });
    throw new Error('安装包 SHA-256 校验失败，已放弃更新');
  }
  return dest;
}

function runDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

export function registerUpdater(
  ipcMain: IpcMain,
  appKey: 'client' | 'admin',
  getSender: () => WebContents | undefined,
): void {
  ipcMain.handle('update:check', () => checkForUpdate(appKey));

  ipcMain.handle('update:install', async () => {
    const info = await checkForUpdate(appKey);
    if (!info.hasUpdate) {
      return { ok: false, message: '当前已是最新版本' };
    }
    const releases = await fetchJson<GhRelease[]>(
      `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`,
    );
    const release = releases.find((r) => r.tag_name === info.tag);
    const asset = release ? pickAsset(appKey, release) : null;
    if (!asset) {
      return { ok: false, message: '该版本没有适配当前系统的安装包' };
    }

    const workDir = path.join(os.tmpdir(), `sandrobina-update-${appKey}`);
    fs.rmSync(workDir, { recursive: true, force: true });
    const sender = getSender();
    const zipOrExe = await downloadAsset(asset, workDir, (received, total) => {
      sender?.send('update:progress', { received, total });
    });

    if (process.platform === 'darwin') {
      installMacBundle(zipOrExe, workDir);
    } else if (process.platform === 'win32') {
      runDetached(zipOrExe, []);
    } else {
      return { ok: false, message: '当前系统暂不支持自动安装' };
    }
    setTimeout(() => app.quit(), 600);
    return { ok: true, message: `正在安装 ${info.latestVersion}，应用将自动重启` };
  });
}

function installMacBundle(zipPath: string, workDir: string): void {
  const exe = app.getPath('exe');
  const bundle = path.resolve(exe, '..', '..', '..');
  if (!bundle.endsWith('.app')) {
    throw new Error('当前不是已安装的 .app，无法自动替换（开发模式）');
  }
  const extractDir = path.join(workDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  const script = path.join(workDir, 'apply-update.sh');
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(
    script,
    [
      '#!/bin/bash',
      `PID=${process.pid}`,
      `ZIP=${q(zipPath)}`,
      `EXTRACT=${q(extractDir)}`,
      `TARGET=${q(bundle)}`,
      'for i in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done',
      'rm -rf "$EXTRACT" && mkdir -p "$EXTRACT" && /usr/bin/ditto -xk "$ZIP" "$EXTRACT" || exit 1',
      'NEW=$(find "$EXTRACT" -maxdepth 2 -name "*.app" -print -quit)',
      '[ -n "$NEW" ] || exit 1',
      'rm -rf "$TARGET.old"',
      'mv "$TARGET" "$TARGET.old" || exit 1',
      'if /usr/bin/ditto "$NEW" "$TARGET"; then rm -rf "$TARGET.old"; else rm -rf "$TARGET"; mv "$TARGET.old" "$TARGET"; fi',
      '/usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null',
      '/usr/bin/open "$TARGET"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  runDetached('/bin/bash', [script]);
}
