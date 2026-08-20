import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export interface ToastState {
  message: string | null;
  variant: "ok" | "error";
  show: (message: string) => void;
  error: (message: string) => void;
  clear: () => void;
}

export function useToast(): ToastState {
  const [message, setMessage] = useState<string | null>(null);
  const [variant, setVariant] = useState<"ok" | "error">("ok");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const arm = useCallback((text: string, kind: "ok" | "error") => {
    setMessage(text);
    setVariant(kind);
    clearTimeout(timer.current);
    // Confirmations restate a member's new standing, which the treasurer may
    // be reading aloud — long enough to finish the sentence.
    timer.current = setTimeout(() => setMessage(null), kind === "error" ? 6000 : 5000);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    message,
    variant,
    show: (text) => arm(text, "ok"),
    error: (text) => arm(text, "error"),
    clear: () => setMessage(null),
  };
}

export function Toast({ state }: { state: ToastState }) {
  if (!state.message) return null;
  return (
    <div
      class={`toast no-print ${state.variant === "error" ? "error" : ""}`}
      role="status"
      onClick={state.clear}
    >
      {state.message}
    </div>
  );
}
