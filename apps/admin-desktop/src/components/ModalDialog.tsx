import { useEffect, useRef, useState, type ReactNode } from 'react';

let supportsDisplayTransitionCache: boolean | undefined;

function canTransitionDisplay(): boolean {
  if (supportsDisplayTransitionCache !== undefined) {
    return supportsDisplayTransitionCache;
  }
  if (
    !window.CSS?.supports?.('transition-behavior', 'allow-discrete') ||
    !document.body
  ) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText =
    'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransitionCache = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransitionCache;
}

function supportsTopLayerExit(): boolean {
  return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

async function closeTopLayer(dialog: HTMLDialogElement): Promise<void> {
  if (!dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise<void>((resolve) => setTimeout(resolve, 600)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  if (dialog.open) {
    dialog.close();
  }
}

interface ModalDialogProps {
  open: boolean;
  titleId: string;
  title: string;
  onClose: () => void;
  lightDismiss?: boolean;
  wide?: boolean;
  children: ReactNode;
}

/**
 * Native modal `<dialog>` with smooth top-layer entry/exit animation,
 * `cancel` interception, returnValue cleanup, and `closedby="any"` fallback.
 */
export function ModalDialog({
  open,
  titleId,
  title,
  onClose,
  lightDismiss = true,
  wide = false,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [renderContent, setRenderContent] = useState(open);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setRenderContent(true);
      dialog.removeAttribute('data-closing');
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      void closeTopLayer(dialog);
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.removeAttribute('data-closing');
      dialog.returnValue = '';
      setRenderContent(false);
      onCloseRef.current();
    };

    const handleCancel = (event: Event) => {
      event.preventDefault();
      void closeTopLayer(dialog);
    };

    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);

    const isOutside = (e: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      );
    };
    let pressedOutside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (lightDismiss && pressedOutside && isOutside(e)) {
        void closeTopLayer(dialog);
      }
      pressedOutside = false;
    };

    if (lightDismiss && !('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('pointerdown', onPointerDown);
      dialog.addEventListener('pointerup', onPointerUp);
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, [lightDismiss]);

  const extraAttrs: Record<string, string> = {
    closedby: lightDismiss ? 'any' : 'closerequest',
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={wide ? 'modal-dialog modal-dialog--wide' : 'modal-dialog'}
      {...extraAttrs}
    >
      <div className="modal-header">
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <button
          type="button"
          className="btn-icon"
          aria-label="关闭弹窗"
          onClick={() => {
            if (dialogRef.current) {
              void closeTopLayer(dialogRef.current);
            }
          }}
        >
          ×
        </button>
      </div>
      <div className="modal-body">{renderContent ? children : null}</div>
    </dialog>
  );
}
