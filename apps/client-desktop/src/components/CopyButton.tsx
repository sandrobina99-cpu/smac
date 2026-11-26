import { useEffect } from 'react';

const timers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
let lastAnnouncement = '';
let listenersInstalled = false;

function legacyCopy(text: string): boolean {
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
  }
}

function reportCopyState(button: HTMLButtonElement, ok: boolean): void {
  const tip = button.nextElementSibling as HTMLElement | null;
  const prevTimer = timers.get(button);
  if (prevTimer) clearTimeout(prevTimer);

  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');

  let message = ok ? '已复制' : '复制失败';
  if (message === lastAnnouncement) {
    message += '\u00A0';
  }
  lastAnnouncement = message;

  if (tip) tip.textContent = '';
  void button.offsetWidth;
  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  requestAnimationFrame(() => {
    if (tip) tip.textContent = message;
  });

  timers.set(
    button,
    setTimeout(() => {
      button.removeAttribute('data-copied');
      button.removeAttribute('data-failed');
      if (tip) tip.textContent = '';
    }, 2000),
  );
}

async function performCopy(button: HTMLButtonElement, target: Element): Promise<void> {
  const rawFromAttr = button.getAttribute('data-copy-value');
  const text =
    rawFromAttr !== null
      ? rawFromAttr
      : target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target.value
        : (target as HTMLElement).innerText.trim();
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      reportCopyState(button, true);
      return;
    }
    throw new Error('Clipboard API unavailable');
  } catch {
    if (window.desktopBridge?.copyText) {
      const ok = await window.desktopBridge.copyText(text);
      reportCopyState(button, ok);
      return;
    }
    reportCopyState(button, legacyCopy(text));
  }
}

function ensureCopyCommandListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  document.addEventListener(
    'command',
    (event: Event) => {
      const cmdEvent = event as Event & {
        command?: string;
        source?: Element | null;
      };
      if (
        cmdEvent.command?.startsWith('--copy') &&
        cmdEvent.source instanceof HTMLButtonElement &&
        cmdEvent.target instanceof Element
      ) {
        void performCopy(cmdEvent.source, cmdEvent.target);
      }
    },
    true,
  );

  if (!('CommandEvent' in window)) {
    document.addEventListener('click', (event) => {
      const targetEl = event.target as Element | null;
      const button = targetEl?.closest('button[command^="--copy"]');
      if (!(button instanceof HTMLButtonElement)) return;
      const forId = button.getAttribute('commandfor');
      if (!forId) return;
      const target = document.getElementById(forId);
      if (target) {
        void performCopy(button, target);
      }
    });
  }
}

interface CopyButtonProps {
  targetId: string;
  label: string;
  textOverride?: string;
  compact?: boolean;
}

/**
 * Accessible copy button following Invoker Commands (`command` + `commandfor`)
 * with feature-detected fallback and an external `role="status"` live tip.
 */
export function CopyButton({
  targetId,
  label,
  textOverride,
  compact = false,
}: CopyButtonProps) {
  useEffect(() => {
    ensureCopyCommandListeners();
  }, []);

  const extraAttrs: Record<string, string> = {
    command: '--copy',
    commandfor: targetId,
  };
  if (textOverride !== undefined) {
    extraAttrs['data-copy-value'] = textOverride;
  }

  return (
    <span className="copy-wrap">
      <button
        type="button"
        className={compact ? 'copy-button copy-button--compact' : 'copy-button'}
        aria-label={label}
        title={label}
        {...extraAttrs}
      >
        <span className="copy-icon copy-icon--idle" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </span>
        <span className="copy-icon copy-icon--done" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        {!compact && <span>复制</span>}
      </button>
      <span className="tip" role="status" />
    </span>
  );
}
