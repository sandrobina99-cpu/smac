import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  formatDateTime,
  formatRelativeTime,
  type ClientProfile,
  type GuestDeviceBinding,
} from '@sandrobina/shared';
import type { ClientApiClient } from '../api';
import type { GuestLocalStatus } from '../types';
import type { ToastItem } from './ToastRegion';

interface GuestHostPanelProps {
  profile: ClientProfile;
  api: ClientApiClient;
  notify: (message: string, tone?: ToastItem['tone']) => void;
  onRefreshProfile: () => Promise<void>;
}

export function GuestHostPanel({
  profile,
  api,
  notify,
  onRefreshProfile,
}: GuestHostPanelProps) {
  const hostBinding = profile.hostBinding ?? null;
  const boundDevices: GuestDeviceBinding[] = profile.boundDevices ?? [];

  const [localStatus, setLocalStatus] = useState<GuestLocalStatus | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);

  const loadLocalStatus = useCallback(async () => {
    if (!window.desktopBridge?.getGuestStatus) return;
    try {
      const st = await window.desktopBridge.getGuestStatus(hostBinding?.publicKey || '');
      setLocalStatus(st);
      setDeviceName((prev) => prev || st.deviceName || st.hostname);
    } catch {
      // ignore outside Electron
    }
  }, [hostBinding?.publicKey]);

  useEffect(() => {
    void loadLocalStatus();
  }, [loadLocalStatus]);

  const currentBound = boundDevices.find(
    (d) => localStatus && d.id === localStatus.deviceId,
  );

  async function handleConnectHost() {
    if (!hostBinding || !hostBinding.publicKey) {
      notify('主机尚未发布 SSH 绑定配置，请先在 smac 主机端登录管理员同步配置', 'error');
      return;
    }
    if (!window.desktopBridge?.connectGuestHost) {
      notify('当前运行在纯浏览器环境，请在 smac 客户端桌面应用内执行本机 SSH 授权', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await window.desktopBridge.connectGuestHost(
        hostBinding as unknown as Record<string, unknown>,
        deviceName.trim() || undefined,
      );
      await api.registerDevice(res.device);

      // Best-effort direct registration to LAN/ZeroTier smac Host endpoint if reachable
      if (hostBinding.pairToken && Array.isArray(hostBinding.endpoints)) {
        for (const ep of hostBinding.endpoints) {
          const cleanEp = String(ep || '').replace(/\/+$/, '');
          if (!cleanEp) continue;
          try {
            const directRes = await fetch(`${cleanEp}/api/guest/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(2500),
              body: JSON.stringify({
                pairToken: hostBinding.pairToken,
                deviceId: res.device.deviceId,
                name: res.device.deviceName,
                os: res.device.os,
                user: res.device.sshUser,
                host: res.device.primaryIp,
                fallbackHost: res.device.fallbackIp,
                zerotierIp: res.device.zerotierIp,
                zerotierNetworkId: res.device.zerotierNetworkId,
                port: res.device.sshPort,
                accountId: profile.user.id,
                accountUsername: profile.user.username,
                accountDisplayName: profile.user.displayName,
                accountEnabled: profile.user.enabled,
              }),
            });
            if (directRes.ok) break;
          } catch {
            // Try next endpoint
          }
        }
      }

      await loadLocalStatus();
      await onRefreshProfile();
      notify(
        `本机已授权接入主机「${hostBinding.hostName || 'smac-host'}」，并绑定到账号 @${profile.user.username}`,
        'success',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : '连接主机失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnectHost() {
    if (!window.desktopBridge?.disconnectGuestHost) {
      notify('请在 smac 客户端桌面应用内执行断联', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await window.desktopBridge.disconnectGuestHost(
        hostBinding?.publicKey || '',
      );
      try {
        await api.disconnectDevice(res.deviceId);
      } catch {
        // Device might not yet be registered on gateway
      }
      await loadLocalStatus();
      await onRefreshProfile();
      notify('已撤销本机的主机 SSH 授权并主动断开连接', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : '断联失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveDevice(deviceId: string) {
    setBusy(true);
    try {
      await api.deleteDevice(deviceId);
      await onRefreshProfile();
      notify('已从当前账号移除该客机记录', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '移除客机失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="quota-sub-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div className="quota-stat">
          <div className="quota-stat-label">本机所属账号</div>
          <div className="quota-stat-val">
            {profile.user.displayName}{' '}
            <span className="field-hint mono">@{profile.user.username}</span>
          </div>
        </div>
        <div className="quota-stat">
          <div className="quota-stat-label">已发布主机配置</div>
          <div className="quota-stat-val">
            {hostBinding?.publicKey ? (
              <span className="badge badge--ok">
                {hostBinding.hostName || 'smac-host'}（已同步公钥）
              </span>
            ) : (
              <span className="badge badge--warn">主机尚未发布配置</span>
            )}
          </div>
        </div>
        <div className="quota-stat">
          <div className="quota-stat-label">本机主机接入状态</div>
          <div className="quota-stat-val">
            {localStatus?.sshAuthorized && currentBound?.connected ? (
              <span className="badge badge--ok">已授权并在线连接</span>
            ) : localStatus?.sshAuthorized ? (
              <span className="badge badge--accent">SSH 已授权（待上报）</span>
            ) : (
              <span className="badge">未接入主机</span>
            )}
          </div>
        </div>
        <div className="quota-stat">
          <div className="quota-stat-label">账号下绑定客机数</div>
          <div className="quota-stat-val mono">{boundDevices.length} 台</div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'flex-end',
          padding: '0.85rem 1rem',
          borderRadius: 'var(--radius-md, 12px)',
          border: '1px solid var(--border)',
        }}
      >
        <div style={{ flex: '1 1 220px' }}>
          <label
            htmlFor="guest-device-alias"
            className="field-hint"
            style={{ display: 'block', marginBottom: '0.35rem' }}
          >
            本机显示名称（将显示在 smac 主机端设备卡片中，并标注所属账号 @{profile.user.username}）
          </label>
          <input
            id="guest-device-alias"
            type="text"
            className="input"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder={localStatus?.hostname || '输入本机别名'}
          />
          {localStatus && (
            <div className="field-hint mono" style={{ marginTop: '0.3rem' }}>
              设备 ID：{localStatus.deviceId} · {localStatus.os} · {localStatus.sshUser}@
              {localStatus.primaryIp || '未知IP'}
            </div>
          )}
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !hostBinding?.publicKey}
            onClick={() => void handleConnectHost()}
          >
            {busy ? '处理中...' : '主动连接主机'}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || (!localStatus?.sshAuthorized && !currentBound?.connected)}
            onClick={() => void handleDisconnectHost()}
          >
            主动断联主机
          </button>
        </div>
      </div>

      <div
        tabIndex={0}
        role="region"
        aria-labelledby="client-devices-caption"
        className="table-wrapper"
      >
        <table
          style={
            {
              '--label-1': '"客机名称"',
              '--label-2': '"所属账号"',
              '--label-3': '"网络与系统"',
              '--label-4': '"连接状态"',
              '--label-5': '"最近活跃"',
              '--label-6': '"操作"',
            } as CSSProperties
          }
        >
          <caption id="client-devices-caption">
            同一个账号下可绑定多台客机设备，所有绑定设备在 smac 主机管理端均会显示所属账号归属。
          </caption>
          <thead>
            <tr>
              <th>客机名称</th>
              <th>所属账号</th>
              <th>网络与系统</th>
              <th>连接状态</th>
              <th>最近活跃</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {boundDevices.map((d) => {
              const isCurrent = Boolean(localStatus && d.id === localStatus.deviceId);
              return (
                <tr key={d.id}>
                  <th>
                    <strong>{d.deviceName || d.hostname}</strong>{' '}
                    {isCurrent && <span className="badge badge--accent">本机</span>}
                    <div className="field-hint mono">{d.id}</div>
                  </th>
                  <td>
                    <span className="badge">
                      {d.accountDisplayName || profile.user.displayName} (@
                      {d.accountUsername || profile.user.username})
                    </span>
                  </td>
                  <td className="mono">
                    <div>
                      {d.os} · {d.sshUser}@{d.primaryIp || '—'}:{d.sshPort || 22}
                    </div>
                    {d.zerotierIp && <div className="field-hint">ZeroTier: {d.zerotierIp}</div>}
                  </td>
                  <td>
                    <span className={`badge ${d.connected ? 'badge--ok' : 'badge--warn'}`}>
                      {d.connected ? '已连接' : '已断开'}
                    </span>
                  </td>
                  <td className="mono">
                    <div>{formatRelativeTime(d.lastSeenAt)}</div>
                    <div className="field-hint">{formatDateTime(d.lastSeenAt)}</div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => void handleRemoveDevice(d.id)}
                    >
                      解绑移除
                    </button>
                  </td>
                </tr>
              );
            })}
            {boundDevices.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  当前账号尚未绑定任何客机，点击上方「主动连接主机」即可将本机接入并绑定。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
