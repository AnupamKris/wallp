import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowsClockwiseIcon, BluetoothIcon, GearIcon, SlidersHorizontalIcon, SpeakerHighIcon, SpeakerSlashIcon, SunIcon, WifiHighIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { isLinux } from "./platform";
import "./QuickSettings.css";

const preferenceKey = "wallp.quick-settings";
const preferenceEvent = "wallp:quick-settings";
type Preferences = { windowsPanel: boolean };
function readPreferences() { try { return localStorage.getItem(preferenceKey) || ""; } catch { return ""; } }
function subscribePreferences(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(preferenceEvent, listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener(preferenceEvent, listener); };
}
function usePreferences() {
  const raw = useSyncExternalStore(subscribePreferences, readPreferences);
  const preferences = useMemo<Preferences>(() => {
    // Linux has no shell panel to hand off to.
    try { const value = JSON.parse(raw); return { windowsPanel: !isLinux && value.windowsPanel === true }; }
    catch { return { windowsPanel: false }; }
  }, [raw]);
  const update = (patch: Partial<Preferences>) => {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ ...preferences, ...patch })); window.dispatchEvent(new Event(preferenceEvent)); }
    catch { /* The preferences component reports storage failure below. */ throw new Error("Could not save Quick Settings preferences."); }
  };
  return [preferences, update] as const;
}

export function QuickSettingsOptions() {
  const [preferences, update] = usePreferences();
  const [error, setError] = useState("");
  function save(patch: Partial<Preferences>) { try { update(patch); setError(""); } catch (err) { setError(String(err)); } }
  if (isLinux) return null;
  return <section className="quick-preferences" aria-label="Quick Settings preferences">
    <h3>Quick settings</h3>
    <div className="setting-row toggle-row"><label htmlFor="quick-windows">Use Windows panel<small>Off uses wallp's custom controls. On opens the Windows Win+A panel.</small></label><Switch id="quick-windows" checked={preferences.windowsPanel} onCheckedChange={windowsPanel => save({ windowsPanel })} /></div>
    {error && <p role="alert">{error}</p>}
  </section>;
}

type Radio = { name: string; kind: "wifi" | "bluetooth"; enabled: boolean; controllable: boolean };
type Controls = {
  radios: Radio[]; radioError: string | null;
  audio: { volume: number; muted: boolean } | null; audioError: string | null;
  brightness: number | null; brightnessError: string | null;
};
type Change = { type: "radio"; name: string; kind: string; enabled: boolean } | { type: "volume" | "brightness"; value: number } | { type: "mute"; enabled: boolean };

/** `button` renders a standard outline Button for screens such as Game Mode; `tray` keeps the desktop tray style. */
export function QuickSettings({ active, appearance = "tray" }: { active: boolean; appearance?: "tray" | "button" }) {
  const [preferences] = usePreferences();
  const [open, setOpen] = useState(false);
  const [controls, setControls] = useState<Controls | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const working = useRef(false);
  const dragging = useRef(false);
  const desktop = isTauri();
  const refresh = useCallback(async () => {
    if (!isTauri() || working.current || dragging.current) return;
    working.current = true; setBusy(true);
    try { setControls(await invoke<Controls>("quick_settings_state")); }
    catch (err) { setError(String(err)); }
    finally { working.current = false; setBusy(false); }
  }, []);
  useEffect(() => { if (!active || preferences.windowsPanel) setOpen(false); }, [active, preferences.windowsPanel]);
  useEffect(() => {
    if (!open || !active) return;
    setError(""); setNotice("");
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); dragging.current = false; };
  }, [open, active, refresh]);

  async function change(value: Change) {
    dragging.current = false;
    if (working.current || !desktop) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try { await invoke("set_quick_setting", { change: value }); setNotice("Updated"); }
    catch (err) { setError(String(err)); }
    finally {
      try { setControls(await invoke<Controls>("quick_settings_state")); }
      catch (err) { setError(current => current || String(err)); }
      working.current = false; setBusy(false);
    }
  }
  async function manage(target: string) {
    try { await invoke("quick_settings_manage", { target }); setError(""); }
    catch (err) { setError(String(err)); }
  }
  async function windowsPanel() {
    if (!desktop) { setError("Open wallp on your desktop to use Windows Quick Settings."); return; }
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await invoke("open_quick_settings"); }
    catch (err) { setError(String(err)); }
    finally { working.current = false; setBusy(false); }
  }
  const trigger = (props: { title: string; disabled?: boolean; onClick?: () => void }) => appearance === "button"
    ? <Button variant="outline" {...props}><SlidersHorizontalIcon aria-hidden="true" />Quick settings</Button>
    : <button className="tray-launcher" aria-label="Quick settings" {...props}><SlidersHorizontalIcon size={18} aria-hidden="true" /><span className="tray-launcher-label">Quick settings</span></button>;
  const launcher = trigger({ title: "Wi-Fi, Bluetooth, volume and brightness" });
  if (preferences.windowsPanel) return <div className="quick-launcher-wrap">
    {trigger({ title: "Open Windows Quick Settings (Win+A)", disabled: busy, onClick: () => void windowsPanel() })}
    {error && <p className="quick-launcher-error" role="alert">{error}</p>}
  </div>;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>{launcher}</DialogTrigger>
    <DialogContent className="quick-panel" layout="viewport">
      <header className="quick-heading"><span className="tray-eyebrow">DESKTOP CONTROLS</span><DialogTitle>Quick settings</DialogTitle><DialogDescription>Wireless, sound and display</DialogDescription></header>
      {!desktop && <p className="quick-message">Open wallp on your desktop to control your devices.</p>}
      {desktop && !controls && <p className="quick-message" role="status">{busy ? "Reading device controls…" : "Device controls could not be loaded. Try refresh."}</p>}
      <div className="quick-radios">
        {(["wifi", "bluetooth"] as const).map(kind => {
          const radios = controls?.radios.filter(radio => radio.kind === kind) || [];
          const Icon = kind === "wifi" ? WifiHighIcon : BluetoothIcon;
          const label = kind === "wifi" ? "Wi-Fi" : "Bluetooth";
          return <section key={kind} className="quick-radio-group" aria-label={label}>
            {radios.length ? radios.map(radio => <button key={`${kind}:${radio.name}`} className="quick-tile" aria-pressed={radio.enabled} aria-label={`${label}: ${radio.name}`} disabled={!desktop || busy || !radio.controllable} onClick={() => void change({ type: "radio", name: radio.name, kind, enabled: !radio.enabled })}>
              <Icon size={24} aria-hidden="true" /><span>{label}</span><small>{!radio.controllable ? "Hardware disabled" : radio.enabled ? "On" : "Off"}</small>{radios.length > 1 && <small>{radio.name}</small>}
            </button>) : <div className="quick-tile quick-unavailable"><Icon size={24} aria-hidden="true" /><span>{label}</span><small>{!desktop ? "Desktop app required" : !controls ? "Loading…" : "Unavailable"}</small></div>}
            <button className="quick-link" disabled={!desktop} onClick={() => void manage(kind)}>{kind === "wifi" ? "Manage networks" : "Manage devices"}<span aria-hidden="true">↗</span></button>
          </section>;
        })}
      </div>
      {controls?.radioError && <p className="quick-message">{controls.radioError}</p>}
      <section className="quick-slider-section" aria-label="Sound">
        <div className="quick-slider-heading"><button className="tray-icon-button" disabled={!desktop || busy || !controls?.audio} aria-label={controls?.audio?.muted ? "Unmute audio" : "Mute audio"} aria-pressed={controls?.audio?.muted || false} onClick={() => void change({ type: "mute", enabled: !controls?.audio?.muted })}>{controls?.audio?.muted ? <SpeakerSlashIcon size={22} /> : <SpeakerHighIcon size={22} />}</button><span id="quick-volume-label">Volume</span><output>{controls?.audio ? `${controls.audio.volume}%${controls.audio.muted ? " · Muted" : ""}` : "—"}</output></div>
        <Slider aria-labelledby="quick-volume-label" min={0} max={100} step={1} value={[controls?.audio?.volume || 0]} disabled={!desktop || busy || !controls?.audio} onValueChange={([volume]) => { dragging.current = true; setControls(current => current?.audio ? { ...current, audio: { ...current.audio, volume } } : current); }} onValueCommit={([value]) => void change({ type: "volume", value })} />
        {controls?.audioError && <small>{controls.audioError}</small>}
      </section>
      <section className="quick-slider-section" aria-label="Display">
        <div className="quick-slider-heading"><SunIcon size={22} aria-hidden="true" /><span id="quick-brightness-label">Brightness</span><output>{controls?.brightness != null ? `${controls.brightness}%` : "—"}</output></div>
        <Slider aria-labelledby="quick-brightness-label" min={0} max={100} step={1} value={[controls?.brightness ?? 0]} disabled={!desktop || busy || controls?.brightness == null} onValueChange={([brightness]) => { dragging.current = true; setControls(current => current ? { ...current, brightness } : current); }} onValueCommit={([value]) => void change({ type: "brightness", value })} />
        <small>{controls?.brightnessError || "Controls the supported built-in display. External displays may use their own buttons."}</small>
      </section>
      <nav className="quick-shortcuts" aria-label="More system settings">{[["sound", "Sound"], ["display", "Display"], ["network", "Network"], ["power", "Power"]].map(([target, label]) => <button key={target} disabled={!desktop} onClick={() => void manage(target)}><GearIcon size={14} aria-hidden="true" />{label}</button>)}</nav>
      <footer className="quick-footer"><span role="status">{busy ? "Updating controls…" : notice || "Refreshes while open"}</span><button className="tray-icon-button" aria-label="Refresh Quick Settings" disabled={!desktop || busy} onClick={() => { setError(""); void refresh(); }}><ArrowsClockwiseIcon size={18} className={busy ? "tray-refreshing" : ""} /></button></footer>
      {error && <p className="quick-error" role="alert">{error}</p>}
    </DialogContent>
  </Dialog>;
}
