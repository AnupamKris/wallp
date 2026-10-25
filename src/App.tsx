import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { ClockSettings, WorldClocks, loadSettings } from "./Clocks";
import { Button } from "@/components/ui/button";
import { GearIcon, DesktopIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useHomeShortcuts } from "./home-shortcuts";
import { Workspace } from "./Workspace";
import { TrayApps } from "./TrayApps";
import { QuickSettings } from "./QuickSettings";
import { startClockTicker } from "./clock-motion";
import { useTheme } from "./Theme";
import { EmailDigest } from "./EmailDigest";
import { HomeLayout } from "./HomeLayout";
import { DeskBuddy } from "./DeskBuddy";
import { GameHome, prefetchGameLibrary } from "./GameMode";
import { GameEntrance, GameHoldOverlay, useReducedGameMotion } from "./GameTransitions";
import { useGameHold, useGameMode } from "./use-game-mode";

type AppId = "pc" | "downloads" | "edge" | "steam" | "riot" | "t3";
const shortcuts: { id: AppId; label: string }[] = [
  { id: "edge", label: "Microsoft Edge" },
  { id: "steam", label: "Steam" },
  { id: "riot", label: "Riot Games" },
];

function Icon({ name }: { name: AppId | "close" | "alert" | "settings" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      {name === "pc" && <><path d="M3 4.5h18v12H3zM12 16.5V21M8 21h8" /></>}
      {name === "downloads" && <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>}
      {name === "edge" && <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z" /></>}
      {name === "steam" && <><path d="m3 14 5 3 5-5 2-5" /><circle cx="17" cy="7" r="4" /><circle cx="8" cy="17" r="3" /><path d="m2 17 4 2" /></>}
      {name === "riot" && <path d="m4 9 12-5 4 3-2 10-3 1-1-7-1 8-3 1-1-8-1 7-3-1Z" fill="currentColor" stroke="none" />}
      {name === "t3" && <><path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" /></>}
      {name === "settings" && <><path d="M4 7h16M4 17h16" /><path d="M8 4v6m8 4v6" /></>}
      {name === "close" && <path d="m6 6 12 12M6 18 18 6" />}
      {name === "alert" && <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3v.5" /></>}
    </svg>
  );
}

function App() {
  const [theme, setTheme] = useTheme();
  const [settings, setSettings] = useState(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspace, setWorkspace] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const subscription = listen<boolean>("taskbar://workspace", event => {
      setWorkspace(event.payload);
      setSettingsOpen(false);
    });
    return () => { void subscription.then(unlisten => unlisten()); };
  }, []);
  useEffect(() => {
    if (typeof settings.stackedAnalogue !== "boolean") {
      setSettings(current => ({ ...current, stackedAnalogue: true }));
      return;
    }
    try { localStorage.setItem("wallp.clocks", JSON.stringify(settings)); } catch { /* Keep controls usable if storage is unavailable. */ }
  }, [settings]);
  const [now, setNow] = useState(() => new Date());
  const [paused, setPaused] = useState(isTauri);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [error, setError] = useState("");
  const game = useGameMode(!workspace && !paused && !hidden, !settingsOpen);
  const [gameLibrary, setGameLibrary] = useState(true);
  useEffect(() => { if (game.active) setGameLibrary(true); }, [game.active]);
  const gameOpen = game.active && gameLibrary;
  const reducedGameMotion = useReducedGameMotion();
  // Keep Game Mode on screen briefly after leaving so it can animate out over Home.
  const [gameLeaving, setGameLeaving] = useState(false);
  const wasGameOpen = useRef(false);
  useEffect(() => {
    const left = wasGameOpen.current && !gameOpen;
    wasGameOpen.current = gameOpen;
    if (!left || reducedGameMotion) return;
    setGameLeaving(true);
    const id = setTimeout(() => setGameLeaving(false), 500);
    return () => { clearTimeout(id); setGameLeaving(false); };
  }, [gameOpen, reducedGameMotion]);
  // Play the title sequence only when Game Mode itself turns on, not when returning from Home widgets.
  const [gameIntro, setGameIntro] = useState(false);
  // Motion variants continue from the loader's closed gates after a completed controller hold.
  const [gameHeld, setGameHeld] = useState(false);
  // Layout effect: the intro must mount before Game Mode Home first paints, or Home flashes between loader and intro.
  useLayoutEffect(() => {
    if (!game.active || reducedGameMotion) return;
    setGameHeld(performance.now() - game.hold.heldAt < 400);
    setGameIntro(true);
    const id = setTimeout(() => setGameIntro(false), 2400);
    return () => { clearTimeout(id); setGameIntro(false); };
  }, [game.active, reducedGameMotion]);
  const gameHolding = useGameHold(game.hold, progress => progress > 0) && !game.active;
  useEffect(() => { if (gameHolding) prefetchGameLibrary(); }, [gameHolding]);
  const { pins, saving: savingPin, setPinned } = useHomeShortcuts(setError);
  async function launchPinned(id: string) {
    if (!isTauri()) { setError("Open wallp on your desktop to launch apps."); return; }
    try { await invoke("launch_home_shortcut", { id }); setError(""); }
    catch (err) { setError(String(err)); }
  }
  useEffect(() => {
    const onVisibilityChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  const clockActive = !paused && !hidden && (!workspace || settingsOpen);
  useEffect(() => {
    if (!clockActive) return;
    // Resuming always starts from wall-clock time, without replaying missed ticks.
    return startClockTicker(setNow);
  }, [clockActive]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false, receivedEvent = false;
    const unlisten = listen<boolean>("desktop://paused", (event) => {
      receivedEvent = true;
      if (!disposed) setPaused(event.payload);
    });
    // Subscribe first, then read the current state: a reload during fullscreen
    // must also pause even if the watchdog already emitted its transition.
    void unlisten.then(() => invoke<boolean>("desktop_paused")).then(value => {
      if (!disposed && !receivedEvent) setPaused(value);
    }).catch(err => {
      console.error("Couldn't read desktop pause state", err);
      if (!disposed && !receivedEvent) setPaused(false);
    });
    return () => { disposed = true; void unlisten.then(fn => fn()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(id);
  }, [error]);
  async function launch(target: AppId) {
    if (!isTauri()) {
      setError("Open wallp on your desktop to launch apps.");
      return;
    }
    try {
      await invoke("launch_shortcut", { target });
      setError("");
    } catch (err) { setError(String(err)); }
  }
  function shortcut(id: AppId, label: string) {
    return <button key={id} className="shortcut" aria-label={label} title={label} onClick={() => void launch(id)}><Icon name={id} /><span className="home-shortcut-label">{label}</span></button>;
  }
  function addHomeApp() {
    if (!isTauri()) { setError("Open wallp on your desktop to add apps."); return; }
    void invoke("open_launcher").catch(err => setError(String(err)));
  }
  return (
    <main className={`desktop${paused ? " paused" : ""}${gameHolding ? " game-holding" : ""}`}>
      <div className={`workspace-track${workspace ? " workspace-active" : ""}`}>
      <section id="home-screen" className={`desktop-screen${gameLeaving ? " game-returning" : ""}`} aria-label="Home" inert={workspace}>
      {!gameOpen && <>
      <HomeLayout active={!workspace && !settingsOpen} editable={!game.active} actions={<div className="flex flex-wrap items-center gap-2">
        {game.active ? <><Button variant="outline" size="sm" onClick={() => setGameLibrary(true)}>Games</Button><Button variant="outline" size="sm" onClick={game.exit}>Exit Game Mode</Button></> : <Button variant="outline" size="sm" title={`Hold ${game.bindings.controller === "chord" ? "View + Menu" : "Menu"} for 1 second, or Ctrl + Alt + ${game.bindings.letter}`} onClick={game.enter}>Game Mode <span className="text-muted-foreground">Ctrl + Alt + {game.bindings.letter}</span></Button>}
      </div>} widgets={{
      clocks: <WorldClocks now={now} settings={settings} active={clockActive && !workspace && !settingsOpen} fit />,
      digest: <EmailDigest active={!paused && !hidden && !workspace} />,
      files: <nav className="rail files" aria-label="Files and folders">
        {shortcut("pc", "This PC")}
        {shortcut("downloads", "Downloads")}
      </nav>,
      controls: <nav className="system-controls" aria-label="System controls">
        <QuickSettings active={!workspace && !paused && !settingsOpen} />
        <TrayApps active={!workspace && !paused} />
        <Button variant="outline" className="tray-launcher" aria-label="Workspace" title="Workspace" aria-controls="workspace-screen" onClick={() => setWorkspace(true)}><DesktopIcon size={18} aria-hidden="true" /><span className="tray-launcher-label">Workspace</span></Button>
        <Button variant="outline" className="tray-launcher" aria-label="Settings" title="wallp settings" onClick={() => setSettingsOpen(true)}><GearIcon size={18} aria-hidden="true" /><span className="tray-launcher-label">wallp settings</span></Button>
      </nav>,
      apps: <nav className="rail applications" aria-label="Applications">
        {shortcuts.map(({ id, label }) => shortcut(id, label))}
        {pins.map(app => <div className="home-app" key={app.id}>
          <button className="shortcut" aria-label={app.name} title={app.name} onClick={() => void launchPinned(app.id)}>
            <span className="home-app-fallback">{app.name.slice(0, 2).toUpperCase()}</span>
            {app.icon && <img src={app.icon} alt="" onError={event => { event.currentTarget.style.display = "none"; }} />}
            <span className="home-shortcut-label">{app.name}</span>
          </button>
          <button className="home-app-remove" title={`Remove ${app.name} from Home`} aria-label={`Remove ${app.name} from Home`} disabled={savingPin} onClick={() => void setPinned(app.id, false)}><XIcon size={12} /></button>
        </div>)}
        <button className="shortcut" aria-label="Add app to Home" title="Add app from the command menu" onClick={addHomeApp}><PlusIcon /><span className="home-shortcut-label">Add app</span></button>
      </nav>,
      dock: <nav className="dock" aria-label="Dock">{shortcut("t3", "T3 Code")}</nav>,
      buddy: tile => <DeskBuddy variant={tile.variant} active={!paused && !hidden && !workspace && !settingsOpen} />,
      }} />
      </>}
      {(gameOpen || gameLeaving) && <GameHome leaving={!gameOpen} intro={gameIntro && gameOpen} held={gameHeld} transition={game.bindings.transition} pins={pins} launch={target => void launch(target)} launchPinned={id => void launchPinned(id)} onWidgets={() => setGameLibrary(false)} onExit={game.exit} onSettings={() => setSettingsOpen(true)} onAdd={addHomeApp} connected={game.connected} suspended={game.suspended} mouseActive={game.mouseActive} inputError={game.inputError} error={error} onDismissError={() => setError("")} />}
      </section>
      <section id="workspace-screen" className="workspace-screen" aria-label="Workspace" inert={!workspace}>
        <Workspace active={workspace && !settingsOpen} onHome={() => setWorkspace(false)} onSettings={() => setSettingsOpen(true)} />
      </section>
      </div>
      {settingsOpen && <ClockSettings settings={settings} onChange={setSettings} theme={theme} onThemeChange={setTheme} onClose={() => setSettingsOpen(false)} now={now} />}
      <GameHoldOverlay hold={game.hold} transition={game.bindings.transition} exiting={game.active} />
      {gameIntro && gameOpen && <GameEntrance transition={game.bindings.transition} covered={gameHeld} onDone={() => setGameIntro(false)} />}
      {error && !gameOpen && <div className="launch-error" role="alert" title={error}>
        <Icon name="alert" /><span className="sr-only">{error}</span>
        <button className="shortcut" aria-label="Dismiss error" title="Dismiss error" onClick={() => setError("")}><Icon name="close" /></button>
      </div>}
    </main>
  );
}

export default App;

