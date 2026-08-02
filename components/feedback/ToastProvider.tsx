"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  redoLatest,
  subscribeToUndoHistory,
  undoLatest,
} from "@/lib/undo/undo-service";

export type ToastTone = "success" | "info" | "error";

interface Toast {
  id: string;
  key: string;
  message: string;
  tone: ToastTone;
  action?: { label: string; run: () => Promise<unknown> | unknown };
  actionPending?: boolean;
}

interface ToastContextValue {
  showToast: (
    message: string,
    options?: {
      tone?: ToastTone;
      key?: string;
      durationMs?: number;
      action?: { label: string; run: () => Promise<unknown> | unknown };
    },
  ) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const activeKeys = useRef(new Set<string>());

  const showToast = useCallback<ToastContextValue["showToast"]>(
    (message, options = {}) => {
      const key = options.key ?? message;
      if (activeKeys.current.has(key)) return;
      activeKeys.current.add(key);
      const id = crypto.randomUUID();
      const toast: Toast = {
        id,
        key,
        message,
        tone: options.tone ?? "success",
        action: options.action,
      };
      setToasts((current) => [...current.slice(-2), toast]);
      window.setTimeout(
        () => {
          activeKeys.current.delete(key);
          setToasts((current) => current.filter((item) => item.id !== id));
        },
        options.durationMs ?? (toast.tone === "error" ? 7_000 : 3_500),
      );
    },
    [],
  );

  const dismissToast = useCallback((toast: Toast) => {
    activeKeys.current.delete(toast.key);
    setToasts((current) => current.filter((item) => item.id !== toast.id));
  }, []);

  const runToastAction = useCallback(async (toast: Toast) => {
    if (!toast.action || toast.actionPending) return;
    setToasts((current) =>
      current.map((item) =>
        item.id === toast.id ? { ...item, actionPending: true } : item,
      ),
    );
    try {
      await toast.action.run();
      dismissToast(toast);
    } catch {
      setToasts((current) =>
        current.map((item) =>
          item.id === toast.id ? { ...item, actionPending: false } : item,
        ),
      );
    }
  }, [dismissToast]);

  const dismissUndoToasts = useCallback(() => {
    setToasts((current) => {
      current.forEach((toast) => {
        if (toast.key.startsWith("undo-history:")) {
          activeKeys.current.delete(toast.key);
        }
      });
      return current.filter(
        (toast) => !toast.key.startsWith("undo-history:"),
      );
    });
  }, []);

  useEffect(
    () =>
      subscribeToUndoHistory((event) => {
        if (!event.command || event.kind === "cleared") return;
        dismissUndoToasts();
        if (event.kind === "conflict") {
          showToast(event.message, {
            key: `undo-conflict:${event.command.id}`,
            tone: "error",
            durationMs: 8_000,
          });
          return;
        }
        const offersUndo = event.kind === "recorded" || event.kind === "redone";
        showToast(event.message, {
          key: `undo-history:${event.command.id}:${event.kind}`,
          tone: "info",
          durationMs: 7_000,
          action: {
            label: offersUndo ? "Undo" : "Redo",
            run: offersUndo ? undoLatest : redoLatest,
          },
        });
      }),
    [dismissUndoToasts, showToast],
  );

  useEffect(() => {
    const handleKeyboardHistory = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      void (event.shiftKey ? redoLatest() : undoLatest());
    };
    window.addEventListener("keydown", handleKeyboardHistory);
    return () => window.removeEventListener("keydown", handleKeyboardHistory);
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="toast-region"
        aria-live="polite"
        aria-relevant="additions"
      >
        {toasts.map((toast) => (
          <div
            className={`toast ${toast.tone}`}
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                disabled={toast.actionPending}
                onClick={() => void runToastAction(toast)}
              >
                {toast.actionPending ? "Working..." : toast.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside ToastProvider.");
  }
  return context;
}
