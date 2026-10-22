import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { Dashboard } from "./dashboard/Dashboard";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
// Fonts are bundled (the CSP allows no remote fonts). Latin covers en + id.
import "@fontsource/fredoka/latin-500.css";
import "@fontsource/fredoka/latin-600.css";
import "@fontsource/fredoka/latin-700.css";
import "@fontsource/nunito/latin-600.css";
import "@fontsource/nunito/latin-700.css";
import "@fontsource/nunito/latin-800.css";
import "@fontsource/pixelify-sans/latin-500.css";
import "@fontsource/pixelify-sans/latin-600.css";
import "@fontsource/pixelify-sans/latin-700.css";
import "./styles/tokens.css";
import "./styles/motion.css";
import "./styles/ui.css";
import "./index.css";

// Both windows load this same bundle; pick the view by window label.
const isDashboard = getCurrentWindow().label === "dashboard";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isDashboard ? <Dashboard /> : <App />}</React.StrictMode>,
);
