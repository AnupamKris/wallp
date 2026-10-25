export const widgetIds = ["clocks", "digest", "files", "apps", "controls", "dock", "buddy"] as const;
export type WidgetId = typeof widgetIds[number];
export type Tile = { id: WidgetId; x: number; y: number; w: number; h: number; hidden?: boolean; direction?: "row" | "column"; labels?: boolean; contentAlign?: "start" | "center" | "end"; alignX?: "start" | "center" | "end"; alignY?: "start" | "center" | "end"; variant?: BuddyVariant };
export const buddyVariants = ["cat", "simple"] as const;
export type BuddyVariant = typeof buddyVariants[number];
export type HomeLayout = { columns: number; tiles: Tile[] };
export const screenRows = 24;
export const widgetNames: Record<WidgetId, string> = { clocks: "World clocks", digest: "Inbox brief", files: "Files", apps: "Applications", controls: "System controls", dock: "Dock", buddy: "Desk buddy" };
export const minimum: Record<WidgetId, [number, number]> = { clocks: [3, 4], digest: [4, 6], files: [1, 2], apps: [1, 3], controls: [1, 2], dock: [1, 2], buddy: [2, 5] };
export function minimumWidth(id: WidgetId, columns: number): number {
  const finer = [8, 24, 48].includes(columns);
  // Keep content widgets readable, while allowing shortcut groups to be narrower.
  const cells = id === "buddy" ? Math.max(2, Math.round(columns / 6)) : finer ? (id === "clocks" || id === "digest" ? minimum[id][0] * 4 : 2) : minimum[id][0];
  return Math.min(cells, columns);
}
export const defaultHomeLayout: HomeLayout = { columns: 12, tiles: [
  { id: "clocks", x: 1, y: 0, w: 10, h: 5 },
  { id: "digest", x: 1, y: 5, w: 10, h: 7 },
  { id: "files", x: 0, y: 3, w: 1, h: 3 },
  { id: "apps", x: 11, y: 3, w: 1, h: 7 },
  { id: "controls", x: 8, y: 12, w: 4, h: 2 },
  { id: "dock", x: 5, y: 12, w: 2, h: 2 },
  { id: "buddy", x: 1, y: 14, w: 3, h: 5, hidden: true },
] };
export const overlaps = (a: Tile, b: Tile) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export function boundedTile(tile: Tile, columns: number): Tile {
  const w = Math.max(minimumWidth(tile.id, columns), Math.min(columns, Math.round(tile.w)));
  const h = Math.max(minimum[tile.id][1], Math.min(screenRows, Math.round(tile.h)));
  return { ...tile, w, h, x: Math.max(0, Math.min(columns - w, Math.round(tile.x))), y: Math.max(0, Math.min(screenRows - h, Math.round(tile.y))) };
}
// Reserve the destination and move blocked widgets into available screen cells.
// The screen never grows. An impossible placement leaves the last valid layout intact.
export function rearrange(layout: HomeLayout, active?: Tile, pack = false): HomeLayout | null {
  const placed: Tile[] = active && !active.hidden ? [boundedTile(active, layout.columns)] : [];
  const rest = layout.tiles.filter(t => !t.hidden && t.id !== active?.id).sort((a, b) => a.y - b.y || a.x - b.x);
  if ([...rest, ...placed].reduce((area, t) => area + t.w * t.h, 0) > layout.columns * screenRows) return null;
  // Keep every unaffected widget in place before finding room for collisions.
  if (active && !pack) {
    for (const tile of rest) if (!placed.some(p => overlaps(p, tile))) placed.push(boundedTile(tile, layout.columns));
  }
  for (const original of rest) {
    if (placed.some(t => t.id === original.id)) continue;
    let tile = boundedTile(original, layout.columns);
    if (pack || placed.some(p => overlaps(p, tile))) {
      let found: Tile | undefined;
      let score = Infinity;
      for (let y = 0; y <= screenRows - tile.h; y++) for (let x = 0; x <= layout.columns - tile.w; x++) {
        const candidate = { ...tile, x, y };
        const distance = pack ? y * layout.columns + x : Math.abs(x - tile.x) * 2 + Math.abs(y - tile.y);
        if (distance < score && !placed.some(p => overlaps(p, candidate))) { found = candidate; score = distance; }
      }
      if (!found) {
        // Repack around the active widget when preserving other positions fragments the free space.
        return active && !pack ? rearrange(layout, active, true) : null;
      }
      tile = found;
    }
    placed.push(tile);
  }
  return { ...layout, tiles: layout.tiles.map(t => placed.find(p => p.id === t.id) ?? (t.id === active?.id ? active : t)) };
}
export function fitScreenLayout(layout: HomeLayout): HomeLayout {
  let next = { ...layout, tiles: layout.tiles.map(t => boundedTile(t, layout.columns)) };
  // Migrate old scrolling layouts and project smaller screens without losing widgets.
  for (let attempt = 0; attempt < 250; attempt++) {
    const fitted = rearrange(next) ?? rearrange(next, undefined, true);
    if (fitted) return fitted;
    const tallest = next.tiles.filter(t => !t.hidden && t.h > minimum[t.id][1]).sort((a, b) => b.h - a.h)[0];
    const widest = next.tiles.filter(t => !t.hidden && t.w > minimumWidth(t.id, next.columns)).sort((a, b) => b.w - a.w)[0];
    const shrink = tallest ?? widest;
    if (!shrink) break;
    next = { ...next, tiles: next.tiles.map(t => t.id !== shrink.id ? t : { ...t, ...(tallest ? { h: t.h - 1 } : { w: t.w - 1 }) }) };
  }
  return next;
}
export function setWidgetVisible(layout: HomeLayout, id: WidgetId, visible: boolean): HomeLayout | null {
  const next = { ...layout, tiles: layout.tiles.map(tile => tile.id === id ? { ...tile, hidden: !visible } : tile) };
  // Hiding never needs space and must not move the remaining widgets.
  if (!visible) return next;
  // A hidden widget's saved position can split the available space. Try packing
  // before shrinking to the same minimum sizes used for responsive layouts.
  return rearrange(next) ?? rearrange(next, undefined, true) ?? rearrange(fitScreenLayout(next));
}
export function projectLayout(layout: HomeLayout, columns: number): HomeLayout {
  if (layout.columns === columns) return layout;
  return fitScreenLayout({ columns, tiles: layout.tiles.map(t => boundedTile({ ...t, x: t.x * columns / layout.columns, w: t.w * columns / layout.columns }, columns)) });
}
export function parseHomeLayout(raw: string | null): HomeLayout {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || ![2, 6, 12, 8, 24, 48].includes(value.columns) || !Array.isArray(value.tiles)) return defaultHomeLayout;
    const tiles = widgetIds.map(id => {
      const t = value.tiles.find((item: Tile) => item?.id === id);
      const fallback = defaultHomeLayout.tiles.find(tile => tile.id === id)!;
      const ratio = value.columns / defaultHomeLayout.columns;
      return t && [t.x, t.y, t.w, t.h].every(Number.isFinite) ? boundedTile({ id, x: t.x, y: t.y, w: t.w, h: t.h,
        ...(typeof t.hidden === "boolean" ? { hidden: t.hidden } : {}),
        ...(t.direction === "row" || t.direction === "column" ? { direction: t.direction } : {}),
        ...(typeof t.labels === "boolean" ? { labels: t.labels } : {}),
        ...(t.alignX === "start" || t.alignX === "center" || t.alignX === "end" ? { alignX: t.alignX } : {}),
        ...(t.alignY === "start" || t.alignY === "center" || t.alignY === "end" ? { alignY: t.alignY } : {}),
        ...(id === "buddy" && buddyVariants.includes(t.variant!) ? { variant: t.variant } : {}),
        ...(t.contentAlign === "start" || t.contentAlign === "center" || t.contentAlign === "end" ? { contentAlign: t.contentAlign } : {}),
      }, value.columns) : boundedTile({ ...fallback, x: fallback.x * ratio, w: fallback.w * ratio }, value.columns);
    });
    return fitScreenLayout({ columns: value.columns, tiles });
  } catch { return defaultHomeLayout; }
}
