import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerBlackCoreServices } from "./core/registerBlackCore";
import { blackCorePerformanceMonitor } from "./performance/performanceMonitor";
import "./styles/theme.css";

registerBlackCoreServices();

if (window.location.hostname === "127.0.0.1" && new URLSearchParams(window.location.search).get("perfHarness") === "1") {
  (window as Window & { __BLACK_TERMINAL_PERFORMANCE__?: typeof blackCorePerformanceMonitor }).__BLACK_TERMINAL_PERFORMANCE__ = blackCorePerformanceMonitor;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <React.Profiler id="BlackTerminal" onRender={(_id, phase, actualDuration, baseDuration) => {
      blackCorePerformanceMonitor.recordMetric("react.commit_ms", actualDuration, "ms", { phase });
      blackCorePerformanceMonitor.recordMetric("react.base_duration_ms", baseDuration, "ms", { phase });
    }}>
      <App />
    </React.Profiler>
  </React.StrictMode>
);
