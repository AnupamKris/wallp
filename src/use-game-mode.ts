import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isLinux } from "./platform";
import { GameInputTracker, directionalNeighbor, parseGameBindings, type GameAction, type GameBindings, type GameInputState } from "./game-input";

const storageKey = "wallp.game-bindings.v1";
function readBindings() { try { return localStorage.getItem(storageKey); } catch { return null; } }
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener); window.addEventListener("wallp:game-bindings", listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener("wallp:game-bindings", listener); };
}
export function useGameBindings() {
  const raw = useSyncExternalStore(subscribe, readBindings);
  const bindings = useMemo(() => parseGameBindings(raw), [raw]);
  function save(value: GameBindings) {
    localStorage.setItem(storageKey, JSON.stringify(value));
    window.dispatchEvent(new Event("wallp:game-bindings"));
  }
  return [bindings, save] as const;
}

function popup() {
  return [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]')]
    .filter(el => el.getClientRects().length && el.dataset.state !== "closed").slice(-1)[0];
}
function targets() {
  const root = popup() ?? document.querySelector("#home-screen");
  return root ? [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex="0"]')].filter(el => {
    const rect = el.getBoundingClientRect();
    return !el.closest('[inert], [hidden], [aria-hidden="true"]') && !el.matches(':disabled, [aria-disabled="true"]') && el.tabIndex >= 0 && rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }) : [];
}
function focusTarget(target: HTMLElement | undefined) {
  document.querySelectorAll("[data-game-focus]").forEach(el => el.removeAttribute("data-game-focus"));
  if (!target) return;
  target.setAttribute("data-game-focus", "true"); target.focus(); target.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * Hold progress changes on every 50ms input poll. Keeping it out of React state stops each sample from re-rendering
 * all of Home; only the components that draw the hold subscribe to it.
 */
export type GameHold = { get: () => number; subscribe: (listener: () => void) => () => void; heldAt: number };
function createGameHold() {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    heldAt: -Infinity,
    get: () => value,
    set(next: number) { if (next === value) return; value = next; listeners.forEach(listener => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export function useGameHold<T>(hold: GameHold, select: (progress: number) => T) {
  return useSyncExternalStore(hold.subscribe, () => select(hold.get()));
}

export function useGameMode(enabled: boolean, canActivate: boolean) {
  const [active, setActive] = useState(false);
  const [hold] = useState(createGameHold);
  const [connected, setConnected] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [inputError, setInputError] = useState("");
  const [mouseActive, setMouseActive] = useState(false);
  // Native polling continues while fullscreen games pause Home's webview polling.
  useEffect(() => {
    if (!isTauri() || isLinux) return;
    void invoke("game_mouse_enabled", { enabled: active }).catch(err => setInputError(String(err)));
    return () => { void invoke("game_mouse_enabled", { enabled: false }).catch(() => {}); };
  }, [active]);
  const [bindings] = useGameBindings();
  const latest = useRef({ active, canActivate, bindings });
  useLayoutEffect(() => { latest.current = { active, canActivate, bindings }; });
  const activationAllowed = () => latest.current.canActivate && !popup() && !document.querySelector(".home-editing");
  const toggle = () => { if (latest.current.active || activationAllowed()) setActive(value => !value); };
  const action = useRef<(action: GameAction) => void>(() => {});
  useLayoutEffect(() => {
    action.current = command => {
      if (command === "toggle") { toggle(); return; }
      if (!latest.current.active) return;
      const focused = document.activeElement as HTMLElement | null;
      if (command === "back") {
        const overlay = popup();
        if (overlay instanceof HTMLDialogElement) {
          if (overlay.dispatchEvent(new Event("cancel", { cancelable: true }))) overlay.close();
        }
        else if (overlay) (focused ?? overlay).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        else setActive(false);
        return;
      }
      const items = targets();
      if (command === "accept") {
        if (focused && items.includes(focused)) focused.click();
        else focusTarget(items[0]);
        return;
      }
      // Radix sliders, switches, tabs, and menus get their own arrow behavior first.
      if (focused?.matches('[role="slider"], [role="tab"], [role="menuitem"], select, input[type="number"]')) {
        const key = `Arrow${command[0].toUpperCase()}${command.slice(1)}`;
        if (!focused.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))) return;
      }
      const next = directionalNeighbor(items.map(el => el.getBoundingClientRect()), items.indexOf(focused!), command);
      focusTarget(items[next]);
    };
  });
  useEffect(() => {
    document.documentElement.classList.toggle("game-input-mode", active);
    return () => document.documentElement.classList.remove("game-input-mode");
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const followFocus = (event: FocusEvent) => {
      document.querySelectorAll("[data-game-focus]").forEach(el => el.removeAttribute("data-game-focus"));
      if (event.target instanceof HTMLElement && targets().includes(event.target)) event.target.setAttribute("data-game-focus", "true");
    };
    document.addEventListener("focusin", followFocus);
    return () => document.removeEventListener("focusin", followFocus);
  }, [active]);
  useEffect(() => {
    if (!active) {
      document.querySelectorAll("[data-game-focus]").forEach(el => el.removeAttribute("data-game-focus"));
      return;
    }
    if (isTauri()) void invoke("game_focus_home").catch(err => setInputError(String(err)));
    const frame = requestAnimationFrame(() => focusTarget(targets().find(el => el.hasAttribute("data-game-initial")) ?? targets()[0]));
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => {
    if (!enabled && !active) { hold.set(0); return; }
    const tracker = new GameInputTracker();
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    let lastBinding = latest.current.bindings;
    async function poll() {
      try {
        if (lastBinding !== latest.current.bindings) { tracker.reset(); lastBinding = latest.current.bindings; }
        let state: GameInputState;
        if (isTauri()) state = await invoke<GameInputState>("game_input_state", { key: latest.current.bindings.letter.charCodeAt(0) });
        else {
          const masks = [0x1000, 0x2000, 0x4000, 0x8000, 0, 0, 0, 0, 0x20, 0x10, 0, 0, 1, 2, 4, 8];
          const pads = [...navigator.getGamepads()].filter((p): p is Gamepad => !!p && p.mapping === "standard");
          state = { homeForeground: document.hasFocus(), shortcut: false, controllers: pads.map(p => ({ id: p.index, x: p.axes[0] ?? 0, y: p.axes[1] ?? 0, buttons: p.buttons.reduce((bits, button, i) => bits | (button.pressed ? masks[i] ?? 0 : 0), 0) })) };
        }
        if (disposed) return;
        setInputError(state.mouse?.error ?? ""); setMouseActive(state.mouse?.active ?? false); setConnected(state.controllers.length > 0 || !!state.mouse?.active); setSuspended(!state.homeForeground);
        if (state.mouse?.active || (!latest.current.active && !activationAllowed())) { tracker.reset(); hold.set(0); }
        else {
          const now = performance.now();
          const commands = tracker.update(state, now, latest.current.bindings);
          if (tracker.progress > 0 && !latest.current.active) hold.heldAt = now;
          hold.set(tracker.progress);
          commands.forEach(command => action.current(command));
        }
      } catch (err) {
        if (!disposed) { tracker.reset(); hold.set(0); setConnected(false); setInputError(`Controller input unavailable: ${String(err)}`); }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 50);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); tracker.reset(); };
  }, [enabled, active]);
  useEffect(() => {
    if (!enabled) return;
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!isTauri() && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && event.key.toUpperCase() === bindings.letter) {
        event.preventDefault(); if (!event.repeat) toggle(); return;
      }
      if (!active || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === "Escape") {
        if (!popup()) { event.preventDefault(); setActive(false); }
        return;
      }
      if ((event.target as HTMLElement)?.matches('input, textarea, select, [contenteditable="true"], [role="slider"], [role="tab"], [role="menuitem"]')) return;
      const direction = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[event.key as "ArrowLeft"];
      if (direction) { event.preventDefault(); action.current(direction); }
      // Enter/Space and Tab retain the native accessible control behavior.
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [enabled, active, bindings]);
  return { active, enter: () => { if (enabled && activationAllowed()) setActive(true); }, exit: () => setActive(false), hold, connected, suspended, inputError, bindings, mouseActive };
}
