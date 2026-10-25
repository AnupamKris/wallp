import type { CSSProperties } from "react";
import { GameControllerIcon } from "@phosphor-icons/react";

const holdTicks = Array.from({ length: 48 }, (_, i) => i);

/** Full-screen hold-to-toggle loader: letterbox bars close in as the ring charges. */
export function GameHoldLoader({ progress, exiting }: { progress: number; exiting: boolean }) {
  const p = Math.min(Math.max(progress, 0), 1);
  return <div className="game-hold" style={{ "--p": p } as CSSProperties} role="status">
    <div className="game-hold-vignette" aria-hidden="true" />
    <div className="game-hold-bar game-hold-bar-top" aria-hidden="true" />
    <div className="game-hold-bar game-hold-bar-bottom" aria-hidden="true" />
    <div className="game-hold-core">
      <div className="game-hold-ring" aria-hidden="true">
        <svg className="game-hold-dial" viewBox="0 0 168 168">
          <circle className="game-hold-spinner" cx="84" cy="84" r="62" />
          <circle className="game-hold-ring-track" cx="84" cy="84" r="72" />
          <circle className="game-hold-arc" cx="84" cy="84" r="72" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - p} />
          {holdTicks.map(i => <line key={i} className="game-hold-tick" data-lit={i / holdTicks.length < p || undefined} x1="84" y1="2" x2="84" y2={i % 4 ? 6 : 9} transform={`rotate(${i * 360 / holdTicks.length} 84 84)`} />)}
        </svg>
        <GameControllerIcon className="game-hold-icon" size={44} weight="fill" />
      </div>
      <div className="grid justify-items-center gap-1 text-center">
        <p className="game-hold-kicker text-muted-foreground">Keep holding to {exiting ? "exit" : "enter"}</p>
        <p className="game-hold-word">Game Mode</p>
      </div>
      <div className="game-hold-meter" role="progressbar" aria-label="Game Mode shortcut hold" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
        <div className="game-hold-meter-fill bg-primary" />
      </div>
    </div>
  </div>;
}

/** One-shot title sequence played over Game Mode Home as it first opens. */
export function GameIntro() {
  return <div className="game-intro text-foreground" aria-hidden="true">
    <div className="game-intro-curtain bg-background" />
    <div className="game-intro-glow" />
    <div className="game-intro-shock" />
    <div className="game-intro-shock game-intro-shock-late" />
    <div className="game-intro-sweep" />
    <div className="game-intro-mark">
      <GameControllerIcon className="game-intro-icon" size={48} weight="fill" />
      <p className="game-intro-word">Game Mode</p>
      <span className="game-intro-rule bg-primary" />
    </div>
    <div className="game-intro-bar game-intro-bar-top" />
    <div className="game-intro-bar game-intro-bar-bottom" />
  </div>;
}
