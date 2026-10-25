import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRightIcon, LockSimpleIcon, MagnifyingGlassIcon, WifiHighIcon, WifiLowIcon, WifiMediumIcon, WifiNoneIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Network = { ssid: string; signal: number; security: "open" | "password" | "enterprise"; saved: boolean; connected: boolean };
type Device = { id: string; name: string; paired: boolean; connected: boolean; canConnect: boolean };
type DeviceAction = "pair" | "connect" | "disconnect" | "forget";

/** Lists load what the system already knows first, then scan for more. */
function useList<T>(command: string, on: boolean) {
  const [items, setItems] = useState<T[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async (scan: boolean) => {
    const started = generation.current;
    if (scan) setScanning(true);
    try {
      const next = await invoke<T[]>(command, { scan });
      if (started === generation.current) { setItems(next); setError(""); }
    } catch (err) { if (started === generation.current) setError(String(err)); }
    finally { if (scan && started === generation.current) setScanning(false); }
  }, [command]);
  useEffect(() => {
    generation.current++;
    setItems(null); setError(""); setScanning(false);
    if (on) void load(false).then(() => load(true));
  }, [on, load]);
  return { items, scanning, error, setError, load };
}

function ListHeader({ title, scanning, onScan, manage, onManage }: { title: string; scanning: boolean; onScan: () => void; manage: string; onManage: () => void }) {
  return <div className="quick-list-head">
    <span>{scanning ? "Searching…" : title}</span>
    <Button variant="ghost" size="xs" disabled={scanning} onClick={onScan}><MagnifyingGlassIcon aria-hidden="true" className={scanning ? "quick-pulse" : ""} />{scanning ? "Scanning" : "Scan"}</Button>
    <Button variant="ghost" size="xs" onClick={onManage}>{manage}<ArrowUpRightIcon aria-hidden="true" /></Button>
  </div>;
}

function SignalIcon({ signal }: { signal: number }) {
  const Icon = signal >= 70 ? WifiHighIcon : signal >= 45 ? WifiMediumIcon : signal >= 20 ? WifiLowIcon : WifiNoneIcon;
  return <Icon size={16} aria-label={`Signal ${signal}%`} />;
}

export function WifiNetworks({ on, onManage }: { on: boolean; onManage: () => void }) {
  const { items, scanning, error, setError, load } = useList<Network>("wifi_networks", on);
  const [working, setWorking] = useState("");
  const [prompt, setPrompt] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => { if (!on) { setPrompt(""); setPassword(""); } }, [on]);

  async function run(network: Network | null, action: { type: "connect"; ssid: string; password: string | null } | { type: "disconnect" }) {
    setWorking(network?.ssid || "disconnect"); setError("");
    try { await invoke("wifi_network", { action }); setPrompt(""); setPassword(""); }
    catch (err) {
      setError(String(err));
      // A saved password can be out of date; let the user enter a new one.
      if (network && network.security === "password") setPrompt(network.ssid);
    } finally { await load(false); setWorking(""); }
  }
  function connect(network: Network) {
    if (network.security === "enterprise" && !network.saved) { setError(`${network.ssid} needs a work or school sign-in. Use Manage networks.`); return; }
    if (network.security === "password" && !network.saved) { setPrompt(network.ssid); setPassword(""); setError(""); return; }
    void run(network, { type: "connect", ssid: network.ssid, password: null });
  }
  function join(event: FormEvent, network: Network) {
    event.preventDefault();
    if (!password) return;
    void run(network, { type: "connect", ssid: network.ssid, password });
  }

  if (!on) return <p className="quick-list-empty">Turn on Wi-Fi to see networks.</p>;
  return <section className="quick-list" aria-label="Wi-Fi networks" aria-busy={scanning || !!working}>
    <ListHeader title="Networks" scanning={scanning} onScan={() => void load(true)} manage="Manage" onManage={onManage} />
    {items === null && !error && <p className="quick-list-empty">Loading networks…</p>}
    {items?.length === 0 && !scanning && <p className="quick-list-empty">No networks found. Scan again or move closer to your router.</p>}
    <ul>
      {items?.map(network => <li key={network.ssid} data-connected={network.connected || undefined}>
        <div className="quick-list-row">
          <SignalIcon signal={network.signal} />
          <span><strong>{network.ssid}</strong><small>{working === network.ssid ? "Connecting…" : network.connected ? "Connected" : network.saved ? "Saved" : network.security === "open" ? "Open" : "Secured"}</small></span>
          {network.security !== "open" && <LockSimpleIcon size={13} aria-label="Secured" />}
          {network.connected
            ? <Button variant="outline" size="xs" disabled={!!working} onClick={() => void run(null, { type: "disconnect" })}>{working === "disconnect" ? "Disconnecting…" : "Disconnect"}</Button>
            : <Button variant="outline" size="xs" disabled={!!working} onClick={() => connect(network)}>Connect</Button>}
        </div>
        {prompt === network.ssid && !network.connected && <form className="quick-list-password" onSubmit={event => join(event, network)}>
          <Input type="password" autoFocus autoComplete="off" aria-label={`Password for ${network.ssid}`} placeholder="Password" value={password} maxLength={128} disabled={!!working} onChange={event => setPassword(event.target.value)} />
          <Button type="submit" size="xs" disabled={!password || !!working}>{working === network.ssid ? "Joining…" : "Join"}</Button>
          <Button type="button" variant="ghost" size="xs" disabled={!!working} onClick={() => { setPrompt(""); setPassword(""); }}>Cancel</Button>
        </form>}
      </li>)}
    </ul>
    {error && <p className="quick-list-error" role="alert">{error}</p>}
  </section>;
}

export function BluetoothDevices({ on, onManage }: { on: boolean; onManage: () => void }) {
  const { items, scanning, error, setError, load } = useList<Device>("bluetooth_devices", on);
  const [working, setWorking] = useState("");
  async function act(device: Device, action: DeviceAction) {
    setWorking(device.id); setError("");
    try { await invoke("bluetooth_device", { id: device.id, action }); }
    catch (err) { setError(String(err)); }
    finally { await load(false); setWorking(""); }
  }
  if (!on) return <p className="quick-list-empty">Turn on Bluetooth to pair and connect devices.</p>;
  const state = (device: Device) => working === device.id ? "Working…" : device.connected ? "Connected" : device.paired ? "Paired" : "Available";
  return <section className="quick-list" aria-label="Bluetooth devices" aria-busy={scanning || !!working}>
    <ListHeader title="Devices" scanning={scanning} onScan={() => void load(true)} manage="Manage" onManage={onManage} />
    {items === null && !error && <p className="quick-list-empty">Loading devices…</p>}
    {items?.length === 0 && !scanning && <p className="quick-list-empty">No devices found. Put your device in pairing mode, then scan.</p>}
    <ul>
      {items?.map(device => <li key={device.id} data-connected={device.connected || undefined}>
        <div className="quick-list-row">
          <span><strong>{device.name || "Unnamed device"}</strong><small>{state(device)}</small></span>
          {!device.paired
            ? <Button variant="outline" size="xs" disabled={!!working} onClick={() => void act(device, "pair")}>Pair</Button>
            : <>
              {device.canConnect && <Button variant="outline" size="xs" disabled={!!working} onClick={() => void act(device, device.connected ? "disconnect" : "connect")}>{device.connected ? "Disconnect" : "Connect"}</Button>}
              <Button variant="ghost" size="xs" disabled={!!working} onClick={() => void act(device, "forget")}>Forget</Button>
            </>}
        </div>
      </li>)}
    </ul>
    {error && <p className="quick-list-error" role="alert">{error}</p>}
  </section>;
}
