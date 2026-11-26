import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  formatDateTime,
  formatRelativeTime,
  type AdminNodeInfo,
  type ClientProfile,
  type GuestDeviceBinding,
  type HandshakeStatus,
} from '@sandrobina/shared';
import type { ClientApiClient } from '../api';
import type { GuestLocalStatus } from '../types';
import type { ToastItem } from './ToastRegion';

interface GuestHostPanelProps {
  profile: ClientProfile;
  api: ClientApiClient;
  localStatus: GuestLocalStatus | null;
  notify: (message: string, tone?: ToastItem['tone']) => void;
  onRefreshProfile: () => Promise<void>;
  onReloadLocalStatus: () => Promise<void>;
}

function handshakeLabel(status?: HandshakeStatus, connected?: boolean): { text: string; tone: string } {
  if (status === 'pending') return { text: '等待主机批准', tone: 'badge--warn' };
  if (status === 'rejected') return { text: '握手被拒绝', tone: 'badge--danger' };
  if (status === 'disconnected' || connected === false) return { text: '已断联', tone: '' };
  return { text: '已直连', tone: 'badge--ok' };
}

export function GuestHostPanel({
  profile,
  api,
  localStatus,
  notify,
  onRefreshProfile,
  onReloadLocalStatus,
}: GuestHostPanelProps) {
  const adminNodes: AdminNodeInfo[] = profile.adminNodes ?? [];
  const boundDevices: GuestDeviceBinding[] = profile.boundDevices ?? [];

  const [deviceName, setDeviceName] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [busy, setBusy] = useState(false);

  const currentBound = useMemo(
    () => boundDevices.find((d) => localStatus && d.id === localStatus.deviceId) ?? null,
    [boundDevices, localStatus],
  );

  useEffect(() => {
    if (localStatus && !deviceName) {
      setDeviceName(currentBound?.deviceName || localStatus.deviceName || localStatus.hostname);
    }
  }, [currentBound?.deviceName, deviceName, localStatus]);

  useEffect(() => {
    if (selectedNodeId && adminNodes.some((n) => n.id === selectedNodeId)) return;
    const activeHostId = currentBound?.hostAdminNodeId || localStatus?.authorizedAdminNodeId || '';
    if (activeHostId && adminNodes.some((n) => n.id === activeHostId)) {
      setSelectedNodeId(activeHostId);
      return;
    }
    const firstOnline = adminNodes.find((n) => n.online) ?? adminNodes[0];
    if (firstOnline) setSelectedNodeId(firstOnline.id);
  }, [adminNodes, currentBound?.hostAdminNodeId, localStatus?.authorizedAdminNodeId, selectedNodeId]);

  const selectedNode = useMemo(
    () => adminNodes.find((n) => n.id === selectedNodeId) ?? null,
    [adminNodes, selectedNodeId],
  );

  const isSwitchingHost = Boolean(
    selectedNode &&
      currentBound?.hostAdminNodeId &&
      currentBound.hostAdminNodeId !== selectedNode.id &&
      currentBound.connected,
  );

  async function handleHandshake() {
    if (!selectedNode) {
      notify('请先在上方选择一台在线的管理员主机', 'error');
      return;
    }
    if (!selectedNode.publicKey) {
      notify('目标管理员主机尚未同步 SSH 公钥，请让管理员端重新登录同步', 'error');
      return;
    }
    if (!window.desktopBridge?.connectGuestAdminNode) {
      notify('当前运行在纯浏览器环境，请在 smac 客户端桌面应用内执行握手授权', 'error');
      return;
    }
    setBusy(true);
    try {
      const localRes = await window.desktopBridge.connectGuestAdminNode(
        selectedNode,
        deviceName.trim() || undefined,
      );
      const gwRes = await api.requestHandshake({
        deviceId: localRes.device.deviceId,
        deviceName: localRes.device.deviceName,
        hostname: localRes.device.hostname,
        os: localRes.device.os,
        sshUser: localRes.device.sshUser,
        sshPort: localRes.device.sshPort,
        primaryIp: localRes.device.primaryIp,
        fallbackIp: localRes.device.fallbackIp,
        zerotierIp: localRes.device.zerotierIp,
        zerotierNetworkId: localRes.device.zerotierNetworkId,
        targetAdminNodeId: selectedNode.id,
        sshAuthorized: true,
      });

      await onReloadLocalStatus();
      await onRefreshProfile();

      if (gwRes.autoApproved) {
        notify(
          `握手已自动通过，本机已由管理员主机「${selectedNode.nodeName}」直连`,
          'success',
        );
      } else {
        notify(
          `握手请求已发送至「${selectedNode.nodeName}」，等待该主机点击「批准接入」`,
          'info',
        );
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : '发起握手失败', 'error');
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
      const res = await window.desktopBridge.disconnectGuestHost();
      try {
        await api.disconnectDevice(res.deviceId);
      } catch {
        // Device might not yet be registered on gateway
      }
      await onReloadLocalStatus();
      await onRefreshProfile();
      notify('已撤销本机 SSH 主机授权并主动断开连接', 'info');
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
      notify('已从当前账号移除该设备记录', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '移除设备失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  const currentHs = handshakeLabel(currentBound?.handshakeStatus, currentBound?.connected);

  return (
    <div className="guest-workspace">
      <div className="smac-kpi-strip">
        <div className="smac-kpi">
          <div className="smac-kpi-label">本机所属账号</div>
          <div className="smac-kpi-val">
            {profile.user.displayName}{' '}
            <span className="field-hint mono">@{profile.user.username}</span>
          </div>
          {profile.user.autoApproveHandshake && (
            <span className="badge badge--ok" style={{ marginTop: '0.35rem' }}>
              信任账号 · 握手免审直连
            </span>
          )}
        </div>
        <div className="smac-kpi">
          <div className="smac-kpi-label">当前直连管理员主机</div>
          <div className="smac-kpi-val">
            {currentBound?.hostAdminName ? (
              <span>★ {currentBound.hostAdminName}</span>
            ) : (
              <span className="field-hint">尚未绑定直连主机</span>
            )}
          </div>
          <div className="field-hint" style={{ marginTop: '0.2rem' }}>
            仅直连主机持有本机 SSH 授权，其他管理员主机无法直接操作本机
          </div>
        </div>
        <div className="smac-kpi">
          <div className="smac-kpi-label">本机握手与授权状态</div>
          <div className="smac-kpi-val" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span className={`badge ${currentBound ? currentHs.tone : ''}`}>
              {currentBound ? currentHs.text : localStatus?.sshAuthorized ? '仅本地授权' : '未连接'}
            </span>
            {currentBound?.pendingCommand && (
              <span className="badge badge--accent">正在执行主机指令…</span>
            )}
          </div>
          {localStatus && (
            <div className="field-hint mono" style={{ marginTop: '0.25rem' }}>
              {localStatus.os} · {localStatus.sshUser}@{localStatus.primaryIp || '—'}:{localStatus.sshPort}
            </div>
          )}
        </div>
        <div className="smac-kpi">
          <div className="smac-kpi-label">在线管理员主机 / 账号设备</div>
          <div className="smac-kpi-val mono">
            {adminNodes.filter((n) => n.online).length}/{adminNodes.length} 台主机 · {boundDevices.length} 台设备
          </div>
        </div>
      </div>

      {currentBound?.handshakeStatus === 'pending' && (
        <div className="smac-banner smac-banner--warn" role="status">
          <strong>等待主机批准握手：</strong>本机已向管理员主机「{currentBound.hostAdminName || currentBound.hostAdminNodeId}」发送握手请求并写入其专属公钥；请等待该主机在「全局网络 · 设备」中点击「批准接入」。
        </div>
      )}

      {currentBound?.handshakeStatus === 'rejected' && (
        <div className="smac-banner smac-banner--danger" role="status">
          <strong>握手请求已被拒绝：</strong>管理员主机「{currentBound.hostAdminName || currentBound.hostAdminNodeId}」拒绝了本次接入，你可以重新选择目标主机发起握手或主动断联。
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">1. 选择要直连的管理员主机</h2>
            <p className="field-hint" style={{ margin: '0.2rem 0 0' }}>
              单向严格隔离：每次握手仅向所选的 1 台管理员主机授予 SSH 权限，切换主机时会自动吊销旧主机公钥。
            </p>
          </div>
          <span className="badge badge--accent">共 {adminNodes.length} 台管理员设备</span>
        </div>

        {adminNodes.length === 0 ? (
          <div className="smac-empty-box">
            当前网关中暂无已登记的管理员主机。请先在任意一台电脑上打开 <strong>smac 管理端</strong> 并登录唯一管理员账号，主机上线后将自动出现在此处。
          </div>
        ) : (
          <div className="smac-host-grid">
            {adminNodes.map((node) => {
              const isSelected = node.id === selectedNodeId;
              const isCurrentDirect = currentBound?.hostAdminNodeId === node.id;
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`smac-host-card${isSelected ? ' is-selected' : ''}${isCurrentDirect ? ' is-current' : ''}`}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <div className="smac-host-top">
                    <div className="smac-host-title">
                      <span className="smac-host-star" aria-hidden="true">★</span>
                      <strong>{node.nodeName || node.hostname}</strong>
                    </div>
                    <span className={`badge ${node.online ? 'badge--ok' : ''}`}>
                      {node.online ? '在线' : '离线'}
                    </span>
                  </div>
                  <div className="smac-host-meta mono">
                    {node.os || 'Host'} · {node.sshUser}@{node.primaryIp || node.fallbackIp || '—'}:{node.sshPort || 22}
                  </div>
                  <div className="smac-host-tags">
                    {node.fallbackIp && <span className="smac-mini-tag">备 {node.fallbackIp}</span>}
                    {node.zerotierIp && <span className="smac-mini-tag">ZT {node.zerotierIp}</span>}
                    {isCurrentDirect && (
                      <span className={`badge ${currentHs.tone}`}>{currentHs.text}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="smac-handshake-bar">
          <div style={{ flex: '1 1 240px' }}>
            <label htmlFor="guest-device-alias" className="field-hint" style={{ display: 'block', marginBottom: '0.35rem' }}>
              本机在全局网络中的显示名称（自动标注所属账号 @{profile.user.username}）
            </label>
            <input
              id="guest-device-alias"
              type="text"
              className="input"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder={localStatus?.hostname || '输入本机别名'}
            />
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !selectedNode}
              onClick={() => void handleHandshake()}
            >
              {busy
                ? '正在握手…'
                : isSwitchingHost
                  ? `切换直连至「${selectedNode?.nodeName}」`
                  : selectedNode
                    ? `向「${selectedNode.nodeName}」发起握手`
                    : '选择管理员主机'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || (!localStatus?.sshAuthorized && !currentBound?.connected)}
              onClick={() => void handleDisconnectHost()}
            >
              主动断联
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">2. 本账号下的全部设备</h2>
            <p className="field-hint" style={{ margin: '0.2rem 0 0' }}>
              一个账号可绑定多台客户端设备，列表中清晰展示每台设备当前由哪台管理员主机直连。
            </p>
          </div>
          <span className="badge">{boundDevices.length} 台</span>
        </div>

        <div tabIndex={0} role="region" aria-labelledby="client-devices-caption" className="table-wrapper">
          <table
            style={
              {
                '--label-1': '"设备名称"',
                '--label-2': '"直连管理员主机"',
                '--label-3': '"网络与系统"',
                '--label-4': '"握手与状态"',
                '--label-5': '"最近活跃"',
                '--label-6': '"操作"',
              } as CSSProperties
            }
          >
            <caption id="client-devices-caption">
              展示归属 @{profile.user.username} 的所有客户端设备及其直连主机归属。
            </caption>
            <thead>
              <tr>
                <th>设备名称</th>
                <th>直连管理员主机</th>
                <th>网络与系统</th>
                <th>握手与状态</th>
                <th>最近活跃</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {boundDevices.map((d) => {
                const isCurrent = Boolean(localStatus && d.id === localStatus.deviceId);
                const hs = handshakeLabel(d.handshakeStatus, d.connected);
                return (
                  <tr key={d.id}>
                    <th>
                      <strong>{d.deviceName || d.hostname}</strong>{' '}
                      {isCurrent && <span className="badge badge--accent">本机</span>}
                      <div className="field-hint mono">{d.id}</div>
                    </th>
                    <td>
                      {d.hostAdminName ? (
                        <span className="badge badge--accent">★ 由 {d.hostAdminName} 直连</span>
                      ) : (
                        <span className="field-hint">未指定直连主机</span>
                      )}
                    </td>
                    <td className="mono">
                      <div>
                        {d.os} · {d.sshUser}@{d.primaryIp || '—'}:{d.sshPort || 22}
                      </div>
                      {d.zerotierIp && <div className="field-hint">ZT: {d.zerotierIp}</div>}
                    </td>
                    <td>
                      <span className={`badge ${hs.tone}`}>{hs.text}</span>
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
                        移除
                      </button>
                    </td>
                  </tr>
                );
              })}
              {boundDevices.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    当前账号尚未绑定任何客户端设备，请在上方选择一台管理员主机并发起握手。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
