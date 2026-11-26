import { useCallback, useEffect, useState } from 'react';
import { ModalDialog } from './ModalDialog';
import type { UpdateInfo } from '../types';

interface UpdateCenterProps {
  notify: (message: string, tone?: 'info' | 'success' | 'error') => void;
}

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function UpdateCenter({ notify }: UpdateCenterProps) {
  const bridge = window.desktopBridge;
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);

  const check = useCallback(
    async (silent: boolean) => {
      if (!bridge?.checkUpdate) return;
      setChecking(true);
      setError('');
      try {
        const next = await bridge.checkUpdate();
        setInfo(next);
        if (!silent && !next.hasUpdate) notify(`已是最新版本 ${next.currentVersion}`, 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : '检查更新失败';
        setError(msg);
        if (!silent) notify(msg, 'error');
      } finally {
        setChecking(false);
      }
    },
    [bridge, notify],
  );

  // Silent check shortly after startup so the badge can flag new versions
  useEffect(() => {
    const timer = setTimeout(() => void check(true), 2500);
    return () => clearTimeout(timer);
  }, [check]);

  useEffect(() => {
    if (!bridge?.onUpdateProgress) return undefined;
    return bridge.onUpdateProgress((p) => setProgress(p));
  }, [bridge]);

  async function handleInstall() {
    if (!bridge) return;
    setInstalling(true);
    setProgress({ received: 0, total: info?.assetSize ?? 0 });
    try {
      const res = await bridge.installUpdate();
      notify(res.message, res.ok ? 'success' : 'error');
      if (!res.ok) setInstalling(false);
    } catch (err) {
      setInstalling(false);
      setError(err instanceof Error ? err.message : '更新失败');
      notify(err instanceof Error ? err.message : '更新失败', 'error');
    }
  }

  if (!bridge?.checkUpdate) return null;

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : 0;

  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          setOpen(true);
          void check(false);
        }}
      >
        检查更新
        {info?.hasUpdate && <span className="badge badge--warn">新版本 {info.latestVersion}</span>}
      </button>

      <ModalDialog
        open={open}
        titleId="update-dialog-title"
        title="软件更新"
        onClose={() => (installing ? undefined : setOpen(false))}
      >
        <div className="update-body">
          <div className="update-versions mono">
            <span>当前版本 {info?.currentVersion ?? '—'}</span>
            <span>最新版本 {info?.latestVersion ?? '—'}</span>
          </div>

          {checking && <p className="field-hint">正在从 GitHub 检查更新…</p>}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          {info && !checking && !error && (
            <>
              {info.hasUpdate ? (
                <p>
                  发现新版本 <strong>{info.latestVersion}</strong>
                  {info.assetName ? `（${formatBytes(info.assetSize)}）` : ''}。
                </p>
              ) : (
                <p>当前已是最新版本。</p>
              )}
              {info.hasUpdate && info.notes && <pre className="code-block update-notes">{info.notes}</pre>}
              {info.hasUpdate && !info.canAutoInstall && (
                <p className="field-hint">该版本暂无适配当前系统的安装包，请前往发布页手动下载。</p>
              )}
            </>
          )}

          {installing && (
            <div>
              <div className="progress-bar" aria-label={`下载进度 ${pct}%`}>
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="field-hint">
                {pct < 100 ? `下载中 ${pct}%` : '正在安装，应用即将自动重启…'}
              </div>
            </div>
          )}

          <div className="form-actions">
            {info?.htmlUrl && (
              <a className="btn" href={info.htmlUrl} target="_blank" rel="noreferrer">
                发布页
              </a>
            )}
            <button type="button" className="btn" disabled={installing} onClick={() => setOpen(false)}>
              关闭
            </button>
            {info?.hasUpdate && info.canAutoInstall ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={installing}
                onClick={() => void handleInstall()}
              >
                {installing ? '更新中…' : '下载并安装更新'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={checking}
                onClick={() => void check(false)}
              >
                重新检查
              </button>
            )}
          </div>
        </div>
      </ModalDialog>
    </>
  );
}
