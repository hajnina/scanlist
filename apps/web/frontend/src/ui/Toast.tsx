/**
 * Toasts: the only "notification" surface in the app.
 *
 * Errors stay long enough to read (8 s), successes are short (4 s). Everything is `role="status"`
 * except errors, which are `role="alert"`, and every toast can be dismissed with the keyboard.
 */

import { useEffect } from "preact/hooks";

export type ToastKind = "info" | "success" | "error";

export interface ToastSpec {
  id: number;
  kind: ToastKind;
  message: string;
}

const LIFETIME_MS: Record<ToastKind, number> = {
  info: 5000,
  success: 4000,
  error: 8000,
};

function Toast(props: { toast: ToastSpec; onDismiss: (id: number) => void }) {
  const { toast, onDismiss } = props;

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), LIFETIME_MS[toast.kind]);
    return () => clearTimeout(timer);
    // `onDismiss` is a pure setState wrapper. Leaving it out of the deps keeps a parent
    // re-render (e.g. a tick) from restarting the countdown of every visible toast.
  }, [toast.id, toast.kind]);

  return (
    <li class={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <span class="toast-glyph" aria-hidden="true">
        {toast.kind === "error" ? "!" : toast.kind === "success" ? "✓" : "i"}
      </span>
      <span class="toast-message">{toast.message}</span>
      <button
        type="button"
        class="toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </li>
  );
}

export function ToastStack(props: { toasts: ToastSpec[]; onDismiss: (id: number) => void }) {
  if (props.toasts.length === 0) return null;
  return (
    <ul class="toast-stack" aria-live="polite">
      {props.toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={props.onDismiss} />
      ))}
    </ul>
  );
}
