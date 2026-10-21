import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Taskbar } from "./Taskbar";
import { Launcher } from "./Launcher";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get("view") === "taskbar" ? <Taskbar /> : new URLSearchParams(location.search).get("view") === "launcher" ? <Launcher /> : <App />}
  </React.StrictMode>,
);
