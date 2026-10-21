import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowUpIcon, BellIcon, CheckSquareIcon, EnvelopeSimpleIcon, NotepadIcon, SlidersHorizontalIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Productivity, ReminderAlerts, useProductivity } from "./productivity";
import { Email } from "./Email";
import { Notes } from "./Notes";

const apps = [
  { id: "emails", title: "Emails", icon: EnvelopeSimpleIcon },
  { id: "reminders", title: "Reminders", icon: BellIcon },
  { id: "todos", title: "Todos", icon: CheckSquareIcon },
  { id: "notes", title: "Notes", icon: NotepadIcon },
] as const;
type AppId = typeof apps[number]["id"];
type Cell = { col: number; row: number; width: number; height: number };
type Layout = { columns: number; rows: number; open: AppId[]; cells: Record<AppId, Cell> };
const defaults: Layout = { columns: 12, rows: 8, open: apps.map(a => a.id), cells: {
  emails: { col: 1, row: 1, width: 6, height: 4 }, reminders: { col: 7, row: 1, width: 6, height: 4 },
  todos: { col: 1, row: 5, width: 6, height: 4 }, notes: { col: 7, row: 5, width: 6, height: 4 },
} };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const overlaps = (a: Cell, b: Cell) => a.col < b.col + b.width && a.col + a.width > b.col && a.row < b.row + b.height && a.row + a.height > b.row;
function bounded(cell: Cell, columns: number, rows: number): Cell {
  const width = clamp(Math.round(cell.width), 1, columns), height = clamp(Math.round(cell.height), 1, rows);
  return { width, height, col: clamp(Math.round(cell.col), 1, columns - width + 1), row: clamp(Math.round(cell.row), 1, rows - height + 1) };
}
// Keep the dropped panel in place, then fit any displaced panels into whole cells.
function place(layout: Layout, id: AppId, target: Cell): Layout | null {
  const cells = { ...layout.cells, [id]: bounded(target, layout.columns, layout.rows) };
  const occupied = [cells[id]];
  const displaced: AppId[] = [];
  for (const other of layout.open.filter(a => a !== id)) {
    if (overlaps(cells[id], cells[other])) displaced.push(other);
    else occupied.push(cells[other]);
  }
  for (const other of displaced) {
    const current = cells[other];
    const old = layout.cells[id];
    let found: Cell | undefined;
    const swapped = { ...current, col: old.col, row: old.row };
    if (swapped.col + swapped.width <= layout.columns + 1 && swapped.row + swapped.height <= layout.rows + 1 && occupied.every(r => !overlaps(r, swapped))) found = swapped;
    for (let row = 1; !found && row <= layout.rows - current.height + 1; row++) {
      for (let col = 1; col <= layout.columns - current.width + 1; col++) {
        const trial = { ...current, row, col };
        if (occupied.every(r => !overlaps(r, trial))) { found = trial; break; }
      }
    }
    if (!found) return null;
    cells[other] = found; occupied.push(found);
  }
  return { ...layout, cells };
}
function tiled(open: AppId[], columns: number, rows: number, mode = "grid", previous = defaults.cells): Layout {
  const cells = { ...previous };
  const across = mode === "columns" ? Math.min(open.length, columns) : Math.min(2, open.length, columns);
  const bands = Math.max(1, Math.ceil(open.length / Math.max(1, across)));
  const safeRows = Math.max(rows, bands);
  open.forEach((id, i) => {
    const start = Math.floor((i % across) * columns / across), end = Math.floor(((i % across) + 1) * columns / across);
    const top = Math.floor(Math.floor(i / across) * safeRows / bands), bottom = Math.floor((Math.floor(i / across) + 1) * safeRows / bands);
    cells[id] = { col: start + 1, row: top + 1, width: end - start, height: bottom - top };
  });
  return { columns, rows: safeRows, open, cells };
}
function loadLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem("wallp.grid-layout") || "null");
    // Migrate the old combined panel while preserving other panel placements.
    if (v && Array.isArray(v.open) && v.open.includes("tasks")) {
      if (!v.open.includes("todos") && v.cells?.tasks) v.cells.todos = v.cells.tasks;
      v.open = [...new Set(v.open.map((id: string) => id === "tasks" ? "todos" : id))];
    }
    if (v?.cells) delete v.cells.tasks;
    // New apps stay closed in saved layouts until opened from the toolbar.
    if (v?.cells && !v.cells.notes) v.cells.notes = bounded(defaults.cells.notes, v.columns, v.rows);
    if (v && Number.isInteger(v.columns) && v.columns >= 2 && v.columns <= 12 && Number.isInteger(v.rows) && v.rows >= 2 && v.rows <= 12 && Array.isArray(v.open) && new Set(v.open).size === v.open.length && v.open.every((id: AppId) => apps.some(a => a.id === id)) && apps.every(({ id }) => {
      const c = v.cells?.[id]; return c && [c.col, c.row, c.width, c.height].every(Number.isInteger) && c.col >= 1 && c.row >= 1 && c.width >= 1 && c.height >= 1 && c.col + c.width <= v.columns + 1 && c.row + c.height <= v.rows + 1;
    }) && v.open.every((id: AppId, i: number) => v.open.slice(i + 1).every((other: AppId) => !overlaps(v.cells[id], v.cells[other])))) return v;
  } catch { /* Recover from invalid storage. */ }
  return defaults;
}
type Preview = { id: AppId; cell: Cell; valid: boolean; result: Layout | null };
const style = (c: Cell) => ({ gridColumn: `${c.col} / span ${c.width}`, gridRow: `${c.row} / span ${c.height}` });
export function Workspace({ onHome, onSettings }: { onHome: () => void; onSettings: () => void }) {
  const [layout, setLayout] = useState(loadLayout);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<AppId>("todos");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(true);
  const area = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const toolbar = useRef<Partial<Record<AppId, HTMLButtonElement | null>>>({});
  const data = useProductivity();
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    try { localStorage.setItem("wallp.grid-layout", JSON.stringify(layout)); setSaved(true); }
    catch { setSaved(false); }
  }, [layout]);
  function commit(id: AppId, cell: Cell) {
    const next = place(layout, id, cell);
    if (next) { setLayout(next); setNotice(""); }
    else setNotice("Not enough room. Shrink a panel, close one, or add rows or columns.");
  }
  function begin(e: PointerEvent<HTMLButtonElement>, id: AppId, resize: boolean) {
    if (e.button !== 0 || !area.current) return;
    cleanup.current?.(); e.preventDefault();
    const element = e.currentTarget, pointerId = e.pointerId;
    element.setPointerCapture(pointerId);
    const bounds = area.current.getBoundingClientRect(), startX = e.clientX, startY = e.clientY, original = layout.cells[id];
    let latest: Preview = { id, cell: original, valid: true, result: layout };
    let frame = 0;
    setSelected(id); setNotice(""); setPreview(latest);
    function calculate(event: globalThis.PointerEvent) {
      const dx = Math.round((event.clientX - startX) / (bounds.width / layout.columns));
      const dy = Math.round((event.clientY - startY) / (bounds.height / layout.rows));
      const cell = bounded(resize ? { ...original, width: original.width + dx, height: original.height + dy, col: original.col, row: original.row } : { ...original, col: original.col + dx, row: original.row + dy }, layout.columns, layout.rows);
      if (resize) { cell.col = original.col; cell.row = original.row; cell.width = Math.min(cell.width, layout.columns - cell.col + 1); cell.height = Math.min(cell.height, layout.rows - cell.row + 1); }
      const result = place(layout, id, cell);
      latest = { id, cell, valid: !!result, result };
    }
    const onMove = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      calculate(event);
      if (!frame) frame = requestAnimationFrame(() => { setPreview(latest); frame = 0; });
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey);
      element.removeEventListener("lostpointercapture", onCancel);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      cleanup.current = null;
    };
    const onUp = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      calculate(event); stop(); setPreview(null);
      if (latest.result) setLayout(latest.result);
      else setNotice("No room at that position. Try a smaller span or add more rows.");
    };
    const onCancel = () => { stop(); setPreview(null); };
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    cleanup.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey);
    element.addEventListener("lostpointercapture", onCancel);
  }
  function keyMove(e: KeyboardEvent<HTMLButtonElement>, id: AppId, resize: boolean) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault(); const c = layout.cells[id];
    const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0, dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    commit(id, resize ? { ...c, width: clamp(c.width + dx, 1, layout.columns - c.col + 1), height: clamp(c.height + dy, 1, layout.rows - c.row + 1) } : { ...c, col: c.col + dx, row: c.row + dy });
  }
  function changeGrid(columns: number, rows: number) {
    setLayout(tiled(layout.open, columns, rows, "grid", Object.fromEntries(apps.map(a => [a.id, bounded(layout.cells[a.id], columns, rows)])) as Record<AppId, Cell>)); setNotice("");
  }
  const active = layout.cells[selected];
  return <div className={`workspace-shell${editing ? " layout-editing" : ""}`}>
    {editing && <div className="grid-controls">
      <div className="grid-control-group"><label>Columns<select aria-label="Grid columns" value={layout.columns} onChange={e => changeGrid(+e.target.value, layout.rows)}>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i + 2}>{i + 2}</option>)}</select></label><label>Rows<select aria-label="Grid rows" value={layout.rows} onChange={e => changeGrid(layout.columns, +e.target.value)}>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i + 2}>{i + 2}</option>)}</select></label></div>
      <div className="grid-control-group"><select aria-label="Panel to customize" value={selected} onChange={e => setSelected(e.target.value as AppId)}>{apps.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select><label>Wide<select aria-label="Panel column span" value={active.width} onChange={e => commit(selected, { ...active, width: +e.target.value, col: Math.min(active.col, layout.columns - +e.target.value + 1) })}>{Array.from({ length: layout.columns }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label><label>Tall<select aria-label="Panel row span" value={active.height} onChange={e => commit(selected, { ...active, height: +e.target.value, row: Math.min(active.row, layout.rows - +e.target.value + 1) })}>{Array.from({ length: layout.rows }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label></div>
      <div className="grid-control-group"><Button variant="ghost" onClick={() => setLayout(tiled(layout.open, layout.columns, layout.rows, "grid", layout.cells))}>Grid</Button><Button variant="ghost" onClick={() => setLayout(tiled(layout.open, layout.columns, layout.rows, "columns", layout.cells))}>Columns</Button><Button variant="ghost" onClick={() => { setLayout(defaults); setNotice(""); }}>Reset</Button><Button onClick={() => setEditing(false)}>Done</Button></div>
      <p className="grid-hint" role="status">{notice || "Drag the grip to snap into cells. Drag a corner to change spans. Panels swap when there’s room."}</p>
    </div>}
    <div className={`workspace-canvas snap-grid${preview ? " is-dragging" : ""}`} ref={area} style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))` }}>
      {editing && Array.from({ length: layout.columns * layout.rows }, (_, i) => <div key={i} className="grid-cell" aria-hidden="true" style={{ gridColumn: i % layout.columns + 1, gridRow: Math.floor(i / layout.columns) + 1 }} />)}
      {!layout.open.length && <div className="workspace-empty">Your space, your layout.<small>Open an app from the toolbar to get started.</small></div>}
      {layout.open.map(id => {
        const { title, icon: AppIcon } = apps.find(a => a.id === id)!;
        return <section key={id} id={`app-${id}`} aria-labelledby={`app-title-${id}`} tabIndex={-1} className={`app-panel${preview?.id === id ? " panel-moving" : ""}`} style={style(layout.cells[id])}>
          <header className="app-titlebar"><div><AppIcon size={17} weight="light" /><h2 id={`app-title-${id}`}>{title}</h2>{editing && <small className="panel-span">{layout.cells[id].width} × {layout.cells[id].height}</small>}</div><div>
            {editing && <button className="panel-drag" aria-label={`Move ${title}`} title="Drag to snap; arrow keys move one cell" onPointerDown={e => begin(e, id, false)} onKeyDown={e => keyMove(e, id, false)}>⠿</button>}
            <Button variant="ghost" size="icon-sm" aria-label={`Close ${title}`} onClick={() => { toolbar.current[id]?.focus(); setLayout(c => ({ ...c, open: c.open.filter(a => a !== id) })); }}><XIcon /></Button>
          </div></header>
          <div className="app-body">{id === "emails" ? <Email /> : id === "notes" ? <Notes /> : <Productivity kind={id} data={data} />}</div>
          {editing && <button className="panel-resize" aria-label={`Resize ${title}`} title="Drag to resize by cells; arrow keys change spans" onPointerDown={e => begin(e, id, true)} onKeyDown={e => keyMove(e, id, true)}>⌟</button>}
        </section>;
      })}
      {preview && <div className={`grid-drop-preview${preview.valid ? "" : " invalid-drop"}`} aria-hidden="true" style={style(preview.cell)}><span>{preview.cell.width} wide × {preview.cell.height} tall{preview.valid ? "" : " · No room"}</span></div>}
    </div>
    <nav className="workspace-toolbar" aria-label="Workspace apps">
      <Button variant="ghost" size="icon" aria-label="Back to home" title="Back to home" onClick={onHome}><ArrowUpIcon /></Button><span className="toolbar-divider" />
      {apps.map(({ id, title, icon: AppIcon }) => <Button key={id} ref={el => { toolbar.current[id] = el; }} variant="ghost" size="icon" className="toolbar-app" data-open={layout.open.includes(id)} aria-label={`Open ${title}`} title={title} aria-controls={`app-${id}`} aria-expanded={layout.open.includes(id)} onClick={() => {
        if (!layout.open.includes(id)) setLayout(tiled([...layout.open, id], layout.columns, layout.rows, "grid", layout.cells));
        requestAnimationFrame(() => document.getElementById(`app-${id}`)?.focus());
      }}><AppIcon size={19} weight="light" /><span className="toolbar-indicator" /></Button>)}
      <span className="toolbar-divider" /><Button variant="ghost" aria-pressed={editing} onClick={() => setEditing(!editing)}>Customize</Button>
      <Button variant="ghost" size="icon" aria-label="Settings" title="Settings" onClick={onSettings}><SlidersHorizontalIcon /></Button>
      <span className="layout-save-status" role="status">{saved ? "Layout saved" : "Layout not saved"}</span>
    </nav>
    <ReminderAlerts data={data} />
  </div>;
}
