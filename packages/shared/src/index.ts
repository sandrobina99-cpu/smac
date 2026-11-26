export type ModelAccessMode = 'all_except_denied' | 'allow_list';

export interface DailyBucket {
  date: string;
  weightedTokens: number;
  rawTokens: number;
  requests: number;
}

export interface QuotaSnapshot {
  windowHours: number;
  windowStartAt: number;
  weeklyLimit: number;
  usedWeighted: number;
  usedRaw: number;
  remainingWeighted: number;
  usagePercent: number;
  requestCount: number;
  isExhausted: boolean;
  nextReleaseAt: number | null;
  nextReleaseAmount: number;
  releasingIn24h: number;
  dailyBreakdown: DailyBucket[];
}

export interface ModelEntry {
  id: string;
  displayName: string;
  ownedBy: string;
  contextLength: number | null;
  multiplier: number;
  globalEnabled: boolean;
  isUpstreamPresent: boolean;
  syncedAt: number;
  updatedAt: number;
  usedWeighted7d?: number;
  usedRaw7d?: number;
  requests7d?: number;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string | null;
}

export interface GuestDeviceBinding {
  id: string;
  userId: number;
  accountUsername: string;
  accountDisplayName: string;
  accountEnabled: boolean;
  deviceName: string;
  hostname: string;
  os: string;
  sshUser: string;
  sshPort: number;
  primaryIp: string;
  fallbackIp: string;
  zerotierIp: string;
  zerotierNodeId: string;
  zerotierNetworkId: string;
  connected: boolean;
  sshAuthorized: boolean;
  env?: Record<string, unknown> | null;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface HostBindingConfig {
  hostName: string;
  publicKey: string;
  pairToken: string;
  endpoints: string[];
  zerotierNetworkId: string;
  updatedAt: number;
}

export interface AdminUserRow {
  id: number;
  username: string;
  displayName: string;
  enabled: boolean;
  weeklyTokenLimit: number;
  modelAccessMode: ModelAccessMode;
  notes: string;
  apiKey: string;
  apiKeyPrefix: string;
  createdAt: number;
  updatedAt: number;
  quota: QuotaSnapshot;
  allowedModelCount: number;
  totalActiveModelCount: number;
  modelOverrides: Record<string, boolean>;
  boundDevices?: GuestDeviceBinding[];
  deviceCount?: number;
}

export interface UsageLogRow {
  id: number;
  userId: number;
  username?: string;
  displayName?: string;
  modelId: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  multiplier: number;
  weightedTokens: number;
  statusCode: number;
  isStream: boolean;
  latencyMs: number;
  createdAt: number;
}

export interface GatewaySettings {
  upstreamBaseUrl: string;
  hasUpstreamApiKey: boolean;
  upstreamApiKeyMasked: string;
  publicBaseUrl: string;
  defaultWeeklyTokenLimit: number;
  lastModelSyncAt: number | null;
}

export interface AdminOverview {
  totalUsers: number;
  activeUsers: number;
  totalModels: number;
  enabledModels: number;
  usedWeighted7d: number;
  usedRaw7d: number;
  requests7d: number;
  dailyBreakdown: DailyBucket[];
  topModels: Array<{
    modelId: string;
    displayName: string;
    multiplier: number;
    weightedTokens: number;
    rawTokens: number;
    requests: number;
  }>;
  topUsers: Array<{
    userId: number;
    username: string;
    displayName: string;
    usedWeighted: number;
    weeklyLimit: number;
    usagePercent: number;
  }>;
  lastModelSyncAt: number | null;
  upstreamConfigured: boolean;
  totalBoundDevices?: number;
  connectedDevices?: number;
}

export interface ClientModelEntry {
  id: string;
  displayName: string;
  ownedBy: string;
  contextLength: number | null;
  multiplier: number;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string | null;
}

export interface ClientProfile {
  user: {
    id: number;
    username: string;
    displayName: string;
    enabled: boolean;
    modelAccessMode: ModelAccessMode;
    createdAt: number;
  };
  api: {
    baseUrl: string;
    apiKey: string;
  };
  quota: QuotaSnapshot;
  models: ClientModelEntry[];
  recentUsage: UsageLogRow[];
  hostBinding?: HostBindingConfig | null;
  boundDevices?: GuestDeviceBinding[];
  serverTime: number;
}

export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(Number(value) || 0));
  return n.toLocaleString('en-US');
}

export function formatCompactTokens(value: number): string {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

export function formatMultiplier(mult: number): string {
  const n = Number(mult);
  if (!Number.isFinite(n)) return '1.0x';
  return `${Number(n.toFixed(2))}x`;
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatRelativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const diffMs = ts - now;
  const absMs = Math.abs(diffMs);
  const mins = Math.floor(absMs / 60_000);
  const hours = Math.floor(absMs / 3_600_000);
  const days = Math.floor(absMs / 86_400_000);
  const label =
    days >= 1
      ? `${days} 天 ${hours % 24} 小时`
      : hours >= 1
        ? `${hours} 小时 ${mins % 60} 分钟`
        : mins >= 1
          ? `${mins} 分钟`
          : '不足 1 分钟';
  return diffMs >= 0 ? `${label}后` : `${label}前`;
}

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}
