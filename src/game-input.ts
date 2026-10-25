export type Direction = "left" | "right" | "up" | "down";
export type GameAction = Direction | "accept" | "back" | "toggle";
export type ControllerState = { id: number; buttons: number; x: number; y: number };
export type GameInputState = { homeForeground: boolean; shortcut: boolean; controllers: ControllerState[]; mouse?: { enabled: boolean; active: boolean; error: string } };
export type GameTransition = "classic" | "hyper" | "overdrive";
export type GameBindings = { letter: string; controller: "chord" | "menu"; transition: GameTransition };
export const defaultGameBindings: GameBindings = { letter: "G", controller: "chord", transition: "classic" };
export function validGameLetter(letter: string) { return /^[A-Z]$/.test(letter) && !["D", "W", "N"].includes(letter); }
export function parseGameBindings(raw: string | null): GameBindings {
  try {
    const value = JSON.parse(raw ?? "null");
    return { letter: typeof value?.letter === "string" && validGameLetter(value.letter) ? value.letter : "G", controller: value?.controller === "menu" ? "menu" : "chord", transition: value?.transition === "hyper" || value?.transition === "overdrive" ? value.transition : "classic" };
  } catch { return defaultGameBindings; }
}

/** Per-controller hold latch and repeat timer. Reset on focus loss or disconnect. */
export class GameInputTracker {
  private id: number | null = null;
  private buttons = 0;
  private holdStart: number | null = null;
  private latched = false;
  private ready = false;
  private direction: Direction | null = null;
  private nextRepeat = 0;
  private shortcut = true;
  progress = 0;
  reset() {
    this.id = null; this.buttons = 0; this.holdStart = null; this.latched = false;
    this.ready = false; this.direction = null; this.progress = 0; this.shortcut = true;
  }
  update(state: GameInputState, now: number, binding: GameBindings): GameAction[] {
    if (!state.homeForeground) { this.reset(); return []; }
    const actions: GameAction[] = [];
    if (state.shortcut && !this.shortcut) actions.push("toggle");
    this.shortcut = state.shortcut;
    // Retain the active device; never combine buttons from two controllers.
    const pad = state.controllers.find(p => p.id === this.id) ?? state.controllers.find(p => p.buttons || Math.hypot(p.x, p.y) > .55) ?? state.controllers[0];
    if (!pad) { this.id = null; this.ready = false; this.holdStart = null; this.progress = 0; return actions; }
    if (pad.id !== this.id) {
      this.id = pad.id; this.ready = false; this.holdStart = null; this.latched = false; this.direction = null;
    }
    if (!this.ready) {
      // An already-held button on reconnect/resume must be released first.
      this.ready = pad.buttons === 0 && Math.hypot(pad.x, pad.y) < .35;
      this.buttons = pad.buttons; this.progress = 0; return actions;
    }
    const mask = binding.controller === "menu" ? 0x10 : 0x30;
    const holding = (pad.buttons & mask) === mask;
    if (holding) {
      this.holdStart ??= now;
      this.progress = Math.min(1, (now - this.holdStart) / 1000);
      if (this.progress === 1 && !this.latched) { this.latched = true; actions.push("toggle"); }
    } else { this.holdStart = null; this.progress = 0; this.latched = false; }
    const pressed = pad.buttons & ~this.buttons;
    this.buttons = pad.buttons;
    if (holding) { this.direction = null; return actions; }
    if (pressed & 0x1000) actions.push("accept");
    if (pressed & 0x2000) actions.push("back");
    const direction: Direction | null = pad.buttons & 4 ? "left" : pad.buttons & 8 ? "right" : pad.buttons & 1 ? "up" : pad.buttons & 2 ? "down" :
      Math.hypot(pad.x, pad.y) > .55 ? Math.abs(pad.x) > Math.abs(pad.y) ? pad.x < 0 ? "left" : "right" : pad.y < 0 ? "up" : "down" : null;
    if (direction && (direction !== this.direction || now >= this.nextRepeat)) {
      actions.push(direction); this.nextRepeat = now + (direction === this.direction ? 120 : 350);
    }
    this.direction = direction;
    return actions;
  }
}

export type FocusRect = { left: number; top: number; width: number; height: number };
export function directionalNeighbor(rects: FocusRect[], current: number, direction: Direction): number {
  if (current < 0 || !rects[current]) return rects.length ? 0 : -1;
  const from = rects[current];
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  // Targets overlapping the current one across the travel axis (its "beam") win first,
  // so staggered rows such as keyboard keys never skip the row in between.
  const span = (rect: FocusRect) => horizontal ? [rect.top, rect.top + rect.height] : [rect.left, rect.left + rect.width];
  const [start, end] = span(from);
  let best = current, score = Infinity, inBeam = false;
  rects.forEach((rect, i) => {
    if (i === current) return;
    const dx = rect.left + rect.width / 2 - from.left - from.width / 2;
    const dy = rect.top + rect.height / 2 - from.top - from.height / 2;
    const forward = (horizontal ? dx : dy) * sign;
    const sideways = Math.abs(horizontal ? dy : dx);
    if (forward <= 1) return;
    const [a, b] = span(rect);
    const beam = a < end - 1 && b > start + 1;
    if (inBeam && !beam) return;
    // Within the beam the nearest row/column wins; outside it, straying sideways costs more.
    const candidate = forward + sideways * (beam ? 1 : 3);
    if ((beam && !inBeam) || candidate < score) { score = candidate; best = i; inBeam ||= beam; }
  });
  return best;
}
