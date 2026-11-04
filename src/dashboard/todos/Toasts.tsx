import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { ChunkyButton } from "../../components/ui/controls";

export type Toast = { id: number; text: string; tone: "info" | "error"; undo?: () => void };

export const TOAST_MS = 5000;

/** Toasts with an optional Undo, each gone after about five seconds. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((all) => all.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = next.current++;
      // One at a time keeps Undo unambiguous: the newest replaces the rest.
      timers.current.forEach((timer) => clearTimeout(timer));
      timers.current.clear();
      setToasts([{ ...toast, id }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), TOAST_MS));
    },
    [dismiss],
  );

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((timer) => clearTimeout(timer));
  }, []);

  return { toasts, show, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          <span className="toast__text">{toast.text}</span>
          {toast.undo && (
            <ChunkyButton
              size="sm"
              onClick={() => {
                toast.undo!();
                onDismiss(toast.id);
              }}
            >
              <i className="ti ti-arrow-back-up" aria-hidden="true" /> {t("todo.undo")}
            </ChunkyButton>
          )}
          <button type="button" className="toast__close" aria-label={t("todo.toast.dismiss")} onClick={() => onDismiss(toast.id)}>
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
