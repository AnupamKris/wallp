import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowUpRightIcon, ArrowsClockwiseIcon, BluetoothIcon, CaretDownIcon, GearSixIcon, MagnifyingGlassIcon, SlidersHorizontalIcon, SpeakerHighIcon, SpeakerSlashIcon, SunIcon, WifiHighIcon, XIcon } from "@phosphor-icons/react";
import { Slider } from "./components/ui/slider";
import "./QuickSettings.css";

type Control<T> = { value: T | null; error: string | null };
type Status = {
  wifi: Control<boolean>;
  bluetooth: Control<boolean>;
  audio: Control<{ volume: number; muted: boolean }>;
  brightness: Control<number>;
};
type Page = "wifi" | "bluetooth" | "sound" | "display" | "power";
type Setting = { kind: "wifi" | "bluetooth" | "muted"; value: boolean } | { kind: "volume" | "brightness"; value: number };
type Device = { address: string; name: string; paired: boolean; connected: boolean };
type DeviceAction = "pair" | "connect" | "disconnect" | "forget";

// Kept across opens so the panel shows the last known state instantly.
let lastStatus: Status | null = null;
const POLL_MS = 5000;

/** Show the requested value immediately; the confirming read replaces it. */
function predict(status: Status | null, setting: Setting): Status | null {
  if (!status) return status;
  switch (setting.kind) {
    case "wifi": case "bluetooth": return { ...status, [setting.kind]: { value: setting.value, error: null } };
    case "muted": return status.audio.value ? { ...status, audio: { ...status.audio, value: { ...status.audio.value, muted: setting.value } } } : status;
    case "volume": return status.audio.value ? { ...status, audio: { ...status.audio, value: { ...status.audio.value, volume: setting.value } } } : status;
    case "brightness": return { ...status, brightness: { value: setting.value, error: null } };
  }
}

function Level({ label, value, disabled, revision, onCommit }: { label: string; value: number | null; disabled: boolean; revision: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value ?? 0);
  const dragging = useRef(false);
  // Background refreshes must not yank the thumb out from under a drag.
  useEffect(() => { if (!dragging.current) setDraft(value ?? 0); }, [value, revision]);
  return <div className="quick-level">
    <div><span>{label}</span><output>{value === null ? "Unavailable" : `${draft}%`}</output></div>
    <Slider aria-label={label} min={label === "Brightness" ? 1 : 0} max={100} step={1} value={[draft]} disabled={disabled || value === null}
      onValueChange={([next]) => { dragging.current = true; setDraft(next); }} onValueCommit={([next]) => { dragging.current = false; onCommit(next); }} />
  </div>;
}

function BluetoothDevices({ on, onSettings }: { on: boolean; onSettings: () => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async (scan: boolean) => {
    if (scan) setScanning(true);
    try { setDevices(await invoke<Device[]>("bluetooth_devices", { scan })); setError(""); }
    catch (err) { setError(String(err)); }
    finally { if (scan) setScanning(false); }
  }, []);
  // List known devices right away, then look for new ones in the background.
  useEffect(() => {
    if (!on) { setDevices(null); return; }
    void load(false).then(() => load(true));
  }, [on, load]);
  async function act(device: Device, action: DeviceAction) {
    setWorking(device.address); setError("");
    try { await invoke("bluetooth_device", { address: device.address, action }); }
    catch (err) { setError(String(err)); }
    finally { await load(false); setWorking(""); }
  }
  if (!on) return <p className="quick-devices-empty">Turn on Bluetooth to pair and connect devices.</p>;
  const label = (d: Device) => working === d.address ? "Working…" : d.connected ? "Connected" : d.paired ? "Paired" : "Available";
  return <div className="quick-devices">
    <div className="quick-devices-head">
      <span>{scanning ? "Searching for devices…" : "Devices"}</span>
      <button disabled={scanning} onClick={() => void load(true)}><MagnifyingGlassIcon size={13} className={scanning ? "quick-pulse" : ""} />{scanning ? "Scanning" : "Scan"}</button>
    </div>
    {devices?.length === 0 && !scanning && <p className="quick-devices-empty">No devices found. Put your device in pairing mode, then scan.</p>}
    {devices === null && !error && <p className="quick-devices-empty">Loading devices…</p>}
    <ul>
      {devices?.map(d => <li key={d.address} className={d.connected ? "is-connected" : ""}>
        <span><strong>{d.name || d.address}</strong><small>{label(d)}</small></span>
        {d.connected
          ? <button disabled={!!working} onClick={() => void act(d, "disconnect")}>Disconnect</button>
          : d.paired
            ? <><button disabled={!!working} onClick={() => void act(d, "connect")}>Connect</button><button disabled={!!working} onClick={() => void act(d, "forget")}>Forget</button></>
            : <button disabled={!!working} onClick={() => void act(d, "pair")}>Pair</button>}
      </li>)}
    </ul>
    {error && <p className="quick-devices-error" role="alert">{error} <button onClick={onSettings}>System settings<ArrowUpRightIcon size={11} /></button></p>}
  </div>;
}

export function QuickSettings({ active }: { active: boolean }) {
  const native = isTauri();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(lastStatus);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [devicesOpen, setDevicesOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const reading = useRef(false);
  // Bumped by each change so a read that started earlier cannot overwrite it.
  const epoch = useRef(0);
  const read = useCallback(async () => {
    const started = epoch.current;
    const next = await invoke<Status>("quick_settings_status");
    if (started !== epoch.current) return;
    lastStatus = next;
    setStatus(next);
  }, []);
  /** `visible` spins the refresh icon; polling stays silent and never locks controls. */
  const refresh = useCallback(async (visible: boolean) => {
    if (!native || busy.current || reading.current) return;
    reading.current = true;
    if (visible) setLoading(true);
    try { await read(); setError(""); }
    catch (err) { if (visible || !lastStatus) setError(String(err)); }
    finally { reading.current = false; if (visible) setLoading(false); }
  }, [native, read]);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => {
    if (open && active) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open, active]);
  useEffect(() => {
    if (!open || !active) return;
    setError(""); setNotice("");
    void refresh(!lastStatus);
    const timer = setInterval(() => { if (!document.hidden) void refresh(false); }, POLL_MS);
    const focus = () => void refresh(false);
    window.addEventListener("focus", focus);
    return () => { clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [open, active, refresh]);

  async function change(setting: Setting) {
    if (!native || busy.current) return;
    busy.current = true; epoch.current++;
    setPending(setting.kind); setError(""); setNotice("");
    setStatus(current => predict(current, setting));
    try {
      await invoke("set_quick_setting", { setting });
      await read();
      if (setting.kind === "bluetooth" && setting.value) setDevicesOpen(true);
    } catch (err) {
      setError(String(err));
      // Re-read after errors too: hardware may have partially changed.
      try { await read(); } catch { setStatus(null); }
    } finally { setRevision(value => value + 1); busy.current = false; setPending(""); }
  }
  async function settings(page: Page) {
    if (!native || busy.current) return;
    busy.current = true; setPending(page); setError(""); setNotice("");
    try { await invoke("open_system_settings", { page }); setOpen(false); }
    catch (err) { setError(String(err)); }
    finally { busy.current = false; setPending(""); }
  }
  const disabled = !native || !!pending;
  const audio = status?.audio.value;
  const bluetoothOn = status?.bluetooth.value === true;
  function radio(kind: "wifi" | "bluetooth", label: string, Icon: typeof WifiHighIcon, link: ReactNode) {
    const control = status?.[kind];
    const value = control?.value;
    const state = pending === kind ? (value ? "Turning on…" : "Turning off…") : value == null ? (status ? "Unavailable" : "Reading…") : value ? "On" : "Off";
    return <section className={`quick-radio${value === true ? " is-on" : ""}`}>
      <button className="quick-toggle" role="switch" aria-checked={value === true} aria-label={label}
        disabled={disabled || value == null} title={control?.error ?? undefined} onClick={() => void change({ kind, value: !value })}>
        <span className="quick-radio-icon"><Icon size={24} /></span>
        <span><strong>{label}</strong><small>{state}</small></span>
        <span className="quick-switch" aria-hidden="true"><i /></span>
      </button>
      {link}
      {control?.error && <p className="quick-unavailable" title={control.error}>{control.error}</p>}
    </section>;
  }
  return <>
    <button className="tray-launcher quick-launcher" aria-haspopup="dialog" aria-expanded={open} aria-controls="quick-settings-dialog" onClick={() => setOpen(true)}><SlidersHorizontalIcon size={18} />Quick settings</button>
    {createPortal(<dialog id="quick-settings-dialog" className="tray-dialog quick-dialog" ref={dialog} aria-labelledby="quick-settings-title" onClose={() => setOpen(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false);
    }}>
      <header className="tray-heading">
        <div><p className="tray-eyebrow">DEVICE CONTROLS</p><h2 id="quick-settings-title">Quick settings</h2></div>
        <button className="tray-icon-button" aria-label="Refresh quick settings" title="Refresh" disabled={disabled || loading} onClick={() => void refresh(true)}><ArrowsClockwiseIcon size={18} className={loading ? "tray-refreshing" : ""} /></button>
        <button autoFocus className="tray-icon-button" aria-label="Close quick settings" onClick={() => setOpen(false)}><XIcon size={21} /></button>
      </header>
      <div className="quick-body" aria-busy={loading || !!pending}>
        {!native && <p className="quick-preview">Open wallp on your desktop to control Wi-Fi, Bluetooth, sound, and brightness.</p>}
        <div className="quick-radios">
          {radio("wifi", "Wi-Fi", WifiHighIcon, <button className="quick-link" disabled={disabled} onClick={() => void settings("wifi")}>Manage networks<ArrowUpRightIcon size={14} /></button>)}
          {radio("bluetooth", "Bluetooth", BluetoothIcon, <button className="quick-link" disabled={!native} aria-expanded={devicesOpen} aria-controls="quick-bluetooth-devices" onClick={() => setDevicesOpen(value => !value)}>Devices<CaretDownIcon size={13} className={devicesOpen ? "quick-caret is-open" : "quick-caret"} /></button>)}
        </div>
        {devicesOpen && native && <div id="quick-bluetooth-devices"><BluetoothDevices on={bluetoothOn} onSettings={() => void settings("bluetooth")} /></div>}
        <section className="quick-slider-row">
          <button className="quick-audio-icon" aria-label={audio?.muted ? "Unmute sound" : "Mute sound"} aria-pressed={audio?.muted ?? false} title={status?.audio.error || (audio?.muted ? "Unmute" : "Mute")} disabled={disabled || !audio} onClick={() => void change({ kind: "muted", value: !audio?.muted })}>
            {audio?.muted ? <SpeakerSlashIcon size={24} /> : <SpeakerHighIcon size={24} />}
          </button>
          <Level label={audio?.muted ? "Volume (muted)" : "Volume"} value={audio?.volume ?? null} disabled={disabled} revision={revision} onCommit={value => void change({ kind: "volume", value })} />
        </section>
        {status?.audio.error && <p className="quick-unavailable">{status.audio.error}</p>}
        <section className="quick-slider-row"><SunIcon size={24} className="quick-sun" />
          <Level label="Brightness" value={status?.brightness.value ?? null} disabled={disabled} revision={revision} onCommit={value => void change({ kind: "brightness", value })} />
        </section>
        {status?.brightness.error && <p className="quick-unavailable" title={status.brightness.error}>Brightness needs a supported display backlight{status.brightness.error.includes("brightnessctl") ? " and brightnessctl" : ""}.</p>}
        <div className="quick-shortcuts">
          <button disabled={disabled} onClick={() => void settings("sound")}><SpeakerHighIcon size={16} />Sound<ArrowUpRightIcon size={13} /></button>
          <button disabled={disabled} onClick={() => void settings("display")}><SunIcon size={16} />Display<ArrowUpRightIcon size={13} /></button>
          <button disabled={disabled} onClick={() => void settings("power")}><GearSixIcon size={16} />Power<ArrowUpRightIcon size={13} /></button>
        </div>
      </div>
      <footer className="tray-footer quick-footer">
        {error && <p className="tray-error" role="alert">{error}</p>}
        <p role="status">{pending ? "Applying change…" : loading ? "Reading device settings…" : notice || (native ? "Live · updates automatically" : "Desktop controls are unavailable in browser preview")}</p>
      </footer>
    </dialog>, document.body)}
  </>;
}
