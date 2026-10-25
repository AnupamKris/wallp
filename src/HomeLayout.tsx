import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { boundedTile, buddyVariants, defaultHomeLayout, minimum, minimumWidth, parseHomeLayout, projectLayout, rearrange, screenRows, setWidgetVisible, widgetIds, widgetNames, type HomeLayout as Layout, type Tile, type WidgetId } from "./home-layout";
import "./HomeLayout.css";

const storageKey = "wallp.home-layout.v1";
type Gesture = { id: WidgetId; pointer: number; startX: number; startY: number; scale: number; tile: Tile; base: Layout; resize: boolean; dx: number; dy: number; next: Layout };

export function HomeLayout({ widgets, active, actions, editable = true }: { widgets: Record<WidgetId, ReactNode | ((tile: Tile) => ReactNode)>; active: boolean; actions?: ReactNode; editable?: boolean }) {
  const [savedLayout, setSavedLayout] = useState(() => { try { return parseHomeLayout(localStorage.getItem(storageKey)); } catch { return defaultHomeLayout; } });
  const [editing, setEditing] = useState(false);
  const [screen, setScreen] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [toolbarHeight, setToolbarHeight] = useState(28);
  const [history, setHistory] = useState<Layout[]>([]);
  const [preview, setPreview] = useState<Layout | null>(null);
  const [moving, setMoving] = useState<{ id: WidgetId; dx: number; dy: number; resize: boolean } | null>(null);
  const [status, setStatus] = useState("Layout saved");
  const [layoutError, setLayoutError] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<WidgetId>("controls");
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const width = Math.max(1, screen.width - 32);
  const height = Math.max(100, screen.height - 80);
  const gap = Math.min(12, height / screenRows * .3);
  const rowHeight = (height + gap) / screenRows;
  const columns = width < 560 ? 8 : width < 900 ? 24 : 48;
  const layout = projectLayout(savedLayout, columns);
  const shown = preview ?? layout;
  const step = (width + gap) / columns;
  const compact = screen.width < 760;
  const sidebarSpace = compact ? 0 : 304;
  const availableHeight = Math.max(60, screen.height - toolbarHeight - 76 - (compact ? Math.min(380, screen.height * .48) : 0));
  const editScale = Math.max(.1, Math.min(.86, (screen.width - sidebarSpace - 64) / screen.width, availableHeight / screen.height));
  const scale = editing ? editScale : 1;
  const offsetX = editing ? (screen.width - sidebarSpace - screen.width * scale) / 2 : 0;
  const offsetY = editing ? toolbarHeight + 44 + (availableHeight - screen.height * scale) / 2 : 0;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useLayoutEffect(() => {
    let previousWidth = -1, previousHeight = -1;
    const observer = new ResizeObserver(() => {
      if (!root.current) return;
      const { clientWidth: nextWidth, clientHeight: nextHeight } = root.current;
      setToolbarHeight(toolbar.current?.offsetHeight ?? 28);
      if (nextWidth === previousWidth && nextHeight === previousHeight) return;
      previousWidth = nextWidth; previousHeight = nextHeight;
      setScreen({ width: nextWidth, height: nextHeight }); gesture.current = null; setPreview(null); setMoving(null);
    });
    if (root.current) observer.observe(root.current);
    if (toolbar.current) observer.observe(toolbar.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(savedLayout)); setStatus("Layout saved"); }
    catch { setStatus("Storage unavailable — layout kept for this session"); }
  }, [savedLayout]);
  useEffect(() => { if (!active) { gesture.current = null; setPreview(null); setMoving(null); setEditing(false); } }, [active]);
  function commit(next: Layout | null) {
    if (!next) {
      const message = "No room in this layout. Hide or resize another widget and try again.";
      setStatus(message); setLayoutError(message); return;
    }
    setLayoutError("");
    if (JSON.stringify(next) === JSON.stringify(layoutRef.current)) return;
    setHistory(past => [...past.slice(-29), savedLayout]); setSavedLayout(next);
  }
  function cancel() { gesture.current = null; setPreview(null); setMoving(null); }
  function update(clientX: number, clientY: number) {
    const g = gesture.current;
    if (!g) return;
    const dx = (clientX - g.startX) / g.scale, dy = (clientY - g.startY) / g.scale;
    g.dx = g.resize ? Math.max((minimumWidth(g.id, columns) - g.tile.w) * step, Math.min((columns - g.tile.x - g.tile.w) * step, dx)) : Math.max(-g.tile.x * step, Math.min((columns - g.tile.x - g.tile.w) * step, dx));
    g.dy = g.resize ? Math.max((minimum[g.id][1] - g.tile.h) * rowHeight, Math.min((screenRows - g.tile.y - g.tile.h) * rowHeight, dy)) : Math.max(-g.tile.y * rowHeight, Math.min((screenRows - g.tile.y - g.tile.h) * rowHeight, dy));
    const target = boundedTile(g.resize ? { ...g.tile, w: g.tile.w + Math.round(g.dx / step), h: g.tile.h + Math.round(g.dy / rowHeight) } : { ...g.tile, x: g.tile.x + Math.round(g.dx / step), y: g.tile.y + Math.round(g.dy / rowHeight) }, columns);
    const next = rearrange(g.base, target);
    if (!next) { setStatus("No room at that size. Your layout stays within this screen."); return; }
    g.next = next;
    setPreview(g.next); setMoving({ id: g.id, dx: g.dx, dy: g.dy, resize: g.resize });
  }
  function begin(event: PointerEvent<HTMLButtonElement>, tile: Tile, resize: boolean) {
    if (event.button !== 0 || gesture.current) return;
    setSelectedGroup(tile.id);
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const renderedScale = surface.current!.getBoundingClientRect().width / screen.width;
    gesture.current = { id: tile.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, scale: renderedScale, tile, base: layout, resize, dx: 0, dy: 0, next: layout };
    setMoving({ id: tile.id, dx: 0, dy: 0, resize });
  }
  function end(event: PointerEvent<HTMLButtonElement>) {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointer) return;
    update(event.clientX, event.clientY);
    if (Math.abs(g.dx) + Math.abs(g.dy) > 3) commit(g.next);
    cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, tile: Tile, resize: boolean) {
    if (event.key === "Escape") { cancel(); return; }
    const dx = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const dy = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    setSelectedGroup(tile.id);
    const next = boundedTile(resize ? { ...tile, w: Math.min(columns - tile.x, tile.w + dx), h: Math.min(screenRows - tile.y, tile.h + dy) } : { ...tile, x: tile.x + dx, y: tile.y + dy }, columns);
    commit(rearrange(layout, next));
  }
  const group = layout.tiles.find(t => t.id === selectedGroup)!;
  const direction = (tile: Tile) => tile.direction ?? (tile.id === "files" || tile.id === "apps" ? "column" : "row");
  const labels = (tile: Tile) => tile.labels ?? tile.id === "controls";
  const horizontal = (tile: Tile) => tile.alignX ?? (direction(tile) === "row" ? tile.contentAlign : undefined) ?? "center";
  const vertical = (tile: Tile) => tile.alignY ?? (direction(tile) === "column" ? tile.contentAlign : undefined) ?? "center";
  function customize(patch: Partial<Tile>) { commit({ ...layout, tiles: layout.tiles.map(t => t.id === selectedGroup ? { ...t, ...patch } : t) }); }
  return <div ref={root} className={`home-layout${editing ? " home-editing" : ""}`} onKeyDown={e => { if (e.key === "Escape") cancel(); }}>
    <div ref={toolbar} className="home-layout-toolbar" aria-label="Home layout controls">
      {editing ? <>
        <span className="home-layout-title">Make yourself at home</span>
        <Button variant="outline" size="sm" onClick={() => commit(rearrange(layout, undefined, true))}>Auto arrange</Button>
        <Button variant="ghost" size="sm" disabled={!history.length} onClick={() => { const previous = history[history.length - 1]; if (previous) { setSavedLayout(previous); setHistory(past => past.slice(0, -1)); } }}>Undo</Button>
        <Button variant="ghost" size="sm" onClick={() => commit(projectLayout(defaultHomeLayout, columns))}>Reset</Button>
        <Button size="sm" onClick={() => { cancel(); setEditing(false); }}>Done</Button>
        <span className="home-preview-size">{screen.width} × {screen.height} · {Math.round(editScale * 100)}% preview</span>
        <span className="home-layout-status" role="status">{status}</span>
      </> : <>{actions}{editable && <Button variant="outline" size="sm" className="ml-auto" onClick={() => setEditing(true)}>Edit layout</Button>}</>}
    </div>
    {editing && <aside className="home-layout-sidebar bg-card text-card-foreground border-border" aria-label="Widget settings">
      <h2 className="text-sm font-medium">Customize Home</h2>
      <p className="text-xs text-muted-foreground">Click a widget in the preview to edit it.</p>
      <div className="home-widget-list" aria-label="Home widgets">{widgetIds.map(id => <Button key={id} variant={selectedGroup === id ? "secondary" : "ghost"} size="sm" aria-pressed={selectedGroup === id} onClick={() => setSelectedGroup(id)}>{widgetNames[id]}{layout.tiles.find(t => t.id === id)?.hidden ? " (hidden)" : ""}</Button>)}</div>
      <section className="home-inspector-section border-border" aria-labelledby="home-selected-title">
        <h3 id="home-selected-title" className="text-sm font-medium">{widgetNames[selectedGroup]}</h3>
        <div className="home-inspector-row"><label htmlFor="home-widget-visible">Show widget</label><Switch id="home-widget-visible" checked={!group.hidden} aria-describedby={layoutError ? "home-layout-error" : undefined} onCheckedChange={visible => commit(setWidgetVisible(layout, selectedGroup, visible))} /></div>
        {layoutError && <p id="home-layout-error" className="text-xs text-destructive" role="alert">{layoutError}</p>}
        <fieldset disabled={group.hidden} className="home-inspector-fields">
          <legend className="text-xs text-muted-foreground">Position &amp; size · grid cells</legend>
          <div className="home-size-fields">{(["x", "y", "w", "h"] as const).map(key => <label key={key}>{({ x: "Left", y: "Top", w: "Width", h: "Height" })[key]}<Input aria-label={`Widget ${{ x: "left", y: "top", w: "width", h: "height" }[key]}`} type="number" value={group[key]} min={key === "w" ? minimumWidth(group.id, columns) : key === "h" ? minimum[group.id][1] : 0} max={key === "x" ? columns - group.w : key === "y" ? screenRows - group.h : key === "w" ? columns - group.x : screenRows - group.y} onChange={e => { if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber)) commit(rearrange(layout, boundedTile({ ...group, [key]: e.target.valueAsNumber }, columns))); }} /></label>)}</div>
          <span className="text-xs text-muted-foreground">Align widget to screen</span>
          <div className="home-alignment-buttons">{(["Left", "Center", "Right", "Top", "Middle", "Bottom"] as const).map(align => <Button key={align} variant="outline" size="sm" onClick={() => commit(rearrange(layout, { ...group, ...(align === "Left" ? { x: 0 } : align === "Center" ? { x: Math.round((columns - group.w) / 2) } : align === "Right" ? { x: columns - group.w } : align === "Top" ? { y: 0 } : align === "Middle" ? { y: Math.round((screenRows - group.h) / 2) } : { y: screenRows - group.h }) }))}>{align}</Button>)}</div>
          {selectedGroup === "buddy" && <>
            <span className="text-xs text-muted-foreground">Style</span>
            <div className="home-option-buttons">{buddyVariants.map(value => <Button key={value} variant={(group.variant ?? "cat") === value ? "secondary" : "outline"} size="sm" aria-pressed={(group.variant ?? "cat") === value} onClick={() => customize({ variant: value })}>{value === "cat" ? "Cat" : "Simple"}</Button>)}</div>
            <p className="text-xs text-muted-foreground">Your little desk companion mirrors mouse movement and keyboard activity. No typed text is stored.</p>
          </>}
          {selectedGroup !== "clocks" && selectedGroup !== "digest" && selectedGroup !== "buddy" && <>
            <span className="text-xs text-muted-foreground">Direction</span>
            <div className="home-option-buttons">{(["row", "column"] as const).map(value => <Button key={value} variant={direction(group) === value ? "secondary" : "outline"} size="sm" aria-pressed={direction(group) === value} onClick={() => customize({ direction: value })}>{value === "row" ? "Row" : "Column"}</Button>)}</div>
            <span className="text-xs text-muted-foreground">Appearance</span>
            <div className="home-option-buttons">{[false, true].map(value => <Button key={String(value)} variant={labels(group) === value ? "secondary" : "outline"} size="sm" aria-pressed={labels(group) === value} onClick={() => customize({ labels: value })}>{value ? "Icons + text" : "Icons only"}</Button>)}</div>
            {(["horizontal", "vertical"] as const).map(axis => <fieldset key={axis} className="home-content-alignment">
              <legend className="text-xs text-muted-foreground">{axis === "horizontal" ? "Horizontal alignment" : "Vertical alignment"}</legend>
              <div className="home-option-buttons">{(["start", "center", "end"] as const).map(value => <Button key={value} variant={(axis === "horizontal" ? horizontal(group) : vertical(group)) === value ? "secondary" : "outline"} size="sm" aria-pressed={(axis === "horizontal" ? horizontal(group) : vertical(group)) === value} onClick={() => customize(axis === "horizontal" ? { alignX: value } : { alignY: value })}>{axis === "horizontal" ? ({ start: "Left", center: "Center", end: "Right" })[value] : ({ start: "Top", center: "Middle", end: "Bottom" })[value]}</Button>)}</div>
            </fieldset>)}
          </>}
        </fieldset>
      </section>
      <p className="text-xs text-muted-foreground">Drag a title or resize a corner. Arrow keys move the focused handle one cell. Other widgets make room automatically.</p>
    </aside>}
    <div ref={surface} className="home-screen-frame" aria-label={editing ? "Screen layout preview" : "Home screen layout"} style={{ width: screen.width, height: screen.height, transform: `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})` }}>
      <div className="home-layout-board" style={{ width, height, "--home-step": `${step}px`, "--home-row": `${rowHeight}px` } as CSSProperties}>
        {shown.tiles.filter(t => !t.hidden).map(tile => {
          const current = moving?.id === tile.id ? moving : null;
          const x = tile.x * step, y = tile.y * rowHeight;
          const w = tile.w * step - gap, h = tile.h * rowHeight - gap;
          return <div className={`home-widget home-widget-${tile.id}${current ? " home-widget-moving" : ""}`} key={tile.id} data-widget={tile.id} data-selected={editing && selectedGroup === tile.id} onPointerDownCapture={() => { if (editing) setSelectedGroup(tile.id); }} data-align-x={horizontal(tile)} data-align-y={vertical(tile)} data-direction={direction(tile)} data-labels={labels(tile)} style={{ transform: `translate3d(${x}px, ${y}px, 0)`, width: Math.max(0, w), height: h }}>
            {editing && <button className="home-widget-grip" aria-label={`Move ${widgetNames[tile.id]}`} onPointerDown={e => begin(e, tile, false)} onPointerMove={e => update(e.clientX, e.clientY)} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={e => keyboard(e, tile, false)}><span aria-hidden="true">⠿</span>{widgetNames[tile.id]}</button>}
            <div className="home-widget-content" inert={editing}>{(w => typeof w === "function" ? w(tile) : w)(widgets[tile.id])}</div>
            {editing && <button className="home-widget-resize" aria-label={`Resize ${widgetNames[tile.id]}`} title="Drag to resize, or use arrow keys" onPointerDown={e => begin(e, tile, true)} onPointerMove={e => update(e.clientX, e.clientY)} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={e => keyboard(e, tile, true)}>↘</button>}
          </div>;
        })}
        {moving && preview && (() => { const tile = preview.tiles.find(t => t.id === moving.id)!; return <div className="home-drop-guide" aria-hidden="true" style={{ transform: `translate(${tile.x * step}px, ${tile.y * rowHeight}px)`, width: tile.w * step - gap, height: tile.h * rowHeight - gap }} />; })()}
        {!shown.tiles.some(t => !t.hidden) && <p className="home-layout-empty">All widgets are hidden. Use Edit layout to bring them back.</p>}
      </div>
    </div>
  </div>;
}
