import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowClockwiseIcon, EyeIcon, EyeSlashIcon, FolderOpenIcon, GameControllerIcon, GearIcon, HouseIcon, PlayIcon, PlusIcon, QuestionIcon, SignOutIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { QuickSettings } from "./QuickSettings";
import { ControllerHelp } from "./ControllerHelp";
import type { InstalledApp } from "./launcher-search";
import { useGameBindings } from "./use-game-mode";
import { validGameLetter, type GameTransition } from "./game-input";
import { GameTransitionPreview, gameTransitions, useReducedGameMotion } from "./GameTransitions";
import "./GameMode.css";

export function GameModeOptions() {
  const [bindings, save] = useGameBindings();
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<GameTransition | null>(null);
  const reducedMotion = useReducedGameMotion();
  function update(patch: Partial<typeof bindings>) {
    try { save({ ...bindings, ...patch }); setError(""); }
    catch { setError("Could not save Game Mode shortcuts. Check that app storage is available and try again."); }
  }
  return <section className="grid gap-4" aria-label="Game Mode shortcuts">
    <p className="text-muted-foreground">Activate only from Home. Hold the controller shortcut for one second.</p>
    <div className="grid gap-2"><span id="game-controller-binding">Controller shortcut</span>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby="game-controller-binding">
        <Button variant={bindings.controller === "chord" ? "secondary" : "outline"} aria-pressed={bindings.controller === "chord"} onClick={() => update({ controller: "chord" })}>View + Menu</Button>
        <Button variant={bindings.controller === "menu" ? "secondary" : "outline"} aria-pressed={bindings.controller === "menu"} onClick={() => update({ controller: "menu" })}>Menu only</Button>
      </div><p className="text-xs text-muted-foreground">View / Menu are also called Back / Start. Xbox-compatible controllers are supported.</p>
    </div>
    <div className="grid gap-2"><span id="game-transition">Transition & loading animation</span>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby="game-transition">
        {gameTransitions.map(item => <Button key={item.id} variant={bindings.transition === item.id ? "secondary" : "outline"} aria-pressed={bindings.transition === item.id} disabled={!!preview} onClick={() => update({ transition: item.id })}>{item.label}</Button>)}
        <Button variant="ghost" disabled={!!preview || reducedMotion} onClick={() => setPreview(bindings.transition)}><PlayIcon />Preview</Button>
      </div>
      <p className="text-xs text-muted-foreground">{gameTransitions.find(item => item.id === bindings.transition)?.description} Applies to the hold loader and Game Mode entrance.</p>
      <p className="text-xs text-muted-foreground">{reducedMotion ? "Reduced motion is on. Title sequences are skipped; the hold shows a simple progress bar." : "Preview plays the hold and entrance. Press Esc to stop. Animations respect Windows reduced motion."}</p>
    </div>
    {preview && createPortal(<GameTransitionPreview transition={preview} onDone={() => setPreview(null)} />, document.body)}
    <label className="grid gap-2" htmlFor="game-keyboard-letter">Keyboard shortcut: Ctrl + Alt + letter
      <Input id="game-keyboard-letter" aria-label="Game Mode shortcut letter" value={bindings.letter} maxLength={1} className="w-20" onChange={event => {
        const letter = event.target.value.slice(-1).toUpperCase();
        if (validGameLetter(letter)) update({ letter });
        else if (["D", "W", "N"].includes(letter)) setError("D, W, and N are reserved for wallp's Desktop, Workspace, and Notes shortcuts. Choose another letter.");
      }} onFocus={event => event.currentTarget.select()} />
    </label>
    <div className="grid gap-2 border-t border-border pt-4">
      <h3>Controller mouse</h3>
      <p className="text-sm text-muted-foreground">While Game Mode is on, hold LB + RB + LT + RT (L1 + R1 + L2 + R2) for one second to toggle desktop controls, even over a game. Release all controls before using the mouse.</p>
      <ul className="grid gap-1 text-sm text-muted-foreground">
        <li>Left stick: pointer · right stick: scroll</li>
        <li>LT / L2: left click · RT / R2: right click (hold to drag)</li>
        <li>A / Cross: Enter · B / Circle: Escape</li>
        <li>X / Square: Alt-Tab · Y / Triangle: Task View</li>
        <li>Menu / Start: confirm closing the current app (Alt+F4)</li>
        <li>L3 (press left stick) or View / Back: toggle custom keyboard</li>
        <li>Keyboard open: X backspace · Y space · LT shift · RT symbols · LB / RB cursor · Menu enter</li>
        <li>R3 (press right stick) or D-pad Down: show desktop</li>
      </ul>
      <p className="text-xs text-muted-foreground">Panels: stick / D-pad to select, A / Cross to confirm, B / Circle to dismiss. Dismiss the panel before using D-pad Down to show desktop. Macro buttons can be used if your controller maps them to these standard buttons. A short vibration and pop-up confirm when controller mouse turns on or off.</p>
      <p className="text-xs text-muted-foreground">Hold L3 + R3 (press both sticks) for half a second to open the command menu, even when mouse mode is off.</p>
      <p className="text-xs text-muted-foreground">Repeat the chord to return to game controls. Disconnecting or exiting Game Mode turns mouse control off. Games still receive controller input; disable overlapping Steam or game controller mouse mappings. Windows may block input to elevated apps.</p>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>;
}

export type Game = { id: string; name: string; source: "steam" | "epic" | "riot" | "custom"; art: string | null; hero: string | null; icon: string | null; lastPlayed: number | null; hidden: boolean; target: string | null };
const sourceNames: Record<Game["source"], string> = { steam: "Steam", epic: "Epic Games", riot: "Riot Games", custom: "Added by you" };
type Filter = "all" | Game["source"];

// The last scan survives between visits so Game Mode Home opens with its games instead of re-laying out mid-entrance.
let cachedGames: Game[] | null = null;
let pendingScan: Promise<Game[]> | null = null;
function scanGameLibrary() {
  pendingScan ??= invoke<Game[]>("game_library").then(games => { cachedGames = games; return games; }).finally(() => { pendingScan = null; });
  return pendingScan;
}
/** Starts the library scan early (for example while the Game Mode shortcut is held) so Home has it on first paint. */
export function prefetchGameLibrary() {
  if (isTauri()) void scanGameLibrary().catch(() => {});
}

function useGameLibrary() {
  const [games, setGames] = useState<Game[]>(() => cachedGames ?? []);
  const [loading, setLoading] = useState(() => !cachedGames);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!isTauri()) { setLoading(false); setError("Open wallp on your desktop to find installed games."); return; }
    if (!cachedGames) setLoading(true);
    try {
      const next = await scanGameLibrary();
      // An unchanged rescan keeps the same array so nothing on screen re-renders.
      setGames(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      setError("");
    }
    catch (err) { setError(`Couldn't read your game library: ${String(err)}`); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { games, loading, error, refresh };
}

function playedLabel(seconds: number | null) {
  if (!seconds) return null;
  const days = Math.floor((Date.now() / 1000 - seconds) / 86400);
  if (days <= 0) return "Played today";
  if (days === 1) return "Played yesterday";
  if (days < 30) return `Played ${days} days ago`;
  return `Last played ${new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(id); }, []);
  return now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function GameArt({ name, art, icon }: { name: string; art: string | null; icon: string | null }) {
  const [failed, setFailed] = useState(false);
  if (art && !failed) return <img className="game-art" src={convertFileSrc(art)} alt="" draggable={false} onError={() => setFailed(true)} />;
  return <span className="game-art-fallback bg-muted text-muted-foreground" aria-hidden="true">
    {icon ? <img src={icon} alt="" draggable={false} /> : <span className="text-2xl font-medium">{name.slice(0, 2).toUpperCase()}</span>}
  </span>;
}

function AddGameDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(""); setTarget(""); setError(""); } }, [open]);
  async function browse() {
    try {
      const path = await invoke<string | null>("pick_game_program");
      if (!path) return;
      setTarget(path);
      if (!name.trim()) setName((path.split(/[\\/]/).pop() ?? "").replace(/\.(exe|lnk|url|bat)$/i, ""));
      setError("");
    } catch (err) { setError(`Couldn't open the file picker: ${String(err)}`); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try { await invoke("add_custom_game", { name, target }); onAdded(); onOpenChange(false); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogTitle>Add a game</DialogTitle>
      <DialogDescription>Choose the game's program or shortcut, or paste a launch link such as steam://rungameid/730.</DialogDescription>
      <form className="grid gap-4" onSubmit={event => void submit(event)}>
        <div className="grid gap-2"><label htmlFor="game-add-target">Program or link</label>
          <div className="flex gap-2">
            <Input id="game-add-target" value={target} placeholder={"C:\\Games\\Game\\game.exe"} className="min-w-0 flex-1" onChange={event => setTarget(event.target.value)} />
            <Button type="button" variant="outline" onClick={() => void browse()}><FolderOpenIcon />Browse</Button>
          </div>
        </div>
        <div className="grid gap-2"><label htmlFor="game-add-name">Name</label>
          <Input id="game-add-name" value={name} maxLength={120} onChange={event => setName(event.target.value)} />
        </div>
        {error && <p role="alert" className="break-words text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim() || !target.trim()}>Add game</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function GameHome({ leaving = false, intro = false, held = false, transition = "classic", pins, launch, launchPinned, onWidgets, onExit, onSettings, onAdd, connected, suspended, mouseActive, inputError, error, onDismissError }: {
  leaving?: boolean; intro?: boolean; held?: boolean; transition?: GameTransition; pins: InstalledApp[]; launch: (target: "steam" | "riot") => void; launchPinned: (id: string) => void;
  onWidgets: () => void; onExit: () => void; onSettings: () => void; onAdd: () => void;
  connected: boolean; suspended: boolean; mouseActive: boolean; inputError: string; error: string; onDismissError: () => void;
}) {
  const library = useGameLibrary();
  const clock = useClock();
  const [filter, setFilter] = useState<Filter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState("");
  const sources = (["steam", "epic", "riot", "custom"] as const).filter(source => library.games.some(game => game.source === source));
  const hiddenCount = library.games.filter(game => game.hidden).length;
  const shown = library.games.filter(game => (filter === "all" || game.source === filter) && (showHidden || !game.hidden));
  const pinned = pins.find(pin => pin.id === selectedId);
  const selected = pinned ? undefined : library.games.find(game => game.id === selectedId) ?? shown[0];
  useEffect(() => { if (filter !== "all" && !library.loading && !library.games.some(game => game.source === filter)) setFilter("all"); }, [filter, library.games, library.loading]);
  async function play(game: Game) {
    try { await invoke("launch_game", { id: game.id }); setActionError(""); }
    catch (err) { setActionError(String(err)); }
  }
  async function change(command: string, args: Record<string, unknown>) {
    try { await invoke(command, args); setActionError(""); await library.refresh(); }
    catch (err) { setActionError(String(err)); }
  }
  const message = actionError || error || library.error || inputError;
  const status = mouseActive ? "Controller mouse on · hold LB + RB + LT + RT to exit" : suspended ? "Input paused while another app is active" : connected ? "Controller connected" : "Keyboard ready · connect an Xbox-compatible controller";
  const played = playedLabel(selected?.lastPlayed ?? null);
  // Latch the entrance for this visit. Dropping data-intro when the title overlay finishes would change the
  // animation names and --intro delay mid-flight, restarting Home's own entrance animations.
  const [entrance, setEntrance] = useState<{ transition: GameTransition; held: boolean } | null>(null);
  const shownEntrance = entrance ?? (intro ? { transition, held } : null);
  useEffect(() => { if (intro) setEntrance(current => current ?? { transition, held }); }, [intro, transition, held]);
  return <div className="game-home bg-background text-foreground" aria-label="Game Mode Home" data-leaving={leaving || undefined} data-intro={shownEntrance?.transition} data-held={shownEntrance?.held || undefined} data-transition={transition} inert={leaving}>
    {selected?.hero && <img key={selected.hero} className="game-backdrop" src={convertFileSrc(selected.hero)} alt="" aria-hidden="true" onError={event => { event.currentTarget.style.display = "none"; }} />}
    <div className="game-scrim" aria-hidden="true" />
    <header className="game-topbar">
      <div className="flex min-w-0 items-center gap-3">
        <GameControllerIcon size={24} aria-hidden="true" />
        <div className="min-w-0"><h1 className="text-base font-medium">Game Mode</h1><p className="truncate text-xs text-muted-foreground" role="status">{status}</p></div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-2 text-sm tabular-nums text-muted-foreground">{clock}</span>
        <QuickSettings active={!suspended} appearance="button" />
        <Dialog><DialogTrigger asChild><Button variant="ghost" size="icon" aria-label="Game Mode shortcuts" title="Game Mode shortcuts"><GameControllerIcon /></Button></DialogTrigger>
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto"><DialogTitle>Game Mode shortcuts</DialogTitle><DialogDescription>Choose how to enter and leave Game Mode.</DialogDescription><GameModeOptions /></DialogContent>
        </Dialog>
        <Dialog><DialogTrigger asChild><Button variant="ghost" size="icon" aria-label="Controller mouse help" title="Controller mouse help"><QuestionIcon /></Button></DialogTrigger>
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl"><DialogTitle>Controller mouse mode</DialogTitle><DialogDescription>What each button does while mouse mode is on.</DialogDescription><ControllerHelp /></DialogContent>
        </Dialog>
        <Button variant="ghost" size="icon" aria-label="wallp settings" title="wallp settings" onClick={onSettings}><GearIcon /></Button>
        <Button variant="outline" onClick={onWidgets}><HouseIcon />Home widgets</Button>
        <Button variant="outline" onClick={onExit}><SignOutIcon />Exit</Button>
      </div>
    </header>

    <section className="game-spotlight" aria-label="Selected game">
      {pinned ? <>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Pinned from Home</p>
        <h2 className="game-title">{pinned.name}</h2>
        <div className="flex flex-wrap gap-2"><Button size="lg" onClick={() => launchPinned(pinned.id)}><PlayIcon weight="fill" />Open</Button></div>
      </> : selected ? <>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">{sourceNames[selected.source]}</Badge>{played && <span>{played}</span>}{selected.hidden && <Badge variant="secondary">Hidden</Badge>}</div>
        <h2 className="game-title">{selected.name}</h2>
        {selected.target && <p className="max-w-full truncate text-xs text-muted-foreground" title={selected.target}>{selected.target}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={() => void play(selected)}><PlayIcon weight="fill" />Play</Button>
          {selected.source === "custom"
            ? <Button size="lg" variant="outline" onClick={() => void change("remove_custom_game", { id: selected.id })}><TrashIcon />Remove</Button>
            : <Button size="lg" variant="outline" onClick={() => void change("set_game_hidden", { id: selected.id, hidden: !selected.hidden })}>{selected.hidden ? <><EyeIcon />Show in library</> : <><EyeSlashIcon />Hide</>}</Button>}
        </div>
      </> : <>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Library</p>
        <h2 className="game-title">{library.loading ? "Finding your games…" : "No games found"}</h2>
        {!library.loading && <p className="max-w-xl text-sm text-muted-foreground">wallp looks for installed Steam, Epic Games, and Riot games. Add anything else with Add game.</p>}
      </>}
      {message && <div role="alert" className="game-message border border-border bg-card text-card-foreground"><p className="min-w-0 flex-1 break-words">{message}</p>{(actionError || error) && <Button variant="outline" size="sm" onClick={() => { setActionError(""); onDismissError(); }}>Dismiss</Button>}</div>}
    </section>

    <section className="game-library" aria-label="Game library">
      <div className="game-library-bar">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter games">
          {(["all", ...sources] as Filter[]).map(value => <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? `All games${library.games.length ? ` · ${library.games.length - hiddenCount}` : ""}` : sourceNames[value]}</Button>)}
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          {hiddenCount > 0 && <Button size="sm" variant="ghost" aria-pressed={showHidden} onClick={() => setShowHidden(value => !value)}>{showHidden ? <EyeSlashIcon /> : <EyeIcon />}{showHidden ? "Hide hidden games" : `Show hidden · ${hiddenCount}`}</Button>}
          <Button size="sm" variant="ghost" disabled={library.loading} onClick={() => void library.refresh()}><ArrowClockwiseIcon />{library.loading ? "Scanning…" : "Rescan"}</Button>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}><PlusIcon />Add game</Button>
        </div>
      </div>
      <div className="game-shelf">
        {shown.map((game, index) => <button key={game.id} type="button" className="game-card" style={{ "--game-index": Math.min(index, 12) } as CSSProperties} data-hidden={game.hidden} data-selected={selected?.id === game.id} {...(index === 0 ? { "data-game-initial": true } : {})} aria-label={`Play ${game.name}`} title={game.name} onFocus={() => setSelectedId(game.id)} onMouseEnter={() => setSelectedId(game.id)} onClick={() => void play(game)}>
          <span className="game-cover border border-border"><GameArt name={game.name} art={game.art} icon={game.icon} /></span>
          <span className="game-card-name">{game.name}</span>
        </button>)}
        {filter === "all" && pins.map(pin => <button key={pin.id} type="button" className="game-card" data-selected={pinned?.id === pin.id} {...(!shown.length && pin === pins[0] ? { "data-game-initial": true } : {})} aria-label={`Open ${pin.name}`} title={pin.name} onFocus={() => setSelectedId(pin.id)} onMouseEnter={() => setSelectedId(pin.id)} onClick={() => launchPinned(pin.id)}>
          <span className="game-cover border border-border"><GameArt name={pin.name} art={null} icon={pin.icon ?? null} /></span>
          <span className="game-card-name">{pin.name}</span>
        </button>)}
        <button type="button" className="game-card" aria-label="Add a game" {...(!shown.length && !pins.length ? { "data-game-initial": true } : {})} onClick={() => setAdding(true)}>
          <span className="game-cover game-cover-add border border-dashed border-border text-muted-foreground"><PlusIcon size={32} aria-hidden="true" /></span>
          <span className="game-card-name text-muted-foreground">Add a game</span>
        </button>
      </div>
    </section>

    <footer className="game-footer border-t border-border text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-x-6 gap-y-1"><span>D-pad / stick / arrows · move</span><span>A / Enter · play</span><span>B / Escape · back</span></div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" onClick={() => launch("steam")}>Open Steam</Button>
        <Button size="sm" variant="ghost" onClick={() => launch("riot")}>Open Riot Client</Button>
        <Button size="sm" variant="ghost" onClick={onAdd}>Pin an app to Home</Button>
      </div>
    </footer>
    <AddGameDialog open={adding} onOpenChange={setAdding} onAdded={() => void library.refresh()} />
  </div>;
}

