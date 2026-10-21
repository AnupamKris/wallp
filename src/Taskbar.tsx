import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DesktopIcon, SquaresFourIcon, AppWindowIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";

import { reconcileWindows } from "./dock-windows";

type AppWindow = { id: string; pid: number; title: string; active: boolean; minimized: boolean; icon: string | null };
export function TaskbarControl() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscription = listen<boolean>("taskbar://enabled", event => { if (!disposed) setEnabled(event.payload); });
    const errors = listen<string>("taskbar://error", event => { if (!disposed) setError(event.payload); });
    void invoke<boolean>("taskbar_enabled").then(value => { if (!disposed) setEnabled(value); }).catch(err => { if (!disposed) setError(String(err)); });
    return () => { disposed = true; void subscription.then(unlisten => unlisten()); void errors.then(unlisten => unlisten()); };
  }, []);
  return <div className="taskbar-control">
    <button disabled={busy || !isTauri()} aria-pressed={enabled} title={!isTauri() ? "Available in the desktop app" : undefined} onClick={async () => {
      setBusy(true); setError("");
      try { const value = await invoke<boolean>("set_taskbar_enabled", { enabled: !enabled }); if (!value) setEnabled(false); }
      catch (err) { setError(String(err)); }
      finally { setBusy(false); }
    }}><DesktopIcon size={16} />{busy ? "Updating dock…" : enabled ? "Restore Windows taskbar" : "Use wallp dock"}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
export function Taskbar() {
  const [windows, setWindows] = useState<AppWindow[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    document.documentElement.classList.add("dock-view");
    return () => document.documentElement.classList.remove("dock-view");
  }, []);
  useEffect(() => {
    if (isTauri()) void invoke("resize_dock", { width: (3 + windows.length) * 52 + 64 }).catch(err => setError(String(err)));
  }, [windows.length]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false, busy = false;
    const refresh = async () => {
      if (busy) return; busy = true;
      try { const result = await invoke<AppWindow[]>("list_app_windows"); if (!disposed) setWindows(previous => reconcileWindows(previous, result)); }
      catch (err) { if (!disposed) setError(String(err)); }
      finally { busy = false; }
    };
    void invoke("taskbar_ready").catch(err => { if (!disposed) setError(String(err)); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  async function run(command: string, args?: Record<string, unknown>) {
    if (!isTauri()) { setError("Open wallp on your desktop to use the dock."); return; }
    try { await invoke(command, args); setError(""); }
    catch (err) { setError(String(err)); }
  }
  return <div className="custom-bar-shell">
    <nav className="custom-bar" aria-label="wallp dock">
      <button title="Search apps (Ctrl + Space)" aria-label="Open command menu" onClick={() => void run("open_launcher")}><MagnifyingGlassIcon size={19} /></button>
      <button className="bar-brand" title="Show desktop" aria-label="Show desktop" onClick={() => void run("show_wallp_desktop", { workspace: false })}><DesktopIcon size={19} /></button>
      <button title="Open workspace" aria-label="Open workspace" onClick={() => void run("show_wallp_desktop", { workspace: true })}><SquaresFourIcon size={19} /></button>
      <span className="bar-divider" />
      <div className="bar-windows" aria-label="Running windows">
        {windows.map(window => <button key={`${window.id}:${window.pid}`} className={`bar-window${window.active ? " active" : ""}`} aria-label={window.title} aria-pressed={window.active} title={`${window.title}${window.minimized ? " · Minimized" : ""}`} onClick={() => void run("activate_app_window", { id: window.id, pid: window.pid })}>{window.icon ? <img src={window.icon} alt="" draggable={false} /> : <AppWindowIcon size={30} />}</button>)}
        {!windows.length && <span className="bar-empty">{isTauri() ? "No open windows" : "Running windows appear in the desktop app"}</span>}
      </div>
      {error && <span className="dock-error" role="alert">{error}</span>}
    </nav>
  </div>;
}
