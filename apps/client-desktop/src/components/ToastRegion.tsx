import { useEffect, useRef } from 'react';

export interface ToastItem {
  id: string;
  tone: 'success' | 'error' | 'info';
  message: string;
}

interface ToastRegionProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('popover', 'manual');
    try {
      el.showPopover?.();
    } catch {
      // Fallback when popover API is unavailable
    }

    const docAny = document as Document & {
      ariaNotify?: (text: string) => void;
    };
    docAny.ariaNotify?.(toast.message);

    const timer = setInterval(() => {
      if (!pausedRef.current) {
        clearInterval(timer);
        onDismiss(toast.id);
      }
    }, 4200);

    return () => {
      clearInterval(timer);
      try {
        el.hidePopover?.();
      } catch {
        // ignore
      }
    };
  }, [toast.id, toast.message, onDismiss]);

  return (
    <div
      ref={ref}
      id={`toast-${toast.id}`}
      className={`toast toast--${toast.tone}`}
      onFocusCapture={() => {
        pausedRef.current = true;
      }}
      onBlurCapture={() => {
        pausedRef.current = false;
      }}
    >
      <span className="toast-text">{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭通知"
        popoverTarget={`toast-${toast.id}`}
        popoverTargetAction="hide"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/**
 * Top-layer non-intrusive toast stack using `popover="manual"` and ARIA fallback announcements.
 */
export function ToastRegion({ toasts, onDismiss }: ToastRegionProps) {
  const latestMessage = toasts[toasts.length - 1]?.message || '';
  return (
    <>
      <div role="region" aria-label="系统通知" className="toast-region">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
      <div className="visually-hidden" aria-live="polite">
        {latestMessage}
      </div>
    </>
  );
}
