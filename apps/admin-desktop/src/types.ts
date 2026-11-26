export interface DesktopConfig {
  serverUrl: string;
  theme: 'system' | 'light' | 'dark';
  lastUsername?: string;
}


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

export interface DesktopBridge {
  getConfig: () => Promise<DesktopConfig>;
  setConfig: (patch: Partial<DesktopConfig>) => Promise<DesktopConfig>;
  copyText: (text: string) => Promise<boolean>;
  getAppInfo: () => Promise<{ name: string; version: string; platform: string }>;
  checkUpdate: () => Promise<UpdateInfo>;
  installUpdate: () => Promise<{ ok: boolean; message: string }>;
  onUpdateProgress: (cb: (p: { received: number; total: number }) => void) => () => void;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
