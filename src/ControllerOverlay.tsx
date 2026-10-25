import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AppWindowIcon, ArrowFatUpIcon, ArrowLineRightIcon, BackspaceIcon, CaretLeftIcon, CaretRightIcon, CheckIcon, CursorIcon, GameControllerIcon, KeyboardIcon, KeyReturnIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { directionalNeighbor, type Direction } from "./game-input";
import { useTheme } from "./Theme";
import "./ControllerOverlay.css";

const mouseHints = [["L-stick", "Pointer"], ["LT", "Click"], ["RT", "Right-click"], ["R-stick", "Scroll"]];

/** Controller shortcuts that press an on-screen key directly, matched by its data-key. */
const keyShortcuts: Record<string, string> = { backspace: "Backspace", space: "Space", enter: "Enter", shift: "Shift", symbols: "Symbols", "cursor-left": "Cursor left", "cursor-right": "Cursor right" };
type View = { id: number; kind: string; title: string; active: boolean };
const rows = ["1234567890-=", "qwertyuiop[]", "asdfghjkl;'", "zxcvbnm,./"];
const shiftedRows = ["!@#$%^&*()_+", "QWERTYUIOP{}", 'ASDFGHJKL:"', "ZXCVBNM<>?"];
// Each layout keeps the same row lengths so modifier keys stay put when switching.
const symbols = ["!@#$%^&*()_+", "[]{}<>\\|~`€£", ":;\"'?,.=-/•", "0123456789"];
function previewView(): View {
  const params = new URLSearchParams(location.search);
  const kind = params.get("panel") ?? "keyboard";
  return { id: 1, kind, title: params.get("title") ?? (kind === "toast" ? "Controller mouse on" : "Example application with a long window title — unsaved document"), active: params.get("active") !== "false" };
}

export function ControllerOverlay() {
  useTheme();
  const [view, setView] = useState<View>(() => isTauri() ? { id: 0, kind: "", title: "", active: false } : previewView());
  const [error, setError] = useState("");
  const [shift, setShift] = useState(false);
  const [symbol, setSymbol] = useState(false);
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const index = useRef(0);
  const busy = useRef(false);
  const onInput = useRef<(action: string) => void>(() => {});

  function receive(next: View) { setView(current => next.id >= current.id ? next : current); }
  useEffect(() => {
    let disposed = false;
    if (!isTauri()) return;
    const subscriptions = Promise.all([
      listen<View>("controller-overlay://view", event => { if (!disposed) receive(event.payload); }),
      listen<string>("controller-overlay://input", event => { if (!disposed) onInput.current(event.payload); }),
    ]);
    void subscriptions.then(async unlisten => {
      if (disposed) { unlisten.forEach(fn => fn()); return; }
      receive(await invoke<View>("controller_overlay_ready"));
    }).catch(() => { if (!disposed) setError("Could not connect to controller controls."); });
    return () => { disposed = true; void subscriptions.then(unlisten => unlisten.forEach(fn => fn())); };
  }, []);
  useEffect(() => {
    setError(""); setShift(false); setSymbol(false); setSelected(0); index.current = 0; busy.current = false;
  }, [view.id]);
  useEffect(() => { if (error) root.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "nearest" }); }, [error]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const action = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Enter: "accept", Escape: "back" } as Record<string, string>)[event.key];
      if (action) { event.preventDefault(); onInput.current(action); }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  async function perform(command: string, args: Record<string, unknown> = {}) {
    if (busy.current) return;
    busy.current = true;
    const id = view.id;
    try {
      if (isTauri()) await invoke(command, { id, ...args });
      else if (command !== "controller_overlay_key") setView(current => ({ ...current, kind: "" }));
      setError("");
    } catch (err) { setError(String(err)); }
    finally { busy.current = false; }
  }
  function dismiss() { void perform("controller_overlay_dismiss"); }
  function select(next: number) {
    index.current = next; setSelected(next);
    root.current?.querySelectorAll<HTMLButtonElement>("[data-overlay-control]")[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  onInput.current = action => {
    const shortcut = keyShortcuts[action];
    if (shortcut) {
      const key = root.current?.querySelector<HTMLButtonElement>(`[data-key="${shortcut}"]`);
      if (!key) return;
      key.click();
      // Flash the key so a shortcut press is as visible as selecting and pressing A.
      key.dataset.flash = ""; void key.offsetWidth; key.dataset.flash = "true";
      return;
    }
    if (action === "accept") { root.current?.querySelectorAll<HTMLButtonElement>("[data-overlay-control]")[index.current]?.click(); return; }
    if (action === "back") { dismiss(); return; }
    if (!["left", "right", "up", "down"].includes(action)) return;
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-overlay-control]") ?? [])];
    select(directionalNeighbor(items.map(item => item.getBoundingClientRect()), index.current, action as Direction));
  };
  let controlIndex = 0;
  /** A selectable overlay control; `units` sets its width relative to a standard key. */
  function control(key: string, content: ReactNode, click: () => void, options: { label?: string; units?: number; tone?: "key" | "mod" | "cancel" | "close"; pressed?: boolean; hint?: string; className?: string } = {}) {
    const i = controlIndex++;
    const on = selected === i;
    const tone = options.tone ?? "key";
    const variant = tone === "close" ? "destructive" : on ? "default" : tone === "mod" || options.pressed ? "secondary" : "outline";
    return <Button key={key} data-overlay-control="" data-key={key} data-selected={on || undefined} aria-label={options.label ?? key} aria-pressed={options.pressed} aria-keyshortcuts={options.hint}
      variant={variant} style={options.units ? { flexGrow: options.units } : undefined}
      className={`controller-control relative min-w-0 ${options.units ? "h-full basis-0" : ""} ${on && tone === "close" ? "bg-destructive text-primary-foreground hover:bg-destructive" : ""} ${on ? "z-10" : ""} ${options.className ?? ""}`}
      onPointerEnter={() => { index.current = i; setSelected(i); }} onClick={click} onAnimationEnd={event => { if (event.animationName === "controller-key-flash") delete event.currentTarget.dataset.flash; }}>
      {content}{options.hint && <span className="absolute top-1 right-1 text-[9px] leading-none font-medium opacity-60" aria-hidden="true">{options.hint}</span>}
    </Button>;
  }
  function type(text: string) {
    void perform("controller_overlay_key", { text });
    // Shift applies to one letter, like a phone keyboard.
    if (shift && !symbol && text !== " ") setShift(false);
  }
  function special(key: string) { void perform("controller_overlay_key", { special: key }); }
  if (!view.kind) return null;
  if (view.kind === "toast") return <div className="h-dvh bg-background text-foreground">
    <Card key={view.id} role="status" aria-live="polite" aria-labelledby="controller-toast-title" className="controller-toast relative h-full justify-center gap-3 overflow-hidden border border-border p-4 ring-0" data-active={view.active || undefined}>
      <div className="flex min-w-0 items-center gap-3">
        <span className={`controller-toast-badge relative grid size-11 shrink-0 place-items-center border ${view.active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted text-muted-foreground"}`} aria-hidden="true">
          {view.active ? <CursorIcon size={22} weight="fill" /> : <GameControllerIcon size={22} weight="fill" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] tracking-widest text-muted-foreground uppercase">Controller</p>
          <CardTitle id="controller-toast-title" className="truncate text-sm">{view.active ? "Mouse mode on" : "Mouse mode off"}</CardTitle>
          <CardDescription className="truncate">{view.active ? "Hold LB + RB + LT + RT to return to the game" : "Your controller is back to game controls"}</CardDescription>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" className="self-start" onClick={dismiss}><XIcon /></Button>
      </div>
      {view.active && <dl className="grid grid-cols-4 gap-1.5">
        {mouseHints.map(([button, action]) => <div key={button} className="controller-toast-hint flex min-w-0 flex-col items-center gap-0.5 border border-border bg-muted/40 px-1 py-1">
          <dt className="text-[10px] font-medium text-foreground">{button}</dt>
          <dd className="truncate text-[10px] text-muted-foreground">{action}</dd>
        </div>)}
      </dl>}
      {error && <p role="alert" className="text-xs text-destructive break-words">{error}</p>}
      <div className={`controller-toast-progress absolute inset-x-0 bottom-0 h-0.5 origin-left ${view.active ? "bg-primary" : "bg-muted-foreground"}`} aria-hidden="true" />
    </Card>
  </div>;
  if (view.kind === "confirm") return <div ref={root} className="h-dvh bg-background text-foreground">
    <Card key={view.id} role="alertdialog" aria-labelledby="controller-panel-title" aria-describedby="controller-panel-description" className="controller-panel relative h-full gap-4 overflow-hidden border border-border p-5 ring-0">
      <CardHeader className="flex flex-row items-start gap-3 p-0">
        <span className="controller-toast-badge grid size-10 shrink-0 place-items-center border border-destructive/30 bg-destructive/10 text-destructive" aria-hidden="true"><WarningIcon size={20} weight="fill" /></span>
        <div className="grid min-w-0 gap-0.5">
          <CardTitle id="controller-panel-title" className="text-sm">Close this app?</CardTitle>
          <CardDescription id="controller-panel-description">wallp will send Alt + F4. Unsaved work may be lost.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4 p-0">
        <div className="flex min-w-0 items-start gap-2.5 border border-border bg-muted/40 px-3 py-2.5">
          <AppWindowIcon size={16} className="mt-px shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="line-clamp-2 min-w-0 break-words text-xs" title={view.title}>{view.title || "Untitled window"}</p>
        </div>
        <div className="mt-auto grid grid-cols-2 gap-2">
          {control("Cancel", <><span className="flex-1 text-left">Cancel</span><Glyph>B</Glyph></>, dismiss, { tone: "cancel", className: "h-10 justify-between" })}
          {control("Close app", "Close app", () => void perform("controller_overlay_confirm"), { tone: "close", className: "h-10 justify-between" })}
        </div>
        {error && <p role="alert" className="text-xs text-destructive break-words">{error}</p>}
        <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><Glyph>Stick</Glyph>choose<Glyph>A</Glyph>confirm<Glyph>B</Glyph>cancel</span>
          <span>Expires in 30 s</span>
        </div>
      </CardContent>
      <div className="controller-confirm-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-destructive" aria-hidden="true" />
    </Card>
  </div>;
  const letters = symbol ? symbols : shift ? shiftedRows : rows;
  const keys = (row: string) => [...row].map(char => control(char, char, () => type(char), { units: 1 }));
  const mode = symbol ? "#+=" : shift ? "ABC" : "abc";
  return <div ref={root} className="h-dvh bg-background text-foreground">
    <Card key={view.id} role="dialog" aria-labelledby="controller-panel-title" aria-describedby="controller-panel-description" className="controller-panel h-full gap-3 overflow-hidden border border-border p-4 ring-0">
      <CardHeader className="flex flex-row items-center gap-3 p-0">
        <span className="grid size-8 shrink-0 place-items-center border border-border bg-muted text-muted-foreground" aria-hidden="true"><KeyboardIcon size={18} /></span>
        <div className="grid min-w-0 flex-1">
          <CardTitle id="controller-panel-title" className="text-[10px] font-normal tracking-widest text-muted-foreground uppercase">Typing into</CardTitle>
          <CardDescription id="controller-panel-description" className="truncate text-sm text-foreground" title={view.title}>{view.title || "Untitled window"}</CardDescription>
        </div>
        <span className="shrink-0 border border-border px-2 py-0.5 text-xs tabular-nums text-muted-foreground" aria-live="polite" aria-label={`Layout: ${symbol ? "symbols" : shift ? "uppercase" : "lowercase"}`}>{mode}</span>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-1.5 p-0" role="group" aria-label="Keys">
        <div className="flex min-h-0 flex-1 gap-1.5">{keys(letters[0])}{control("Backspace", <BackspaceIcon size={18} />, () => special("Backspace"), { units: 2, tone: "mod", hint: "X" })}</div>
        <div className="flex min-h-0 flex-1 gap-1.5">{control("Tab", <><ArrowLineRightIcon />Tab</>, () => special("Tab"), { units: 2, tone: "mod" })}{keys(letters[1])}</div>
        <div className="flex min-h-0 flex-1 gap-1.5">{keys(letters[2])}{control("Enter", <><KeyReturnIcon size={18} />Enter</>, () => special("Enter"), { units: 3, tone: "mod", hint: "Menu" })}</div>
        <div className="flex min-h-0 flex-1 gap-1.5">
          {control("Shift", <ArrowFatUpIcon size={18} weight={shift ? "fill" : "regular"} />, () => { setShift(value => !value); }, { units: 2, tone: "mod", pressed: shift, hint: "LT" })}
          {keys(letters[3])}
          {control("Cursor left", <CaretLeftIcon size={18} />, () => special("Left"), { units: 1, tone: "mod", hint: "LB" })}
          {control("Cursor right", <CaretRightIcon size={18} />, () => special("Right"), { units: 1, tone: "mod", hint: "RB" })}
        </div>
        <div className="flex min-h-0 flex-1 gap-1.5">
          {control("Symbols", symbol ? "ABC" : "#+=", () => { setSymbol(value => !value); }, { units: 2, tone: "mod", label: symbol ? "Letters" : "Symbols", pressed: symbol, hint: "RT" })}
          {control("Space", "space", () => type(" "), { units: 9, hint: "Y" })}
          {control("Done", <><CheckIcon />Done</>, dismiss, { units: 3, tone: "mod" })}
        </div>
      </CardContent>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><Glyph>Stick</Glyph>move</span>
        <span className="flex items-center gap-1.5"><Glyph>A</Glyph>type</span>
        <span className="flex items-center gap-1.5"><Glyph>B</Glyph>close</span>
        <span>Corner labels are shortcuts</span>
        <span className="ml-auto">Keys go straight to the app above</span>
      </div>
      {error && <p role="alert" className="text-xs text-destructive break-words">{error}</p>}
    </Card>
  </div>;
}

function Glyph({ children }: { children: ReactNode }) {
  return <kbd className="inline-grid h-4 min-w-4 place-items-center border border-current/30 px-1 font-sans text-[10px] leading-none font-medium">{children}</kbd>;
}
