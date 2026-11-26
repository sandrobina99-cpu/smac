import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizeServerUrl, type ClientModelEntry } from '@sandrobina/shared';
import { CopyButton } from './CopyButton';
import type { AgentStatus } from '../types';

interface AgentImporterProps {
  serverUrl: string;
  apiKey: string;
  models: ClientModelEntry[];
  notify: (message: string, tone?: 'info' | 'success' | 'error') => void;
}

export function AgentImporter({ serverUrl, apiKey, models, notify }: AgentImporterProps) {
  const bridge = window.desktopBridge;
  const baseUrl = `${normalizeServerUrl(serverUrl)}/v1`;
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string>('');
  const [defaultModel, setDefaultModel] = useState(models[0]?.id ?? '');

  useEffect(() => {
    if (!models.some((m) => m.id === defaultModel)) {
      setDefaultModel(models[0]?.id ?? '');
    }
  }, [models, defaultModel]);

  const scan = useCallback(async () => {
    if (!bridge?.detectAgents) return;
    setScanning(true);
    try {
      setAgents(await bridge.detectAgents(baseUrl));
    } catch (err) {
      notify(err instanceof Error ? err.message : '扫描失败', 'error');
    } finally {
      setScanning(false);
    }
  }, [baseUrl, bridge, notify]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const input = useMemo(
    () => ({
      baseUrl,
      apiKey,
      defaultModel,
      models: models.map((m) => ({ id: m.id, name: m.displayName })),
    }),
    [apiKey, baseUrl, defaultModel, models],
  );

  async function importOne(agent: AgentStatus, silent = false): Promise<boolean> {
    if (!bridge) return false;
    setBusyId(agent.id);
    try {
      const res = await bridge.applyAgent(agent.id, input);
      if (!silent) notify(`${agent.name} 已写入配置（${res.written.length} 个文件，已自动备份原文件）`, 'success');
      return true;
    } catch (err) {
      notify(`${agent.name}：${err instanceof Error ? err.message : '写入失败'}`, 'error');
      return false;
    } finally {
      setBusyId('');
    }
  }

  async function importAll() {
    const targets = agents.filter((a) => a.mode === 'file' && a.installed);
    if (!targets.length) {
      notify('没有检测到可自动写入的已安装工具', 'info');
      return;
    }
    let ok = 0;
    for (const t of targets) {
      if (await importOne(t, true)) ok += 1;
    }
    notify(`已导入 ${ok}/${targets.length} 个工具`, ok === targets.length ? 'success' : 'info');
    await scan();
  }

  async function restore(agent: AgentStatus) {
    if (!bridge) return;
    setBusyId(agent.id);
    try {
      await bridge.restoreAgent(agent.id);
      notify(`${agent.name} 已恢复到导入前的配置`, 'success');
      await scan();
    } catch (err) {
      notify(err instanceof Error ? err.message : '恢复失败', 'error');
    } finally {
      setBusyId('');
    }
  }

  if (!bridge?.detectAgents) {
    return <p className="field-hint">一键导入仅在桌面客户端中可用。</p>;
  }

  return (
    <div className="agent-importer">
      <div className="chat-toolbar">
        <div className="chat-toolbar-group">
          <label htmlFor="agent-default-model" className="chat-toolbar-label">
            默认模型
          </label>
          <select
            id="agent-default-model"
            className="select mono chat-model-select"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </div>
        <div className="chat-toolbar-actions">
          <button type="button" className="btn btn-sm" disabled={scanning} onClick={() => void scan()}>
            {scanning ? '扫描中…' : '重新扫描'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={scanning || !apiKey || !defaultModel}
            onClick={() => void importAll()}
          >
            一键导入全部已检测工具
          </button>
        </div>
      </div>

      <p className="field-hint">
        将写入 Base URL <code className="mono">{baseUrl}</code> 与你的个人 API Key。写入前会自动备份原配置，可随时「恢复」。
      </p>

      <div className="agent-grid">
        {agents.map((agent) => {
          const idPrefix = `agent-${agent.id}`;
          return (
            <article key={agent.id} className="agent-card">
              <div className="agent-card-head">
                <div>
                  <h3 className="agent-name">{agent.name}</h3>
                  <p className="field-hint">{agent.description}</p>
                </div>
                <div className="agent-badges">
                  <span className={`badge ${agent.installed ? 'badge--ok' : ''}`}>
                    {agent.installed ? '已检测到' : '未检测到'}
                  </span>
                  {agent.configured && <span className="badge badge--accent">已接入</span>}
                  {agent.mode === 'guide' && <span className="badge badge--warn">手动配置</span>}
                </div>
              </div>

              <p className="field-hint">{agent.note}</p>

              {agent.mode === 'file' ? (
                <>
                  {agent.configPaths.map((p) => (
                    <code key={p} className="mono agent-path">
                      {p}
                    </code>
                  ))}
                  <div className="agent-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busyId === agent.id || !apiKey}
                      onClick={() => void importOne(agent).then(scan)}
                    >
                      {busyId === agent.id ? '处理中…' : agent.configured ? '重新导入' : '一键导入'}
                    </button>
                    {agent.hasBackup && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busyId === agent.id}
                        onClick={() => void restore(agent)}
                      >
                        恢复原配置
                      </button>
                    )}
                    <button type="button" className="btn btn-sm" onClick={() => void bridge.revealAgent(agent.id)}>
                      打开位置
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <ol className="agent-guide">
                    {agent.guide?.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  {[
                    ['Base URL', baseUrl, `${idPrefix}-url`],
                    ['API Key', apiKey, `${idPrefix}-key`],
                    ['模型名称', defaultModel, `${idPrefix}-model`],
                  ].map(([label, value, domId]) => (
                    <div key={domId} className="credential-box agent-copy-row">
                      <span className="credential-label">{label}</span>
                      <code id={domId} className="credential-value mono">
                        {label === 'API Key' ? `${value.slice(0, 8)}••••••••` : value}
                      </code>
                      <CopyButton targetId={domId} textOverride={value} label={`复制${label}`} compact />
                    </div>
                  ))}
                </>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
