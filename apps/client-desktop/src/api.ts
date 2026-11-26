import {
  normalizeServerUrl,
  type ClientProfile,
  type GuestDeviceBinding,
  type GuestDeviceCommand,
  type HandshakeStatus,
} from '@sandrobina/shared';

export class ClientApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export type StreamConnectionState = 'connected' | 'connecting' | 'disconnected';

export interface IncomingDeviceCommandEvent {
  deviceId: string;
  command: GuestDeviceCommand;
}

export class ClientApiClient {
  constructor(
    private serverUrl: string,
    private token: string,
    private onUnauthorized?: (reason?: string) => void,
  ) {}

  setAuth(serverUrl: string, token: string): void {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = normalizeServerUrl(this.serverUrl);
    if (!base) {
      throw new ClientApiError('请填写网关服务器地址', 0);
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
      throw new ClientApiError(
        `无法连接网关服务器 (${err instanceof Error ? err.message : '网络错误'})`,
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
      const msg =
        (typeof json.error === 'string' && json.error) ||
        `请求失败 (HTTP ${res.status})`;
      if ((res.status === 401 || res.status === 403) && path !== '/api/client/login') {
        this.onUnauthorized?.(msg);
      }
      throw new ClientApiError(msg, res.status);
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
    return this.request<{ token: string; profile: ClientProfile }>('/api/client/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  me() {
    return this.request<ClientProfile>('/api/client/me');
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.request<{ ok: boolean; token: string }>('/api/client/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  testApiKey() {
    return this.request<{
      ok: boolean;
      allowedModelCount: number;
      sampleModels: string[];
      quotaRemaining: number;
      isExhausted: boolean;
      latencyMs: number;
    }>('/api/client/test-key', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  registerDevice(payload: {
    deviceId?: string;
    deviceName: string;
    hostname: string;
    os: string;
    sshUser: string;
    sshPort: number;
    primaryIp: string;
    fallbackIp?: string;
    zerotierIp?: string;
    zerotierNodeId?: string;
    zerotierNetworkId?: string;
    connected?: boolean;
    sshAuthorized?: boolean;
  }) {
    return this.request<{
      ok: boolean;
      device: GuestDeviceBinding;
      devices: GuestDeviceBinding[];
    }>('/api/client/devices/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  requestHandshake(payload: {
    deviceId: string;
    deviceName: string;
    hostname: string;
    os: string;
    sshUser: string;
    sshPort: number;
    primaryIp: string;
    fallbackIp?: string;
    zerotierIp?: string;
    zerotierNodeId?: string;
    zerotierNetworkId?: string;
    targetAdminNodeId: string;
    sshAuthorized?: boolean;
  }) {
    return this.request<{
      ok: boolean;
      autoApproved: boolean;
      handshakeStatus: HandshakeStatus;
      device: GuestDeviceBinding;
      devices: GuestDeviceBinding[];
    }>('/api/client/devices/handshake', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  ackDeviceCommand(
    deviceId: string,
    payload: {
      commandId: string;
      ok: boolean;
      connected?: boolean;
      sshAuthorized?: boolean;
      handshakeStatus?: HandshakeStatus;
      hostAdminNodeId?: string;
      hostAdminName?: string;
    },
  ) {
    return this.request<{
      ok: boolean;
      device: GuestDeviceBinding;
      devices: GuestDeviceBinding[];
    }>(`/api/client/devices/${encodeURIComponent(deviceId)}/ack-command`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  disconnectDevice(deviceId: string) {
    return this.request<{
      ok: boolean;
      device: GuestDeviceBinding;
      devices: GuestDeviceBinding[];
    }>(`/api/client/devices/${encodeURIComponent(deviceId)}/disconnect`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  deleteDevice(deviceId: string) {
    return this.request<{ ok: boolean; devices: GuestDeviceBinding[] }>(
      `/api/client/devices/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
      },
    );
  }

  subscribeProfileStream(
    onProfile: (profile: ClientProfile) => void,
    onStatusChange: (status: StreamConnectionState) => void,
    onUnauthorized: (reason?: string) => void,
    onCommand?: (event: IncomingDeviceCommandEvent) => void,
  ): () => void {
    const base = normalizeServerUrl(this.serverUrl);
    if (!base || !this.token) {
      onStatusChange('disconnected');
      return () => {};
    }

    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let source: EventSource | null = null;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      onStatusChange('connecting');
      const url = `${base}/api/client/stream?token=${encodeURIComponent(this.token)}`;
      source = new EventSource(url);

      source.onopen = () => {
        attempt = 0;
        onStatusChange('connected');
      };

      source.addEventListener('profile', (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as ClientProfile;
          attempt = 0;
          onStatusChange('connected');
          onProfile(parsed);
        } catch {
          // ignore malformed event payload
        }
      });

      source.addEventListener('command', (event) => {
        if (!onCommand) return;
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as IncomingDeviceCommandEvent;
          if (parsed && parsed.deviceId && parsed.command) {
            onCommand(parsed);
          }
        } catch {
          // ignore malformed command payload
        }
      });

      source.addEventListener('unauthorized', (event) => {
        let msg = '账号状态已变更，请重新登录';
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as { error?: string };
          if (parsed.error) msg = parsed.error;
        } catch {
          // ignore
        }
        closed = true;
        source?.close();
        onStatusChange('disconnected');
        onUnauthorized(msg);
      });

      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        onStatusChange('disconnected');
        const delayMs = Math.min(15_000, 1500 * Math.pow(1.6, attempt));
        attempt += 1;
        retryTimer = setTimeout(connect, delayMs);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }
}
