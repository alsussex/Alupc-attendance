"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "success" | "info" | "error";

interface Toast {
  id: string;
  key: string;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  showToast: (
    message: string,
    options?: { tone?: ToastTone; key?: string; durationMs?: number },
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
            {toast.message}
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
