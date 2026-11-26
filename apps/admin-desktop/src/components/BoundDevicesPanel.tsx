import { useMemo, useState, type CSSProperties } from 'react';
import {
  formatDateTime,
  formatRelativeTime,
  type AdminUserRow,
  type GuestDeviceBinding,
} from '@sandrobina/shared';

interface BoundDevicesPanelProps {
  devices: GuestDeviceBinding[];
  users: AdminUserRow[];
  onBindDevice: (deviceId: string, userId: number) => Promise<void>;
  onDeleteDevice: (deviceId: string) => Promise<void>;
}

export function BoundDevicesPanel({
  devices,
  users,
  onBindDevice,
  onDeleteDevice,
}: BoundDevicesPanelProps) {
  const [search, setSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return devices.filter((d) => {
      if (accountFilter && String(d.userId) !== accountFilter) return false;
      if (!q) return true;
      return (
        d.deviceName.toLowerCase().includes(q) ||
        d.hostname.toLowerCase().includes(q) ||
        d.primaryIp.toLowerCase().includes(q) ||
        d.os.toLowerCase().includes(q) ||
        d.accountUsername.toLowerCase().includes(q) ||
        d.accountDisplayName.toLowerCase().includes(q)
      );
    });
  }, [accountFilter, devices, search]);

  async function handleAccountChange(deviceId: string, nextUserId: number) {
    setBusyId(deviceId);
    try {
      await onBindDevice(deviceId, nextUserId);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(deviceId: string) {
    setBusyId(deviceId);
    try {
      await onDeleteDevice(deviceId);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="toolbar">
        <search style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="search"
            aria-label="搜索客机设备或所属账号"
            className="input"
            placeholder="搜索客机名称、IP、系统或所属账号..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label="按所属账号筛选"
            className="select"
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
          >
            <option value="">全部账号 ({users.length})</option>
            {users.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.displayName} (@{u.username}) · {u.deviceCount ?? u.boundDevices?.length ?? 0} 台客机
              </option>
            ))}
          </select>
        </search>
        <span className="field-hint">
          共 {filtered.length} 台客机（支持 1 个账号绑定多台客机，唯一管理员拥有最高换绑与解绑权限）
        </span>
      </div>

      <div
        tabIndex={0}
        role="region"
        aria-labelledby="devices-table-caption"
        className="table-wrapper"
      >
        <table
          style={
            {
              '--label-1': '"客机设备"',
              '--label-2': '"所属账号"',
              '--label-3': '"网络与 SSH"',
              '--label-4': '"连接状态"',
              '--label-5': '"最近活跃"',
              '--label-6': '"归属管理"',
            } as CSSProperties
          }
        >
          <caption id="devices-table-caption">
            所有已接入主机与网关的客机设备均标注其所属账号，管理员可随时改绑到任意账号或移除。
          </caption>
          <thead>
            <tr>
              <th>客机设备</th>
              <th>所属账号</th>
              <th>网络与 SSH</th>
              <th>连接状态</th>
              <th>最近活跃</th>
              <th>归属管理（最高权限）</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => {
              const isBusy = busyId === d.id;
              return (
                <tr key={d.id}>
                  <th>
                    <div>
                      <strong>{d.deviceName || d.hostname || d.id}</strong>
                    </div>
                    <div className="field-hint mono">
                      {d.os || 'unknown'} · {d.hostname || d.id}
                    </div>
                  </th>
                  <td>
                    <span className="badge badge--accent">
                      {d.accountDisplayName || d.accountUsername} (@{d.accountUsername})
                    </span>
                    {!d.accountEnabled && (
                      <div className="field-hint" style={{ color: 'var(--danger)' }}>
                        所属账号已停用
                      </div>
                    )}
                  </td>
                  <td className="mono">
                    <div>
                      {d.sshUser ? `${d.sshUser}@` : ''}
                      {d.primaryIp || '—'}:{d.sshPort || 22}
                    </div>
                    {d.zerotierIp && (
                      <div className="field-hint">ZeroTier: {d.zerotierIp}</div>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <span className={`badge ${d.connected ? 'badge--ok' : 'badge--warn'}`}>
                        {d.connected ? '已连接' : '已断开'}
                      </span>
                      <span className={`badge ${d.sshAuthorized ? 'badge--ok' : ''}`}>
                        {d.sshAuthorized ? 'SSH 已授权' : 'SSH 未授权'}
                      </span>
                    </div>
                  </td>
                  <td className="mono">
                    <div>{formatRelativeTime(d.lastSeenAt)}</div>
                    <div className="field-hint">{formatDateTime(d.lastSeenAt)}</div>
                  </td>
                  <td>
                    <div className="row-actions">
                      <select
                        aria-label={`修改 ${d.deviceName} 的所属账号`}
                        className="select"
                        style={{ minHeight: 30, fontSize: '0.82rem' }}
                        disabled={isBusy || users.length === 0}
                        value={String(d.userId)}
                        onChange={(e) => {
                          const nextId = Number(e.target.value);
                          if (nextId && nextId !== d.userId) {
                            void handleAccountChange(d.id, nextId);
                          }
                        }}
                      >
                        {users.map((u) => (
                          <option key={u.id} value={String(u.id)}>
                            {u.displayName} (@{u.username})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={isBusy}
                        onClick={() => void handleRemove(d.id)}
                      >
                        移除
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  暂无已绑定的客机设备；客机登录账号并连接主机后会自动上报到此列表。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
