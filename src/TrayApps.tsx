import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { AppWindowIcon, ArrowsClockwiseIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";

type TrayApp = { pid: number; started: string; name: string; tooltip: string; path: string; blockedReason: string | null; icon: string | null };

export function TrayApps({ active }: { active: boolean }) {
  const [apps, setApps] = useState<TrayApp[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ending, setEnding] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (!isTauri() || busy.current) return;
    busy.current = true;
    setLoading(true);
    try { setApps(await invoke<TrayApp[]>("list_tray_apps")); setError(""); }
    catch (err) { setError(String(err)); }
    finally { busy.current = false; setLoading(false); }
  }, []);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => {
    if (open && active) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open, active]);
  useEffect(() => {
    if (!active || !open) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
    return () => clearInterval(timer);
  }, [active, open, refresh]);

  async function endApp(app: TrayApp) {
    if (busy.current || ending !== null) return;
    busy.current = true;
    setEnding(app.pid); setError(""); setNotice("");
    try {
      await invoke("end_tray_app", { pid: app.pid, started: app.started });
      setApps(current => current.filter(item => item.pid !== app.pid));
      setNotice(`Ended ${app.name}`);
    } catch (err) { setError(String(err)); }
    finally { busy.current = false; setEnding(null); }
  }

  return <>
    <button className="tray-launcher" aria-label="System tray" title="System tray" aria-haspopup="dialog" aria-expanded={open} aria-controls="tray-dialog" onClick={() => setOpen(true)}><SquaresFourIcon size={18} /><span className="tray-launcher-label">System tray</span></button>
    {createPortal(<dialog id="tray-dialog" className="tray-dialog" ref={dialog} aria-labelledby="tray-title" aria-describedby="tray-hint" onClose={() => setOpen(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false);
    }}>
      <header className="tray-heading">
        <div><p className="tray-eyebrow">BACKGROUND APPS</p><h2 id="tray-title">System tray <span className="tray-count">{isTauri() ? apps.length : ""}</span></h2></div>
        <button className="tray-icon-button" title="Refresh tray apps" aria-label="Refresh tray apps" disabled={loading || ending !== null || !isTauri()} onClick={() => void refresh()}><ArrowsClockwiseIcon size={20} className={loading ? "tray-refreshing" : ""} /></button>
        <button autoFocus className="tray-icon-button" title="Close" aria-label="Close system tray" onClick={() => setOpen(false)}><XIcon size={22} /></button>
      </header>
      <p id="tray-hint" className="tray-hint">Manage the apps running in your system tray. End task stops an app immediately; unsaved work may be lost.</p>
      {!isTauri() ? <p className="tray-message">Open wallp on your desktop to see tray apps.</p> : <>
        <ul className="tray-apps" aria-busy={loading}>
          {apps.map(app => <li key={`${app.pid}:${app.started}`}>
            <div className="tray-app-icon" aria-hidden="true">{app.icon ? <img src={app.icon} alt="" onError={event => { event.currentTarget.style.display = "none"; }} /> : <AppWindowIcon size={32} />}</div>
            <div className="tray-app-info" title={`${app.tooltip}\n${app.path}\nPID ${app.pid}`}>
              <span>{app.name.replace(/\.exe$/i, "")}</span><small>{app.tooltip || `PID ${app.pid}`}</small>
            </div>
            <div className="tray-app-actions"><small>{app.blockedReason || `PID ${app.pid}`}</small>
              <button className="tray-end" disabled={!!app.blockedReason || ending !== null || loading} title={app.blockedReason || `Force end ${app.name}`} aria-label={`End task: ${app.name}`} onClick={() => void endApp(app)}>{ending === app.pid ? "Ending..." : <><XIcon size={14} />End task</>}</button>
            </div>
          </li>)}
        </ul>
        {!apps.length && !error && <p className="tray-message">{loading ? "Reading system tray..." : "No running tray apps found."}</p>}
      </>}
      <footer className="tray-footer">{error && <p className="tray-error" role="alert">{error}</p>}<p role="status">{notice || (loading ? "Refreshing apps..." : "Refreshes every 10 seconds while open")}</p></footer>
    </dialog>, document.body)}
  </>;
}
