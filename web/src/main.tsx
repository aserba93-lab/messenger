import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

class RootErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error(err, info.componentStack);
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui", background: "#1a1a1a", color: "#e0e0e0", minHeight: "100vh" }}>
          <h1 style={{ color: "#ff8a80", fontSize: 18 }}>Ошибка загрузки приложения</h1>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 12 }}>{String(this.state.err.stack || this.state.err.message)}</pre>
          <p style={{ fontSize: 12, opacity: 0.8, marginTop: 16 }}>
            Если белый экран без текста — откройте F12 → Network и проверьте, что файл <code>/assets/index-….js</code> отдаётся с кодом 200 (часто
            забыли залить папку <code>assets</code> на сервер).
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Элемент #root не найден в index.html");

/** Снимаем старые SW (если когда-либо регистрировали PWA) — иначе «Домой» может держать старый кэш. */
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const r of regs) void r.unregister();
  });
}

createRoot(rootEl).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
