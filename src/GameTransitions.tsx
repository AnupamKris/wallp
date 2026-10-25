import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { GameControllerIcon } from "@phosphor-icons/react";
import { Card } from "@/components/ui/card";
import { GameHoldLoader, GameIntro } from "./GameIntroClassic";
import { HyperGameTransition } from "./GameIntroHyper";
import { OverdriveGameTransition } from "./GameIntroOverdrive";
import type { GameTransition } from "./game-input";
import { useGameHold, type GameHold } from "./use-game-mode";

export const gameTransitions: { id: GameTransition; label: string; description: string }[] = [
  { id: "classic", label: "Classic", description: "A cinematic charge ring and a soft title reveal." },
  { id: "hyper", label: "Hyper", description: "A hyperspace jump: warp streaks charge, a flash, and a diamond iris tears open." },
  { id: "overdrive", label: "Overdrive", description: "A charging reticle, kinetic type, speed lines, and a diagonal split reveal." },
];

const motionQuery = "(prefers-reduced-motion: reduce)";
function subscribeMotion(listener: () => void) {
  const query = window.matchMedia(motionQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
export function useReducedGameMotion() {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia(motionQuery).matches);
}

export function GameCharge({ transition, progress, exiting }: { transition: GameTransition; progress: number; exiting: boolean }) {
  const reduced = useReducedGameMotion();
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  if (reduced) return <div className="game-hold"><Card className="grid w-64 justify-items-center gap-3 p-6">
    <GameControllerIcon size={32} aria-hidden="true" />
    <p className="text-sm">Hold to {exiting ? "exit" : "enter"} Game Mode</p>
    <div className="h-1 w-full bg-muted" role="progressbar" aria-label="Game Mode shortcut hold" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
    </div>
  </Card></div>;
  if (transition === "overdrive") return <OverdriveGameTransition progress={progress} exiting={exiting} />;
  if (transition === "hyper") return <HyperGameTransition progress={progress} exiting={exiting} />;
  return <GameHoldLoader progress={progress} exiting={exiting} />;
}

/** Draws the controller hold. Subscribes to the hold store itself so input samples only re-render this subtree. */
export function GameHoldOverlay({ hold, transition, exiting }: { hold: GameHold; transition: GameTransition; exiting: boolean }) {
  const progress = useGameHold(hold, p => p);
  const reduced = useReducedGameMotion();
  // Inline transform/filter on the one element avoids a page-wide style recalc from an inherited custom property.
  useLayoutEffect(() => {
    const home = document.querySelector<HTMLElement>(".desktop-screen > .home-layout");
    if (!home || exiting || reduced) return;
    const p = Math.min(1, progress);
    home.style.transform = p > 0 ? `scale(${1 - p * .06})` : "";
    // Hyper covers Home with its iris, so it skips the full-screen blur.
    home.style.filter = p > 0 && transition !== "hyper" ? `brightness(${1 - p * .55}) blur(${p * 4}px)` : "";
    return () => { home.style.transform = ""; home.style.filter = ""; };
  }, [progress, exiting, reduced, transition]);
  return progress > 0 && progress < 1 ? <GameCharge transition={transition} progress={progress} exiting={exiting} /> : null;
}

export function GameEntrance({ transition, covered = false, onDone }: { transition: GameTransition; covered?: boolean; onDone: () => void }) {
  const reduced = useReducedGameMotion();
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (reduced) { done.current(); return; }
    // Also bounds cleanup if an animation is interrupted or its completion callback never runs.
    const timeout = setTimeout(() => done.current(), transition === "classic" ? 1700 : 2400);
    return () => clearTimeout(timeout);
  }, [transition, reduced]);
  if (reduced) return null;
  if (transition === "overdrive") return <OverdriveGameTransition covered={covered} onDone={onDone} />;
  if (transition === "hyper") return <HyperGameTransition covered={covered} onDone={onDone} />;
  return <GameIntro />;
}

/** Preview the same one-second hold and handoff used by the controller, without activating Game Mode. */
export function GameTransitionPreview({ transition, onDone }: { transition: GameTransition; onDone: () => void }) {
  const [progress, setProgress] = useState(0);
  const reduced = useReducedGameMotion();
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (reduced) { done.current(); return; }
    let frame: number;
    const start = performance.now();
    function tick(now: number) {
      const next = Math.min(1, (now - start) / 1000);
      setProgress(next);
      if (next < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);
  // Capture Escape before the settings dialog closes so focus stays on the Preview button.
  useEffect(() => {
    function cancel(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); done.current();
    }
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, []);
  return progress < 1 ? <GameCharge transition={transition} progress={progress} exiting={false} /> : <GameEntrance transition={transition} covered onDone={onDone} />;
}
