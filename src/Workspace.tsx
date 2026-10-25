import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, BellIcon, CheckSquareIcon, EnvelopeSimpleIcon, NotepadIcon, SlidersHorizontalIcon, XIcon, CalendarIcon, FolderIcon, SparkleIcon, ClipboardTextIcon, DotsSixIcon, ArrowDownRightIcon, CornersOutIcon, CornersInIcon, MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Productivity, ReminderAlerts, useProductivity } from "./productivity";
import { Email } from "./Email";
import { Notes } from "./Notes";
import { adjacentPanel, defaultScrollingLayout, gridGeometry, placeGridPanel, verticalGridNeighbor, withStacks, type GridCell, type ScrollingLayout, type WorkspaceId } from "./workspace-layout";
import "./Workspace.css";
import { useSpaces } from "./workspace-store";
import { Agenda, FilesLinks, ClipboardPanel, WorkspaceAI } from "./WorkspaceApps";
import { ManageSpaces, QuickCapture, WorkspaceSearch } from "./WorkspaceDialogs";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const apps = [
  { id: "emails", title: "Emails", icon: EnvelopeSimpleIcon },
  { id: "reminders", title: "Reminders", icon: BellIcon },
  { id: "todos", title: "Todos", icon: CheckSquareIcon },
  { id: "notes", title: "Notes", icon: NotepadIcon },
  { id: "agenda", title: "Agenda", icon: CalendarIcon },
  { id: "files", title: "Files & Links", icon: FolderIcon },
  { id: "ai", title: "AI", icon: SparkleIcon },
  { id: "clipboard", title: "Clipboard", icon: ClipboardTextIcon },
] as const;
export function Workspace({ active, onHome, onSettings }: { active: boolean; onHome: () => void; onSettings: () => void }) {
  const spaces = useSpaces();
  const layout = spaces.space.layout;
  const saved = !spaces.error;
  function setLayout(change: ScrollingLayout | ((current: ScrollingLayout) => ScrollingLayout)) {
    spaces.update(current => ({ ...current, spaces: current.spaces.map(space => space.id === current.activeId ? { ...space, layout: typeof change === "function" ? change(space.layout) : change } : space) }));
  }
  useEffect(() => {
    const openNote = (event: Event) => {
      const spaceId = (event as CustomEvent<string>).detail;
      cancelDrag(); setMaximized(null); setFocused("notes");
      spaces.update(current => ({ ...current, activeId: spaceId, spaces: current.spaces.map(space => space.id !== spaceId || space.layout.open.includes("notes") ? space : { ...space, layout: withStacks(space.layout, [...space.layout.stacks, ["notes"]]) }) }));
    };
    window.addEventListener("wallp:open-note", openNote);
    return () => window.removeEventListener("wallp:open-note", openNote);
  }, []);
  const [managing, setManaging] = useState(false);
  const [searching, setSearching] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [maximized, setMaximized] = useState<WorkspaceId | null>(null);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<WorkspaceId>(() => layout.open[0] ?? "emails");
  const [focused, setFocused] = useState<WorkspaceId>(() => layout.open[0] ?? "emails");

  const [screen, setScreen] = useState({ width: window.innerWidth, height: window.innerHeight });
  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const panels = useRef<Partial<Record<WorkspaceId, HTMLElement | null>>>({});
  const focusRef = useRef(focused);
  focusRef.current = focused;
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const data = useProductivity();
  const compact = screen.width < 760;
  const canvasHeight = Math.max(1, screen.height - 100);
  const viewport = Math.max(1, screen.width - 24);
  const sidebarSpace = compact ? 0 : 304;
  const availableHeight = Math.max(60, canvasHeight - 100 - (compact ? Math.min(380, screen.height * .48) + 12 : 0));
  const editScale = Math.max(.1, Math.min(.86, (screen.width - sidebarSpace - 48) / screen.width, availableHeight / canvasHeight));
  const scale = editing ? editScale : 1;
  const offsetX = editing ? (screen.width - sidebarSpace - screen.width * scale) / 2 : 0;
  const offsetY = editing ? 72 + (availableHeight - canvasHeight * scale) / 2 : 0;
  const geometry = gridGeometry(layout, viewport);
  const navigationOrder = geometry.stops.map(panel => panel.id);

  useLayoutEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setScreen({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(scrollTimer.current), []);
  function reveal(id: WorkspaceId, smooth = true) {
    const panel = panels.current[id];
    if (!panel || !area.current) return;
    area.current.scrollTo({ left: geometry.panels.find(item => item.id === id)?.snap ?? 0, behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant" });
  }
  useLayoutEffect(() => {
    const id = layout.open.includes(focusRef.current) ? focusRef.current : layout.open[0];
    if (id) { setFocused(id); reveal(id, false); }
  }, [layout, screen.width, editing]);
  function focusPanel(id: WorkspaceId) {
    setMaximized(null);
    setFocused(id); setSelected(id);
    panels.current[id]?.focus({ preventScroll: true });
    reveal(id);
  }
  function navigate(direction: number) {
    const next = adjacentPanel(navigationOrder, focused, direction);
    if (next) focusPanel(next);
  }
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") { event.preventDefault(); setSearching(true); return; }
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      // Leave dialogs and popovers in charge of their own keyboard interaction.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [data-state="open"][role="menu"]')) return;
      event.preventDefault();
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const next = verticalGridNeighbor(layout, focused, event.key === "ArrowUp" ? -1 : 1);
        if (next) focusPanel(next);
      } else navigate(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, focused, layout, screen.width]);
  function showPanel(id: WorkspaceId, visible: boolean) {
    setMaximized(null);
    if (visible) {
      setFocused(id); setSelected(id);
      setLayout(current => current.open.includes(id) ? current : withStacks(current, [...current.stacks, [id]]));
      requestAnimationFrame(() => panels.current[id]?.focus({ preventScroll: true }));
    } else {
      const index = layout.open.indexOf(id);
      const remaining = layout.open.filter(other => other !== id);
      const next = remaining[Math.min(index, remaining.length - 1)];
      const restoreFocus = focused === id || panels.current[id]?.contains(document.activeElement);
      if (restoreFocus && next) setFocused(next);
      setLayout(current => withStacks(current, current.stacks.map(stack => stack.filter(other => other !== id))));
      if (!restoreFocus) return;
      if (next) requestAnimationFrame(() => panels.current[next]?.focus({ preventScroll: true }));
      else requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[aria-label="Open Emails"]')?.focus());
    }
  }
  const [drag, setDrag] = useState<{ id: WorkspaceId; cell: GridCell; columns: number } | null>(null);
  const gesture = useRef<{ id: WorkspaceId; x: number; y: number; scroll: number; cell: GridCell; latest: GridCell; resize: boolean } | null>(null);
  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, id: WorkspaceId, resize: boolean) {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const cell = geometry.grid.cells[id]!;
    gesture.current = { id, x: event.clientX, y: event.clientY, scroll: area.current?.scrollLeft ?? 0, cell, latest: cell, resize };
    setSelected(id); setDrag({ id, cell, columns: geometry.columns });
  }
  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current) return;
    const dx = Math.round((event.clientX - current.x + ((area.current?.scrollLeft ?? 0) - current.scroll) * scale) / (geometry.step * scale));
    const dy = Math.round((event.clientY - current.y) / ((area.current?.querySelector(".workspace-grid-board")?.getBoundingClientRect().height ?? (canvasHeight - 24) * scale) / geometry.grid.rows));
    const target = current.resize ? { ...current.cell, width: current.cell.width + dx, height: current.cell.height + dy } : { ...current.cell, col: current.cell.col + dx, row: current.cell.row + dy };
    current.latest = placeGridPanel(layout, current.id, target).grid!.cells[current.id]!;
    // Keep every column reached during this gesture until release. Shrinking the
    // board sooner clamps scrollLeft and moves the resize handle under the mouse.
    const cell = current.latest;
    setDrag(previous => ({ id: current.id, cell, columns: Math.max(previous?.columns ?? geometry.columns, cell.col + cell.width - 1) }));
  }
  function cancelDrag() { gesture.current = null; setDrag(null); }
  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    moveDrag(event);
    const current = gesture.current;
    if (current) setLayout(layout => placeGridPanel(layout, current.id, current.latest));
    cancelDrag();
  }
  function handleGridKey(event: ReactKeyboardEvent<HTMLButtonElement>, id: WorkspaceId, resize: boolean) {
    if (event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const cell = geometry.grid.cells[id]!;
    const dx = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const dy = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    setLayout(layout => placeGridPanel(layout, id, resize ? { ...cell, width: cell.width + dx, height: cell.height + dy } : { ...cell, col: cell.col + dx, row: cell.row + dy }));
  }
  function finishEditing() { cancelDrag(); setEditing(false); requestAnimationFrame(() => panels.current[focused]?.focus({ preventScroll: true })); }
  const selectedIndex = layout.open.indexOf(selected);
  const focusedIndex = navigationOrder.indexOf(focused);
  const selectedCell = geometry.grid.cells[selected];
  const boardColumns = Math.max(geometry.columns, drag?.columns ?? 0);
  return <div ref={root} className={`workspace-shell${editing ? " layout-editing" : ""}`} onKeyDown={event => { if (event.key === "Escape" && drag) { event.preventDefault(); cancelDrag(); } else if (event.key === "Escape" && maximized) { event.preventDefault(); setMaximized(null); } else if (event.key === "Escape" && editing) { event.preventDefault(); finishEditing(); } }}>
    <header className="workspace-spacebar border-b border-border bg-card text-card-foreground">
      <select className="workspace-select" aria-label="Active workspace" value={spaces.state.activeId} onChange={event => { const id = event.target.value; cancelDrag(); setMaximized(null); spaces.update(current => ({ ...current, activeId: id })); }}>
        {spaces.state.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
      </select>
      <Button variant="ghost" size="sm" onClick={() => setManaging(true)}>Manage</Button>
      <Button variant="outline" size="sm" onClick={() => setSearching(true)}><MagnifyingGlassIcon />Search<span className="hidden sm:inline"> Ctrl+K</span></Button>
      <Button variant="outline" size="sm" onClick={() => setCapturing(true)}><PlusIcon />Capture</Button>
      {spaces.error && <span role="alert" className="truncate text-xs text-destructive" title={spaces.error}>{spaces.error}</span>}
    </header>
    {managing && <ManageSpaces key={spaces.space.id} onClose={() => setManaging(false)} />}
    {searching && <WorkspaceSearch onClose={() => setSearching(false)} onOpen={(app, spaceId) => { setMaximized(null); if (spaceId) spaces.update(current => ({ ...current, activeId: spaceId, spaces: current.spaces.map(space => space.id === spaceId ? { ...space, layout: space.layout.open.includes(app) ? space.layout : withStacks(space.layout, [...space.layout.stacks, [app]]) } : space) })); else showPanel(app, true); setFocused(app); }} />}
    <Dialog open={capturing} onOpenChange={setCapturing}><DialogContent><DialogTitle>Quick capture</DialogTitle><DialogDescription>Save a note, task, reminder, or link. Ctrl+Enter saves.</DialogDescription><QuickCapture onClose={() => setCapturing(false)} /></DialogContent></Dialog>
    {editing && <>
      <div className="workspace-edit-toolbar" aria-label="Workspace layout controls">
        <span className="text-xs font-medium">Make space for your work</span>
        <Button variant="ghost" size="sm" onClick={() => { setFocused(defaultScrollingLayout.open[0]); setSelected(defaultScrollingLayout.open[0]); setLayout({ open: [...defaultScrollingLayout.open], stacks: defaultScrollingLayout.stacks.map(stack => [...stack]), widths: { ...defaultScrollingLayout.widths } }); }}>Reset</Button>
        <Button size="sm" onClick={finishEditing}>Done</Button>
      </div>
      <aside className="workspace-layout-sidebar bg-card text-card-foreground border-border" aria-label="Workspace settings">
        <h2 className="text-sm font-medium">Customize Workspace</h2>
        <p className="text-xs text-muted-foreground">Drag and resize panels on the grid. Extra columns extend beyond the desktop.</p>
        <div className="workspace-panel-list" aria-label="Workspace panels">{apps.map(({ id, title }) => <Button key={id} variant={selected === id ? "secondary" : "ghost"} size="sm" aria-pressed={selected === id} onClick={() => { setSelected(id); if (layout.open.includes(id)) focusPanel(id); }}>{title}{layout.open.includes(id) ? "" : " (hidden)"}</Button>)}</div>
        <section className="workspace-inspector-section border-border" aria-labelledby="workspace-selected-title">
          <h3 id="workspace-selected-title" className="text-sm font-medium">{apps.find(app => app.id === selected)!.title}</h3>
          <div className="workspace-inspector-row"><label htmlFor="workspace-panel-visible">Show panel</label><Switch id="workspace-panel-visible" checked={layout.open.includes(selected)} onCheckedChange={visible => showPanel(selected, visible)} /></div>
          <fieldset disabled={selectedIndex < 0} className="workspace-inspector-fields gap-3">
            <legend className="text-xs text-muted-foreground">Position &amp; size in grid cells</legend>
            <div className="workspace-size-fields">{(["col", "row", "width", "height"] as const).map(key => <label key={key}>{({ col: "Column", row: "Row", width: "Width", height: "Height" })[key]}<Input aria-label={`Panel ${key}`} type="number" min={1} max={key === "col" ? 120 : key === "width" ? 24 : key === "row" ? geometry.grid.rows - (selectedCell?.height ?? 1) + 1 : geometry.grid.rows} value={selectedCell?.[key] ?? 1} onChange={event => { if (selectedCell && Number.isFinite(event.target.valueAsNumber)) setLayout(current => placeGridPanel(current, selected, { ...selectedCell, [key]: event.target.valueAsNumber })); }} /></label>)}</div>
          </fieldset>
        </section>
        <section className="workspace-inspector-section border-border"><h3 className="text-sm font-medium">Grid</h3><div className="workspace-size-fields">{(["columns", "rows"] as const).map(key => <label key={key}>{key === "columns" ? "Columns per screen" : "Rows"}<Input aria-label={`Grid ${key}`} type="number" min={2} max={key === "columns" ? 24 : 12} value={geometry.grid[key]} onChange={event => { if (!Number.isFinite(event.target.valueAsNumber)) return; const value = Math.max(2, Math.min(key === "columns" ? 24 : 12, Math.round(event.target.valueAsNumber))); const grid = { ...geometry.grid, [key]: value, cells: { ...geometry.grid.cells } }; if (key === "rows") for (const id of Object.keys(grid.cells) as WorkspaceId[]) { const cell = grid.cells[id]!; const height = Math.min(cell.height, value); grid.cells[id] = { ...cell, height, row: Math.min(cell.row, value - height + 1) }; } let next = { ...layout, grid }; for (const id of next.open) next = placeGridPanel(next, id, next.grid!.cells[id]!) as typeof next; setLayout(next); }} /></label>)}</div><Button variant="outline" size="sm" onClick={() => setLayout(current => ({ ...current, grid: undefined }))}>Auto arrange</Button></section>
        <p className="text-xs text-muted-foreground">Drag a grip or resize a corner. Arrow keys adjust the focused handle. Alt + Left / Right visits panels by their right edge; Alt + Up / Down moves vertically. Navigation snaps each target to the desktop's right edge.</p>
        <p className={`text-xs ${saved ? "text-muted-foreground" : "text-destructive"}`} role="status">{saved ? "Layout saved" : "Layout not saved. Storage is unavailable."}</p>
      </aside>
    </>}
    <div className="workspace-screen-frame border-border bg-background" aria-label={editing ? "Workspace layout preview" : "Workspace layout"} style={{ width: screen.width, height: canvasHeight, transform: `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})` }}>
      <div className="workspace-scroller" ref={area} aria-label="Scrolling workspace" style={drag ? { scrollSnapType: "none" } : undefined} onScroll={() => {
        clearTimeout(scrollTimer.current);
        scrollTimer.current = setTimeout(() => {
          if (!area.current || !layout.open.length) return;
          const left = area.current.scrollLeft;
          const nearest = geometry.stops.reduce((best, panel) => Math.abs(panel.snap - left) < Math.abs((geometry.stops.find(item => item.id === best)?.snap ?? 0) - left) ? panel.id : best, layout.open.includes(focusRef.current) ? focusRef.current : layout.open[0]);
          setFocused(nearest);
        }, 150);
      }}>
        {!layout.open.length && <div className="workspace-empty">Your space, your layout.<small>Open an app from the toolbar to get started.</small></div>}
        <div className="workspace-grid-board" style={{ width: boardColumns * geometry.step, gridTemplateColumns: `repeat(${boardColumns}, ${geometry.step}px)`, gridTemplateRows: `repeat(${geometry.grid.rows}, minmax(0, 1fr))` }}>
        {editing && Array.from({ length: boardColumns * geometry.grid.rows }, (_, index) => <div key={index} className="workspace-grid-cell" aria-hidden="true" style={{ gridColumn: index % boardColumns + 1, gridRow: Math.floor(index / boardColumns) + 1 }} />)}
        {layout.open.map(id => {
          const cell = drag?.id === id ? drag.cell : geometry.grid.cells[id]!;
          const { title, icon: AppIcon } = apps.find(app => app.id === id)!;
          return <section key={id} ref={element => { panels.current[id] = element; }} id={`app-${id}`} aria-labelledby={`app-title-${id}`} tabIndex={-1} className={`app-panel workspace-column${maximized === id ? " workspace-maximized" : ""}`} inert={!!maximized && maximized !== id} style={maximized === id ? undefined : { gridColumn: `${cell.col} / span ${cell.width}`, gridRow: `${cell.row} / span ${cell.height}` }} onPointerDownCapture={() => { setSelected(id); setFocused(id); }} onFocusCapture={() => { setFocused(id); setSelected(id); }}>
            <header className="app-titlebar"><div><AppIcon size={17} weight="light" /><h2 id={`app-title-${id}`}>{title}</h2>{editing && <small className="panel-span">{cell.width} x {cell.height}</small>}</div><div>{editing && <Button variant="ghost" size="icon-sm" aria-label={`Move ${title}`} className="workspace-grid-grip" onPointerDown={event => beginDrag(event, id, false)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onKeyDown={event => handleGridKey(event, id, false)}><DotsSixIcon /></Button>}<Button variant="ghost" size="icon-sm" disabled={editing} aria-label={`${maximized === id ? "Restore" : "Maximize"} ${title}`} onClick={() => { setMaximized(maximized === id ? null : id); setFocused(id); }}>{maximized === id ? <CornersInIcon /> : <CornersOutIcon />}</Button><Button variant="ghost" size="icon-sm" aria-label={`Close ${title}`} onClick={() => showPanel(id, false)}><XIcon /></Button></div></header>
            <div className="app-body" inert={editing}>{id === "emails" ? <Email /> : id === "notes" ? <Notes key={spaces.space.id} spaceId={spaces.space.id} /> : id === "agenda" ? <Agenda data={data} /> : id === "files" ? <FilesLinks key={spaces.space.id} spaceId={spaces.space.id} /> : id === "clipboard" ? <ClipboardPanel spaceId={spaces.space.id} /> : id === "ai" ? <WorkspaceAI /> : <Productivity kind={id} data={data} />}</div>
            {editing && <Button variant="secondary" size="icon-sm" className="workspace-grid-resize" aria-label={`Resize ${title}`} onPointerDown={event => beginDrag(event, id, true)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onKeyDown={event => handleGridKey(event, id, true)}><ArrowDownRightIcon /></Button>}
          </section>;
        })}
        </div>
      </div>
    </div>
    <nav className="workspace-toolbar" aria-label="Workspace apps">
      <Button variant="ghost" size="icon" aria-label="Back to home" title="Back to home" onClick={onHome}><ArrowUpIcon /></Button>
      <Button variant="ghost" size="icon" aria-label="Previous panel" title="Previous panel (Alt + Left)" disabled={focusedIndex <= 0} onClick={() => navigate(-1)}><ArrowLeftIcon /></Button>
      <Button variant="ghost" size="icon" aria-label="Next panel" title="Next panel (Alt + Right)" disabled={focusedIndex < 0 || focusedIndex >= layout.open.length - 1} onClick={() => navigate(1)}><ArrowRightIcon /></Button>
      <span className="toolbar-divider" />
      {apps.map(({ id, title, icon: AppIcon }) => <Button key={id} variant="ghost" size="icon" className="toolbar-app" data-open={layout.open.includes(id)} aria-label={`Open ${title}`} title={title} aria-controls={`app-${id}`} aria-expanded={layout.open.includes(id)} onClick={() => { if (layout.open.includes(id)) focusPanel(id); else showPanel(id, true); }}><AppIcon size={19} weight="light" /><span className="toolbar-indicator" /></Button>)}
      <span className="toolbar-divider" /><Button variant="ghost" aria-pressed={editing} onClick={() => { if (editing) finishEditing(); else { setMaximized(null); setEditing(true); } }}>Customize</Button>
      <Button variant="ghost" size="icon" aria-label="Settings" title="Settings" onClick={onSettings}><SlidersHorizontalIcon /></Button>

    </nav>
    <ReminderAlerts data={data} />
  </div>;
}
