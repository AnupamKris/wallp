export const workspaceIds = ["emails", "reminders", "todos", "notes", "agenda", "files", "ai", "clipboard"] as const;
export type WorkspaceId = typeof workspaceIds[number];
export type ScrollingLayout = { grid?: WorkspaceGrid; open: WorkspaceId[]; stacks: WorkspaceId[][]; widths: Record<WorkspaceId, number> };
export const defaultScrollingLayout: ScrollingLayout = { open: ["emails", "reminders", "todos", "notes"], stacks: [["emails"], ["reminders"], ["todos"], ["notes"]], widths: { emails: 66, reminders: 50, todos: 50, notes: 66, agenda: 50, files: 50, ai: 66, clipboard: 50 } };
export const layoutStorageKey = "wallp.scrolling-layout.v1";
export function panelWidth(percent: number, viewport: number) {
  return Math.max(Math.min(280, viewport), Math.round(viewport * percent / 100));
}
export function adjacentPanel(open: WorkspaceId[], current: WorkspaceId, direction: number) {
  if (!open.length) return undefined;
  return open[Math.max(0, Math.min(open.length - 1, Math.max(0, open.indexOf(current)) + direction))];
}
export function withStacks(layout: ScrollingLayout, stacks: WorkspaceId[][]): ScrollingLayout {
  const nonempty = stacks.filter(stack => stack.length);
  return { ...layout, stacks: nonempty, open: nonempty.flat() };
}
export function reorderPanel(layout: ScrollingLayout, id: WorkspaceId, direction: number): ScrollingLayout {
  const index = layout.stacks.findIndex(stack => stack.includes(id)), next = index + direction;
  if (index < 0 || next < 0 || next >= layout.stacks.length) return layout;
  const stacks = [...layout.stacks];
  [stacks[index], stacks[next]] = [stacks[next], stacks[index]];
  return withStacks(layout, stacks);
}
export function stackPanel(layout: ScrollingLayout, id: WorkspaceId, target: WorkspaceId | null): ScrollingLayout {
  if (id === target || !layout.open.includes(id) || (target && !layout.open.includes(target))) return layout;
  const original = layout.stacks.findIndex(stack => stack.includes(id));
  const stacks = layout.stacks.map(stack => stack.filter(other => other !== id));
  if (target) {
    const index = stacks.findIndex(stack => stack.includes(target));
    stacks[index] = [...stacks[index].slice(0, stacks[index].indexOf(target) + 1), id, ...stacks[index].slice(stacks[index].indexOf(target) + 1)];
  } else stacks.splice(original + 1, 0, [id]);
  return withStacks(layout, stacks);
}
export function moveInStack(layout: ScrollingLayout, id: WorkspaceId, direction: number): ScrollingLayout {
  const stacks = layout.stacks.map(stack => {
    const index = stack.indexOf(id), next = index + direction;
    if (index < 0 || next < 0 || next >= stack.length) return stack;
    const result = [...stack];
    [result[index], result[next]] = [result[next], result[index]];
    return result;
  });
  return withStacks(layout, stacks);
}
export function panelSnapOffset(left: number, width: number, viewportWidth: number, inset = 12) {
  return Math.max(0, left + width - viewportWidth + inset);
}
export function panelGeometry(layout: ScrollingLayout, viewport: number) {
  const first = layout.stacks[0] ?? [];
  const leading = first.length ? Math.max(0, viewport - Math.min(...first.map(id => panelWidth(layout.widths[id], viewport)))) : 0;
  let left = 12 + leading;
  const panels: { id: WorkspaceId; left: number; width: number; row: number; snap: number }[] = [];
  for (const stack of layout.stacks) {
    for (const [row, id] of stack.entries()) {
      const width = panelWidth(layout.widths[id], viewport);
      panels.push({ id, left, width, row, snap: panelSnapOffset(left, width, viewport + 24) });
    }
    left += Math.max(...stack.map(id => panelWidth(layout.widths[id], viewport))) + 12;
  }
  // Each panel is a stop, including equal-width siblings in one stack.
  const stops = [...panels].sort((a, b) => a.snap - b.snap || a.row - b.row);
  return { leading, panels, stops };
}
export function parseScrollingLayout(raw: string | null, legacy: string | null = null): ScrollingLayout {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value && Array.isArray(value.open) && value.open.every((id: WorkspaceId) => workspaceIds.includes(id)) && new Set(value.open).size === value.open.length && value.widths && Object.entries(value.widths).every(([id, width]) => workspaceIds.includes(id as WorkspaceId) && typeof width === "number" && Number.isFinite(width) && width >= 25 && width <= 150) && ["emails", "reminders", "todos", "notes"].every(id => Number.isFinite(value.widths[id]))) {
      const stacks = value.stacks;
      const valid = Array.isArray(stacks) && stacks.every((stack: unknown) => Array.isArray(stack) && stack.length > 0) && stacks.flat().length === value.open.length && new Set(stacks.flat()).size === value.open.length && stacks.flat().every((id: WorkspaceId) => value.open.includes(id));
      return withStacks({ open: value.open, widths: { ...defaultScrollingLayout.widths, ...value.widths }, stacks: [], ...(validGrid(value.grid) ? { grid: value.grid } : {}) }, valid ? stacks : value.open.map((id: WorkspaceId) => [id]));
    }
  } catch { /* Try the previous layout. */ }
  try {
    const old = JSON.parse(legacy ?? "null");
    if (old && Array.isArray(old.open) && Number.isInteger(old.columns) && old.columns >= 2 && old.columns <= 12) {
      const open = [...new Set<WorkspaceId>(old.open.map((id: string) => id === "tasks" ? "todos" : id).filter((id: WorkspaceId) => workspaceIds.includes(id)))];
      open.sort((a, b) => (old.cells?.[a]?.row ?? 1) - (old.cells?.[b]?.row ?? 1) || (old.cells?.[a]?.col ?? 1) - (old.cells?.[b]?.col ?? 1));
      const widths = { ...defaultScrollingLayout.widths };
      for (const id of workspaceIds) {
        const width = old.cells?.[id === "todos" && !old.cells?.todos ? "tasks" : id]?.width;
        if (Number.isFinite(width)) widths[id] = Math.max(25, Math.min(150, Math.round(width / old.columns * 100)));
      }
      return { open, widths, stacks: open.map(id => [id]) };
    }
  } catch { /* Recover from invalid storage. */ }
  return { open: [...defaultScrollingLayout.open], stacks: defaultScrollingLayout.stacks.map(stack => [...stack]), widths: { ...defaultScrollingLayout.widths } };
}
export type GridCell = { col: number; row: number; width: number; height: number };
export type WorkspaceGrid = { columns: number; rows: number; cells: Partial<Record<WorkspaceId, GridCell>> };
const collides = (a: GridCell, b: GridCell) => a.col < b.col + b.width && a.col + a.width > b.col && a.row < b.row + b.height && a.row + a.height > b.row;
export function workspaceGrid(layout: ScrollingLayout): WorkspaceGrid {
  const grid: WorkspaceGrid = layout.grid ? { ...layout.grid, cells: { ...layout.grid.cells } } : { columns: 12, rows: 8, cells: {} };
  for (const [index, id] of layout.open.entries()) {
    if (grid.cells[id]) continue;
    const width = Math.max(1, Math.floor(grid.columns / 2)), height = Math.max(1, Math.floor(grid.rows / 2));
    let cell: GridCell = { col: Math.floor(index / 4) * grid.columns + (index % 2) * width + 1, row: Math.floor(index % 4 / 2) * height + 1, width, height };
    while (layout.open.some(other => other !== id && grid.cells[other] && collides(cell, grid.cells[other]!))) cell = { ...cell, col: cell.col + 1 };
    grid.cells[id] = cell;
  }
  const occupied: GridCell[] = [];
  for (const id of layout.open) {
    let cell = grid.cells[id]!;
    while (occupied.some(other => collides(cell, other))) cell = { ...cell, col: cell.col + 1 };
    grid.cells[id] = cell; occupied.push(cell);
  }
  return grid;
}
export function placeGridPanel(layout: ScrollingLayout, id: WorkspaceId, target: GridCell): ScrollingLayout {
  const grid = workspaceGrid(layout);
  const width = Math.max(1, Math.min(24, Math.round(target.width))), height = Math.max(1, Math.min(grid.rows, Math.round(target.height)));
  const cell = { col: Math.max(1, Math.min(120, Math.round(target.col))), row: Math.max(1, Math.min(grid.rows - height + 1, Math.round(target.row))), width, height };
  const previous = grid.cells[id];
  grid.cells[id] = cell;
  const occupied = [cell];
  const displaced: WorkspaceId[] = [];
  for (const other of layout.open.filter(other => other !== id)) {
    if (collides(cell, grid.cells[other]!)) displaced.push(other);
    else occupied.push(grid.cells[other]!);
  }
  for (const other of displaced) {
    let current = grid.cells[other]!;
    const swapped = previous ? { ...current, col: previous.col, row: previous.row } : current;
    if (swapped.row + swapped.height <= grid.rows + 1 && occupied.every(cell => !collides(cell, swapped))) current = swapped;
    else {
      let found = false;
      for (let col = 1; !found; col++) for (let row = 1; row <= grid.rows - current.height + 1; row++) {
        const candidate = { ...current, col, row };
        if (occupied.every(cell => !collides(cell, candidate))) { current = candidate; found = true; break; }
      }
    }
    grid.cells[other] = current; occupied.push(current);
  }
  return { ...layout, grid };
}
export function gridGeometry(layout: ScrollingLayout, viewport: number) {
  const grid = workspaceGrid(layout), step = viewport / grid.columns;
  const panels = layout.open.map(id => {
    const cell = grid.cells[id]!;
    const left = 12 + (cell.col - 1) * step, width = cell.width * step;
    return { id, left, width, row: cell.row, snap: panelSnapOffset(left, width, viewport + 24) };
  });
  const stops = [...panels].sort((a, b) => a.snap - b.snap || a.row - b.row);
  return { grid, step, panels, stops, columns: Math.max(grid.columns, ...layout.open.map(id => grid.cells[id]!.col + grid.cells[id]!.width - 1)) };
}
export function verticalGridNeighbor(layout: ScrollingLayout, id: WorkspaceId, direction: number) {
  const grid = workspaceGrid(layout), current = grid.cells[id];
  if (!current) return undefined;
  return layout.open.filter(other => {
    const cell = grid.cells[other]!;
    return direction > 0 ? cell.row >= current.row + current.height : cell.row + cell.height <= current.row;
  }).sort((a, b) => {
    const score = (cell: GridCell) => Math.abs(cell.row - current.row) + Math.abs(cell.col - current.col) * 2;
    return score(grid.cells[a]!) - score(grid.cells[b]!);
  })[0];
}

function validGrid(value: unknown): value is WorkspaceGrid {
  if (!value || typeof value !== "object") return false;
  const grid = value as WorkspaceGrid;
  return Number.isInteger(grid.columns) && grid.columns >= 2 && grid.columns <= 24 && Number.isInteger(grid.rows) && grid.rows >= 2 && grid.rows <= 12 && !!grid.cells && Object.entries(grid.cells).every(([id, c]) => workspaceIds.includes(id as WorkspaceId) && c && [c.col, c.row, c.width, c.height].every(Number.isInteger) && c.col >= 1 && c.col <= 120 && c.width >= 1 && c.width <= 24 && c.row >= 1 && c.height >= 1 && c.row + c.height <= grid.rows + 1);
}
