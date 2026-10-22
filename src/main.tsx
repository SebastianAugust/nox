import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { Dashboard } from "./dashboard/Dashboard";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import "./index.css";

// Both windows load this same bundle; pick the view by window label.
const isDashboard = getCurrentWindow().label === "dashboard";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isDashboard ? <Dashboard /> : <App />}</React.StrictMode>,
);
