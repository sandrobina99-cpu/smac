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

export interface AgentStatus {
  id: string;
  name: string;
  description: string;
  mode: 'file' | 'guide';
  installed: boolean;
  configPaths: string[];
  configured: boolean;
  hasBackup: boolean;
  note: string;
  guide?: string[];
}

export interface AgentApplyInput {
  baseUrl: string;
  apiKey: string;
  models: Array<{ id: string; name: string }>;
  defaultModel: string;
}

export interface GuestLocalStatus {
  deviceId: string;
  deviceName: string;
  hostname: string;
  os: string;
  sshUser: string;
  sshPort: number;
  primaryIp: string;
  fallbackIp: string;
  zerotierIp: string;
  sshAuthorized: boolean;
}

export interface GuestConnectResult {
  ok: boolean;
  sshAuthorized: boolean;
  device: {
    deviceId: string;
    deviceName: string;
    hostname: string;
    os: string;
    sshUser: string;
    sshPort: number;
    primaryIp: string;
    fallbackIp: string;
    zerotierIp: string;
    zerotierNetworkId: string;
    connected: boolean;
    sshAuthorized: boolean;
  };
}

export interface DesktopBridge {
  getConfig: () => Promise<DesktopConfig>;
  setConfig: (patch: Partial<DesktopConfig>) => Promise<DesktopConfig>;
  copyText: (text: string) => Promise<boolean>;
  getAppInfo: () => Promise<{ name: string; version: string; platform: string }>;
  checkUpdate: () => Promise<UpdateInfo>;
  installUpdate: () => Promise<{ ok: boolean; message: string }>;
  onUpdateProgress: (cb: (p: { received: number; total: number }) => void) => () => void;
  detectAgents: (baseUrl: string) => Promise<AgentStatus[]>;
  applyAgent: (id: string, input: AgentApplyInput) => Promise<{ written: string[] }>;
  restoreAgent: (id: string) => Promise<{ restored: string[] }>;
  revealAgent: (id: string) => Promise<string | null>;
  getGuestStatus: (hostPublicKey?: string) => Promise<GuestLocalStatus>;
  connectGuestHost: (
    hostBinding: Record<string, unknown>,
    deviceName?: string,
  ) => Promise<GuestConnectResult>;
  disconnectGuestHost: (
    hostPublicKey?: string,
  ) => Promise<{ ok: boolean; removedCount: number; deviceId: string }>;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
