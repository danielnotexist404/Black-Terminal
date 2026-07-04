import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerBlackCoreServices } from "./core/registerBlackCore";
import "./styles/theme.css";

registerBlackCoreServices();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
