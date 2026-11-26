import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  formatMultiplier,
  formatTokens,
  normalizeServerUrl,
  type ClientModelEntry,
} from '@sandrobina/shared';
import { CopyButton } from './CopyButton';

export interface ChatPlaygroundProps {
  serverUrl: string;
  apiKey: string;
  models: ClientModelEntry[];
  isQuotaExhausted: boolean;
  initialModelId?: string;
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
  modelId?: string;
  reasoningEffort?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  weightedTokens?: number;
  multiplier?: number;
  streaming?: boolean;
  error?: string;
  createdAt: number;
}

const EFFORT_LABELS: Record<string, string> = {
  auto: '默认',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极高',
  ultra: '终极',
};

const QUICK_PROMPTS = [
  {
    label: '连通性自检',
    prompt: '请简短回复“连通正常”，并说明你的回答是否清晰完整。',
  },
  {
    label: '逻辑推理测试',
    prompt:
      '有三个不透明盒子分别装有纯苹果、纯橘子和苹果橘子混合水果，但三个盒子的标签全都贴错了。你只能从其中一个盒子里伸手摸出一个水果查看，应该摸哪个盒子才能把三个盒子的标签全部推断正确？',
  },
  {
    label: '代码生成测试',
    prompt: '请用 TypeScript 写一个支持 AbortController 取消的轻量级异步请求封装函数。',
  },
];

function formatEffortLabel(effort: string, defaultEffort?: string | null): string {
  if (effort === 'auto') {
    return defaultEffort ? `默认 (${defaultEffort})` : '默认';
  }
  return EFFORT_LABELS[effort] ? `${EFFORT_LABELS[effort]} · ${effort}` : effort;
}

function formatEffortCompact(effort: string, defaultEffort?: string | null): string {
  if (effort === 'auto') {
    return defaultEffort ? `默认 (${EFFORT_LABELS[defaultEffort] ?? defaultEffort})` : '默认';
  }
  return EFFORT_LABELS[effort] ?? effort;
}

export function ChatPlayground({
  serverUrl,
  apiKey,
  models,
  isQuotaExhausted,
  initialModelId,
  onNotify,
}: ChatPlaygroundProps) {
  const [selectedModelId, setSelectedModelId] = useState<string>(
    () => initialModelId || models[0]?.id || '',
  );
  const [reasoningEffort, setReasoningEffort] = useState<string>('auto');
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Sync external initialModelId navigation (e.g. clicking "去对话测试" on a model row)
  useEffect(() => {
    if (initialModelId && models.some((m) => m.id === initialModelId)) {
      setSelectedModelId(initialModelId);
    }
  }, [initialModelId, models]);

  // Keep selectedModelId valid when model list updates via SSE
  useEffect(() => {
    if (models.length === 0) {
      setSelectedModelId('');
      return;
    }
    if (!models.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(models[0].id);
    }
  }, [models, selectedModelId]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );

  const availableEfforts = useMemo(() => {
    if (!selectedModel) return [];
    if (Array.isArray(selectedModel.supportedReasoningEfforts)) {
      return selectedModel.supportedReasoningEfforts;
    }
    if (selectedModel.id.toLowerCase().includes('image')) {
      return [];
    }
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  }, [selectedModel]);

  // Reset reasoningEffort if newly chosen model doesn't support the active effort
  useEffect(() => {
    if (
      reasoningEffort !== 'auto' &&
      !availableEfforts.includes(reasoningEffort)
    ) {
      setReasoningEffort('auto');
    }
  }, [availableEfforts, reasoningEffort]);

  // Abort in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Auto-scroll message viewport cleanly inside its own container
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const handleClear = useCallback(() => {
    if (streaming) return;
    setMessages([]);
  }, [streaming]);

  const sendPrompt = useCallback(
    async (promptText: string) => {
      const trimmed = promptText.trim();
      if (!trimmed || streaming) return;
      if (!selectedModelId) {
        onNotify('当前没有可用的授权模型，请先联系管理员分配模型权限', 'error');
        return;
      }
      if (!apiKey) {
        onNotify('未检测到个人 API Key，请刷新重试', 'error');
        return;
      }
      if (isQuotaExhausted) {
        onNotify('本周滚动额度已用尽，暂无法发起模型对话', 'error');
        return;
      }

      const effortToSend =
        availableEfforts.length > 0 && reasoningEffort !== 'auto'
          ? reasoningEffort
          : undefined;

      const userTurnId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const assistantTurnId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const now = Date.now();

      const historyForApi = [
        ...messages
          .filter((m) => !m.error && m.content.trim().length > 0)
          .map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: trimmed },
      ];

      const modelMult = selectedModel?.multiplier ?? 1;
      const effectiveEffortLabel = effortToSend
        ? effortToSend
        : availableEfforts.length > 0
          ? `默认${selectedModel?.defaultReasoningEffort ? ` (${selectedModel.defaultReasoningEffort})` : ''}`
          : undefined;

      setInput('');
      setStreaming(true);
      setMessages((prev) => [
        ...prev,
        {
          id: userTurnId,
          role: 'user',
          content: trimmed,
          createdAt: now,
        },
        {
          id: assistantTurnId,
          role: 'assistant',
          content: '',
          reasoningContent: '',
          modelId: selectedModelId,
          reasoningEffort: effectiveEffortLabel,
          multiplier: modelMult,
          streaming: true,
          createdAt: now,
        },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      const startedAt = performance.now();

      const endpoint = `${normalizeServerUrl(serverUrl)}/v1/chat/completions`;
      const payload: Record<string, unknown> = {
        model: selectedModelId,
        messages: historyForApi,
        stream: true,
      };
      if (effortToSend) {
        payload.reasoning_effort = effortToSend;
      }

      const patchAssistant = (updater: (cur: ChatTurn) => ChatTurn) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantTurnId ? updater(m) : m)),
        );
      };

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          let errMsg = `HTTP ${res.status}`;
          try {
            const errJson = (await res.json()) as {
              error?: string | { message?: string };
            };
            if (typeof errJson.error === 'string' && errJson.error) {
              errMsg = errJson.error;
            } else if (
              errJson.error &&
              typeof errJson.error === 'object' &&
              errJson.error.message
            ) {
              errMsg = errJson.error.message;
            }
          } catch {
            // Keep HTTP status fallback
          }
          const latencyMs = Math.round(performance.now() - startedAt);
          patchAssistant((cur) => ({
            ...cur,
            streaming: false,
            error: errMsg,
            latencyMs,
          }));
          onNotify(`模型测试失败：${errMsg}`, 'error');
          return;
        }

        const contentType = (res.headers.get('content-type') || '').toLowerCase();

        // Fallback for non-SSE JSON responses
        if (!contentType.includes('text/event-stream') || !res.body) {
          const data = (await res.json()) as {
            choices?: Array<{
              message?: { content?: string; reasoning_content?: string };
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };
          const replyText = data.choices?.[0]?.message?.content || '';
          const reasoningText = data.choices?.[0]?.message?.reasoning_content || '';
          const totalTokens = Number(data.usage?.total_tokens) || 0;
          const latencyMs = Math.round(performance.now() - startedAt);
          patchAssistant((cur) => ({
            ...cur,
            content: replyText || '（模型返回空响应）',
            reasoningContent: reasoningText,
            streaming: false,
            latencyMs,
            promptTokens: Number(data.usage?.prompt_tokens) || undefined,
            completionTokens: Number(data.usage?.completion_tokens) || undefined,
            totalTokens: totalTokens || undefined,
            weightedTokens:
              totalTokens > 0 ? Math.ceil(totalTokens * modelMult) : undefined,
          }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accContent = '';
        let accReasoning = '';
        let usage:
          | {
              promptTokens: number;
              completionTokens: number;
              totalTokens: number;
            }
          | undefined;

        const processLine = (rawLine: string) => {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) return;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') return;

          try {
            const parsed = JSON.parse(jsonStr) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  reasoning?: string;
                };
              }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
              };
            };

            const delta = parsed.choices?.[0]?.delta;
            let dirty = false;
            if (typeof delta?.content === 'string' && delta.content.length > 0) {
              accContent += delta.content;
              dirty = true;
            }
            const rChunk =
              typeof delta?.reasoning_content === 'string'
                ? delta.reasoning_content
                : typeof delta?.reasoning === 'string'
                  ? delta.reasoning
                  : '';
            if (rChunk) {
              accReasoning += rChunk;
              dirty = true;
            }
            if (parsed.usage && typeof parsed.usage.total_tokens === 'number') {
              usage = {
                promptTokens: Number(parsed.usage.prompt_tokens) || 0,
                completionTokens: Number(parsed.usage.completion_tokens) || 0,
                totalTokens: Number(parsed.usage.total_tokens) || 0,
              };
            }

            if (dirty) {
              patchAssistant((cur) => ({
                ...cur,
                content: accContent,
                reasoningContent: accReasoning,
              }));
            }
          } catch {
            // Skip partial or non-JSON keepalive events
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const l of lines) {
              processLine(l);
            }
          }
          if (done) break;
        }
        if (buffer.trim()) {
          processLine(buffer);
        }

        const latencyMs = Math.round(performance.now() - startedAt);
        patchAssistant((cur) => ({
          ...cur,
          content: accContent || cur.content || '（模型未输出文本内容）',
          reasoningContent: accReasoning || cur.reasoningContent,
          streaming: false,
          latencyMs,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          weightedTokens:
            usage && usage.totalTokens > 0
              ? Math.ceil(usage.totalTokens * modelMult)
              : undefined,
        }));
      } catch (err) {
        const latencyMs = Math.round(performance.now() - startedAt);
        if (err instanceof DOMException && err.name === 'AbortError') {
          patchAssistant((cur) => ({
            ...cur,
            streaming: false,
            content: cur.content ? `${cur.content}\n\n（已手动停止生成）` : '（已手动停止生成）',
            latencyMs,
          }));
          return;
        }
        const errMsg = err instanceof Error ? err.message : '网络请求异常';
        patchAssistant((cur) => ({
          ...cur,
          streaming: false,
          error: errMsg,
          latencyMs,
        }));
        onNotify(`模型请求失败：${errMsg}`, 'error');
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [
      apiKey,
      availableEfforts.length,
      isQuotaExhausted,
      messages,
      onNotify,
      reasoningEffort,
      selectedModel,
      selectedModelId,
      serverUrl,
      streaming,
    ],
  );

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    void sendPrompt(input);
  }

  // IME-safe Enter submission per modern-web-guidance (ime-safe-enter-submit)
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className="chat-playground">
      {/* Model & Reasoning Effort Toolbar */}
      <div className="chat-toolbar">
        <div className="chat-toolbar-group">
          <label htmlFor="chat-model-select" className="chat-toolbar-label">
            测试模型
          </label>
          <select
            id="chat-model-select"
            className="select mono chat-model-select"
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
            disabled={streaming || models.length === 0}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} · {formatMultiplier(m.multiplier)}
              </option>
            ))}
            {models.length === 0 && <option value="">暂无授权模型</option>}
          </select>
        </div>

        <div className="chat-toolbar-group chat-effort-group">
          <span className="chat-toolbar-label">思考强度</span>
          {availableEfforts.length > 0 ? (
            <div className="segmented-control chat-effort-control" role="group" aria-label="选择模型思考强度">
              <button
                type="button"
                className="segment-btn"
                aria-pressed={reasoningEffort === 'auto'}
                disabled={streaming}
                title={`使用模型默认思考强度 (${selectedModel?.defaultReasoningEffort || 'auto'})`}
                onClick={() => setReasoningEffort('auto')}
              >
                {formatEffortCompact('auto', selectedModel?.defaultReasoningEffort)}
              </button>
              {availableEfforts.map((effort) => (
                <button
                  key={effort}
                  type="button"
                  className="segment-btn"
                  aria-pressed={reasoningEffort === effort}
                  disabled={streaming}
                  title={`reasoning_effort: ${effort}`}
                  onClick={() => setReasoningEffort(effort)}
                >
                  {formatEffortCompact(effort)}
                </button>
              ))}
            </div>
          ) : (
            <span className="badge">当前模型不支持思考强度参数</span>
          )}
        </div>

        <div className="chat-toolbar-actions">
          {streaming ? (
            <button type="button" className="btn btn-sm" onClick={handleStop}>
              停止生成
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              disabled={messages.length === 0}
              onClick={handleClear}
            >
              清空对话
            </button>
          )}
        </div>
      </div>

      {/* Chat Messages Viewport */}
      <div
        ref={viewportRef}
        className="chat-viewport"
        role="log"
        aria-live="polite"
        aria-label="AI 对话测试记录"
      >
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">AI 模型在线调试对话台</div>
            <p className="chat-empty-desc">
              直接通过网关 <code>/v1/chat/completions</code> 实时验证{' '}
              <strong className="mono">{selectedModelId || '所选模型'}</strong> 的可用性与响应速度
              {availableEfforts.length > 0 && (
                <>
                  ，当前思考强度：
                  <strong>
                    {formatEffortLabel(reasoningEffort, selectedModel?.defaultReasoningEffort)}
                  </strong>
                </>
              )}
              。每次真实对话会实时计入您的 7×24h 滚动额度与下方调用流水。
            </p>
            <div className="chat-quick-prompts">
              {QUICK_PROMPTS.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="btn btn-sm"
                  disabled={streaming || !selectedModelId || isQuotaExhausted}
                  onClick={() => void sendPrompt(item.prompt)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-messages">
            {messages.map((turn) => (
              <div
                key={turn.id}
                className={`chat-bubble-row ${
                  turn.role === 'user' ? 'chat-bubble-row--user' : 'chat-bubble-row--assistant'
                }`}
              >
                {turn.role === 'user' ? (
                  <div className="chat-bubble chat-bubble--user">
                    <div className="chat-bubble-text">{turn.content}</div>
                  </div>
                ) : (
                  <article
                    className={`chat-bubble chat-bubble--assistant ${
                      turn.error ? 'chat-bubble--error' : ''
                    }`}
                  >
                    <div className="chat-bubble-head">
                      <div className="chat-bubble-badges">
                        <span className="badge badge--accent mono">{turn.modelId}</span>
                        {turn.reasoningEffort && (
                          <span className="badge">思考: {turn.reasoningEffort}</span>
                        )}
                        {turn.streaming ? (
                          <span className="badge badge--warn">响应中...</span>
                        ) : turn.error ? (
                          <span className="badge badge--danger">调用失败</span>
                        ) : (
                          <span className="badge badge--ok">可用</span>
                        )}
                      </div>
                      {!turn.streaming && !turn.error && turn.content && (
                        <CopyButton
                          targetId={`chat-msg-${turn.id}`}
                          textOverride={turn.content}
                          label="复制回复内容"
                          compact
                        />
                      )}
                    </div>

                    {turn.reasoningContent && turn.reasoningContent.trim().length > 0 && (
                      <details className="chat-reasoning-details">
                        <summary>思考过程（{turn.reasoningContent.length} 字符）</summary>
                        <pre className="chat-reasoning-pre">{turn.reasoningContent}</pre>
                      </details>
                    )}

                    {turn.error ? (
                      <div className="chat-error-text">{turn.error}</div>
                    ) : (
                      <div id={`chat-msg-${turn.id}`} className="chat-bubble-text">
                        {turn.content || (turn.streaming ? '正在等待模型首字响应...' : '')}
                        {turn.streaming && <span className="chat-cursor" aria-hidden="true" />}
                      </div>
                    )}

                    {!turn.streaming && (turn.latencyMs !== undefined || turn.totalTokens) && (
                      <div className="chat-meta-row mono">
                        {turn.latencyMs !== undefined && <span>耗时 {turn.latencyMs}ms</span>}
                        {turn.totalTokens !== undefined && turn.totalTokens > 0 && (
                          <span>
                            Token {formatTokens(turn.totalTokens)}（入{' '}
                            {formatTokens(turn.promptTokens ?? 0)} / 出{' '}
                            {formatTokens(turn.completionTokens ?? 0)}）·{' '}
                            {formatMultiplier(turn.multiplier ?? 1)} · 扣减{' '}
                            {formatTokens(turn.weightedTokens ?? 0)}
                          </span>
                        )}
                      </div>
                    )}
                  </article>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Composer Form (IME-safe Enter submit) */}
      <form className="chat-composer" onSubmit={handleFormSubmit}>
        <label htmlFor="chat-prompt-input" className="visually-hidden">
          输入测试提问内容
        </label>
        <textarea
          id="chat-prompt-input"
          className="chat-textarea"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isQuotaExhausted
              ? '本周滚动额度已用尽，暂停模型对话测试'
              : '输入消息测试模型可用性…（Enter 发送，Shift + Enter 换行）'
          }
          disabled={models.length === 0 || isQuotaExhausted}
        />
        <div className="chat-composer-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={streaming || !selectedModelId || isQuotaExhausted}
            onClick={() => void sendPrompt(QUICK_PROMPTS[0].prompt)}
            title="一键发送连通性探测消息"
          >
            快速测通
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={streaming || !input.trim() || !selectedModelId || isQuotaExhausted}
          >
            {streaming ? '生成中...' : '发送'}
          </button>
        </div>
      </form>
    </div>
  );
}
