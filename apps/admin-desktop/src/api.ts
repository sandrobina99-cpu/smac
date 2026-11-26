import {
  normalizeServerUrl,
  type AdminOverview,
  type AdminUserRow,
  type GatewaySettings,
  type GuestDeviceBinding,
  type HostBindingConfig,
  type ModelAccessMode,
  type ModelEntry,
  type UsageLogRow,
} from '@sandrobina/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class AdminApiClient {
  constructor(
    private serverUrl: string,
    private token: string,
    private onUnauthorized?: () => void,
  ) {}

  setAuth(serverUrl: string, token: string): void {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = normalizeServerUrl(this.serverUrl);
    if (!base) {
      throw new ApiError('请填写网关服务器地址', 0);
    }
    const headers = new Headers(init.headers);
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers,
      });
    } catch (err) {
      throw new ApiError(
        `无法连接到网关服务器 (${err instanceof Error ? err.message : '网络错误'})`,
        0,
      );
    }

    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // non-JSON error body
      }
    }

    if (!res.ok) {
      if (res.status === 401 && path !== '/api/admin/login') {
        this.onUnauthorized?.();
      }
      const msg =
        (typeof json.error === 'string' && json.error) ||
        `请求失败 (HTTP ${res.status})`;
      throw new ApiError(msg, res.status);
    }

    return json as T;
  }

  async checkHealth(serverUrl: string): Promise<boolean> {
    const base = normalizeServerUrl(serverUrl);
    if (!base) return false;
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(4000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  login(username: string, password: string) {
    return this.request<{
      token: string;
      admin: { id: number; username: string };
    }>('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  me() {
    return this.request<{ id: number; username: string }>('/api/admin/me');
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.request<{
      token: string;
      admin: { id: number; username: string };
    }>('/api/admin/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  overview() {
    return this.request<AdminOverview>('/api/admin/overview');
  }

  listUsers() {
    return this.request<{ users: AdminUserRow[] }>('/api/admin/users');
  }

  createUser(payload: {
    username: string;
    displayName: string;
    password: string;
    weeklyTokenLimit: number;
    enabled: boolean;
    modelAccessMode: ModelAccessMode;
    notes: string;
  }) {
    return this.request<{ user: AdminUserRow }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateUser(
    id: number,
    payload: Partial<{
      username: string;
      displayName: string;
      weeklyTokenLimit: number;
      enabled: boolean;
      modelAccessMode: ModelAccessMode;
      notes: string;
    }>,
  ) {
    return this.request<{ user: AdminUserRow }>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  updateUserModels(
    id: number,
    payload: {
      modelAccessMode: ModelAccessMode;
      overrides: Record<string, boolean>;
    },
  ) {
    return this.request<{ user: AdminUserRow }>(`/api/admin/users/${id}/models`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  resetUserPassword(id: number, password: string) {
    return this.request<{ ok: boolean }>(`/api/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  rotateUserKey(id: number) {
    return this.request<{ apiKey: string; user: AdminUserRow }>(
      `/api/admin/users/${id}/rotate-key`,
      { method: 'POST' },
    );
  }

  resetUserQuota(id: number) {
    return this.request<{
      ok: boolean;
      clearedRecords: number;
      user: AdminUserRow;
    }>(`/api/admin/users/${id}/reset-quota`, { method: 'POST' });
  }

  deleteUser(id: number) {
    return this.request<{ ok: boolean }>(`/api/admin/users/${id}`, {
      method: 'DELETE',
    });
  }

  listModels() {
    return this.request<{ models: ModelEntry[] }>('/api/admin/models');
  }

  syncModels() {
    return this.request<{
      syncedCount: number;
      addedCount: number;
      models: ModelEntry[];
    }>('/api/admin/models/sync', { method: 'POST' });
  }

  createModel(payload: {
    id: string;
    displayName: string;
    ownedBy?: string;
    contextLength?: number | null;
    multiplier: number;
    globalEnabled: boolean;
  }) {
    return this.request<{ model: ModelEntry }>('/api/admin/models', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateModel(
    id: string,
    payload: Partial<{
      displayName: string;
      multiplier: number;
      globalEnabled: boolean;
      contextLength: number | null;
    }>,
  ) {
    return this.request<{ model: ModelEntry }>(
      `/api/admin/models/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
    );
  }

  listUsage(params: { userId?: number; modelId?: string; limit?: number; offset?: number }) {
    const q = new URLSearchParams();
    if (params.userId) q.set('userId', String(params.userId));
    if (params.modelId) q.set('modelId', params.modelId);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    const qs = q.toString();
    return this.request<{ logs: UsageLogRow[]; total: number }>(
      `/api/admin/usage${qs ? `?${qs}` : ''}`,
    );
  }

  getSettings() {
    return this.request<GatewaySettings>('/api/admin/settings');
  }

  updateSettings(
    payload: Partial<{
      upstreamBaseUrl: string;
      upstreamApiKey: string;
      publicBaseUrl: string;
      defaultWeeklyTokenLimit: number;
    }>,
  ) {
    return this.request<GatewaySettings>('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  testUpstream(payload?: { upstreamBaseUrl?: string; upstreamApiKey?: string }) {
    return this.request<{
      ok: boolean;
      status: number;
      modelCount: number;
      latencyMs: number;
      error?: string;
    }>('/api/admin/settings/test-upstream', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  }

  getHostBinding() {
    return this.request<{ hostBinding: HostBindingConfig | null }>(
      '/api/admin/host-binding',
    );
  }

  updateHostBinding(payload: Partial<HostBindingConfig>) {
    return this.request<{ ok: boolean; hostBinding: HostBindingConfig }>(
      '/api/admin/host-binding',
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
  }

  listDevices(userId?: number) {
    const qs = userId ? `?userId=${userId}` : '';
    return this.request<{ devices: GuestDeviceBinding[] }>(`/api/admin/devices${qs}`);
  }

  bindDevice(
    deviceId: string,
    payload: { userId: number; deviceName?: string; connected?: boolean },
  ) {
    return this.request<{ ok: boolean; device: GuestDeviceBinding }>(
      `/api/admin/devices/${encodeURIComponent(deviceId)}/bind`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
    );
  }

  deleteDevice(deviceId: string) {
    return this.request<{ ok: boolean }>(
      `/api/admin/devices/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
      },
    );
  }
}
