import { useLayoutEffect, useRef } from "react";
import { GameControllerIcon } from "@phosphor-icons/react";
import "./GameIntroHyper.css";

const word = "GAME MODE";
const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#/<>_";
const streaks = Array.from({ length: 48 }, (_, i) => i);
const tunnel = Array.from({ length: 5 }, (_, i) => i);
const segments = Array.from({ length: 32 }, (_, i) => i);
const sides = [["n", "Y", -1], ["s", "Y", 1], ["w", "X", -1], ["e", "X", 1]] as const;
/** Length of the hold the charge scene covers; the controller shortcut completes after one second. */
const chargeMs = 1000;
const ease = {
  in2: "cubic-bezier(.32, 0, .67, 0)", in3: "cubic-bezier(.55, 0, .85, .2)", in4: "cubic-bezier(.7, 0, .84, 0)",
  out2: "cubic-bezier(.33, 1, .68, 1)", out3: "cubic-bezier(.22, 1, .36, 1)", expoOut: "cubic-bezier(.16, 1, .3, 1)", inOut2: "cubic-bezier(.45, 0, .55, 1)",
};

function scramble(target: string, progress: number) {
  const settled = Math.floor(target.length * progress);
  return [...target].map((char, i) => i < settled || char === " " ? char : glyphs[Math.floor(Math.random() * glyphs.length)]).join("");
}

/** Fixed-width glyph cells keep the wordmark and its glitch ghosts aligned while glyphs scramble. */
function cells(text: string, className = "") {
  return [...text].map((char, i) => <span key={i} className={`hyper-cell ${className}${char === " " ? " hyper-cell-space" : ""}`}>{char}</span>);
}

/** Distance each iris panel travels from the center before the diamond hole clears the whole viewport. */
function irisReach() {
  return (window.innerWidth + window.innerHeight) / (2 * Math.SQRT2) + 40;
}

/** Seeded so the hold tremor is identical every run and ends centered on the jump's first frame. */
function shakeFrames(): Keyframe[] {
  const frames: Keyframe[] = [{ offset: 0, transform: "translate(0px, 0px)" }, { offset: .6, transform: "translate(0px, 0px)" }];
  for (let i = 1; i <= 14; i++) {
    const offset = Math.round((.6 + i * .026) * 1000) / 1000, amp = (offset - .6) * 14, a = i * 2.39996;
    frames.push({ offset, transform: `translate(${(Math.cos(a) * amp).toFixed(2)}px, ${(Math.sin(a * 1.7) * amp).toFixed(2)}px)` });
  }
  frames.push({ offset: 1, transform: "translate(0px, 0px)" });
  return frames;
}

type Animate = (target: Element | null | undefined, keyframes: Keyframe[], delayMs: number, durationMs: number, easing?: string) => void;
/** The charge fills both ways so delayed pieces hold their start state; the jump fills forwards only so it never masks the charge before it starts. */
function animator(list: Animation[], fill: FillMode): Animate {
  return (target, keyframes, delay, duration, easing = "linear") => {
    if (target) list.push(target.animate(keyframes, { delay, duration, easing, fill }));
  };
}

/** The charge scene the hold scrubs. Its end state is exactly the jump's first frame. */
function charge(el: HTMLElement, list: Animation[]) {
  const a = animator(list, "both");
  const all = (selector: string) => [...el.querySelectorAll(selector)];
  const reach = irisReach();
  for (const [side, axis, sign] of sides) all(`.hyper-iris-${side}`).forEach(node =>
    a(node, [{ transform: `translate${axis}(${reach * sign}px)` }, { transform: `translate${axis}(0px)` }], 150, 800, ease.inOut2));
  all(".hyper-iris-line").forEach(node => a(node, [{ opacity: 0 }, { opacity: .7 }], 200, 600));
  a(el.querySelector(".hyper-tunnel"), [{ opacity: 0, transform: "scale(1.6)" }, { opacity: 1, transform: "scale(1)" }], 0, 800, ease.out2);
  all(".hyper-streak").forEach((node, i) => a(node, [{ opacity: 0, transform: "translateX(0px) scaleX(.05)" }, { opacity: 1, transform: "translateX(0px) scaleX(1)" }], 100 + (i * 157 % 48) / 48 * 300, 600));
  all(".hyper-frame").forEach((node, i) => a(node, [
    { opacity: 0, transform: `rotate(${i ? -45 : 45}deg) scale(2.6)` }, { opacity: 1, transform: `rotate(${i ? -135 : 135}deg) scale(1)` },
  ], 0, chargeMs, ease.out2));
  a(el.querySelector(".hyper-core"), [{ opacity: 0, transform: "scale(.82)" }, { opacity: 1, transform: "scale(1)" }], 0, 450, ease.out3);
  a(el.querySelector(".hyper-shake"), shakeFrames(), 0, chargeMs);
  a(el.querySelector(".hyper-meter-fill"), [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], 0, chargeMs);
}

/** Wind-up, flash, and the iris tearing open. Every keyframe starts from the charged state. */
function jump(el: HTMLElement, list: Animation[], start: number) {
  const a = animator(list, "forwards");
  const all = (selector: string) => [...el.querySelectorAll(selector)];
  const one = (selector: string) => el.querySelector(selector);
  const reach = Math.hypot(window.innerWidth, window.innerHeight) / 2;
  const t = (seconds: number) => start + seconds * 1000;

  a(one(".hyper-core"), [{ transform: "scale(1)" }, { transform: "scale(.9)" }], t(0), 220, ease.in2);
  all(".hyper-frame").forEach((node, i) => a(node, [
    { opacity: 1, transform: `rotate(${i ? -135 : 135}deg) scale(1)` }, { opacity: 1, offset: .375, transform: `rotate(${i ? -225 : 225}deg) scale(.78)`, easing: ease.expoOut },
    { opacity: 0, transform: `rotate(${i ? -225 : 225}deg) scale(3.5)` },
  ], t(0), 800, ease.in3));
  a(one(".hyper-tunnel"), [{ opacity: 1, transform: "scale(1)" }, { opacity: 1, offset: .43, transform: "scale(1.5)", easing: ease.out2 }, { opacity: 0, transform: "scale(3)" }], t(0), 700, ease.in2);
  all(".hyper-streak").forEach((node, i) => a(node, [
    { opacity: 1, transform: "translateX(0px) scaleX(1)" }, { opacity: 0, transform: `translateX(${(reach * (.6 + (i * 37 % 48) / 120)).toFixed(0)}px) scaleX(5)` },
  ], t(.02) + (i * 89 % 48) / 48 * 80, 420, ease.in4));
  all(".hyper-meta").forEach(node => a(node, [{ opacity: 1, transform: "translateY(0px)" }, { opacity: 0, transform: "translateY(-10px)" }], t(.12), 160, ease.in2));

  // Chromatic glitch stutters across the wordmark just before the jump; steps(1) holds each keyframe until the next.
  // Offsets are written out because derived ones can land just past 1, which animate() rejects.
  const glitch = (values: string[], opacities?: number[]): Keyframe[] => [0, .22, .39, .61, .78, 1].map((offset, i) => ({
    offset, transform: values[i], ...(opacities ? { opacity: opacities[i] } : {}), easing: "steps(1, end)",
  }));
  a(one(".hyper-ghost-a"), glitch(["translateX(-10px)", "translateX(0px)", "translateX(-13px)", "translateX(0px)", "translateX(-16px)", "translateX(0px)"], [.75, 0, .75, 0, .75, 0]), t(.1), 180);
  a(one(".hyper-ghost-b"), glitch(["translateX(9px)", "translateX(0px)", "translateX(12px)", "translateX(0px)", "translateX(15px)", "translateX(0px)"], [.55, 0, .55, 0, .55, 0]), t(.1), 180);
  a(one(".hyper-word"), glitch(["translateX(-6px) skewX(-10deg)", "none", "translateX(6px) skewX(10deg)", "none", "translateX(-6px) skewX(-10deg)", "none"]), t(.1), 180);

  // Jump: flash, shockwaves, and the wordmark flies past the camera.
  const at = t(.3);
  a(one(".hyper-flash"), [{ opacity: 0 }, { opacity: .85, offset: .1, easing: ease.out2 }, { opacity: 0 }], at, 390);
  a(one(".hyper-burst"), [{ opacity: 1, transform: "rotate(45deg) scale(0)" }, { opacity: 0, transform: "rotate(135deg) scale(14)" }], at, 600, ease.expoOut);
  all(".hyper-shock").forEach((node, i) => a(node, [
    { opacity: .9, transform: "rotate(45deg) scale(.3)" }, { opacity: 0, transform: `rotate(${i ? -45 : 135}deg) scale(${7 + i * 4})` },
  ], at + i * 80, 800, ease.expoOut));
  const center = (word.length - 1) / 2;
  all(".hyper-letter").forEach((node, i) => a(node, [
    { opacity: 1, transform: "translate(0px, 0px) rotate(0deg) scale(1)" },
    { opacity: 0, transform: `translate(${((i - center) * (60 + i * 37 % 30)).toFixed(0)}px, ${(i * 53 % 80) - 40}px) rotate(${(i * 71 % 50) - 25}deg) scale(2.6)` },
  ], at + Math.abs(i - center) * 12, 500, ease.out3));
  a(one(".hyper-icon"), [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(3)" }], at, 400, ease.out2);
  a(one(".hyper-dial-ring"), [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.8)" }], at, 400, ease.out2);

  // The diamond iris tears open onto Game Mode, which zooms in behind it (see --intro in GameIntroHyper.css).
  const open = irisReach() * 1.04;
  for (const [side, axis, sign] of sides) all(`.hyper-iris-panel.hyper-iris-${side}, .hyper-iris-line.hyper-iris-${side}`).forEach(node =>
    a(node, [{ transform: `translate${axis}(0px)` }, { transform: `translate${axis}(${open * sign}px)` }], at + 20, 800, ease.expoOut));
  all(".hyper-iris-line").forEach(node => a(node, [{ opacity: .7 }, { opacity: 0 }], at + 200, 500, ease.out2));
  return at + 820;
}

/**
 * Hyperspace jump. While holding, warp streaks build and a diamond iris closes over Home. On completion the same
 * scene winds up, flashes, flings the wordmark past the camera, and tears the iris open onto Game Mode.
 *
 * Everything runs as Web Animations on transform and opacity, so the compositor keeps it at the display's refresh
 * rate even while Game Mode Home mounts, scans the library, and decodes artwork on the main thread.
 */
export function HyperGameTransition({ progress, exiting = false, covered = false, onDone }: {
  progress?: number; exiting?: boolean; covered?: boolean; onDone?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const charging = useRef<Animation[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  const holding = progress !== undefined;
  const p = Math.min(1, Math.max(0, progress ?? 1));
  const initial = useRef(p);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const list: Animation[] = [];
    charge(el, list);
    charging.current = list.slice();
    if (holding) {
      // The hold advances at one second per second, so the scene runs on its own clock and input samples only correct drift.
      list.forEach(animation => { animation.currentTime = initial.current * chargeMs; });
    } else {
      // A completed hold starts charged; button and keyboard activation play the charge quickly first.
      list.forEach(animation => { if (covered) animation.finish(); else animation.playbackRate = 2; });
      const end = jump(el, list, covered ? 0 : chargeMs / 2);
      const timer = setTimeout(() => done.current?.(), end);
      return () => { clearTimeout(timer); list.forEach(animation => animation.cancel()); charging.current = []; };
    }
    return () => { list.forEach(animation => animation.cancel()); charging.current = []; };
  }, [holding, covered]);

  useLayoutEffect(() => {
    if (!holding) return;
    const target = p * chargeMs;
    for (const animation of charging.current) {
      if (Math.abs(Number(animation.currentTime ?? 0) - target) > 60) animation.currentTime = target;
    }
  }, [holding, p]);

  const percent = Math.round(p * 100);
  return <div ref={root} className={`hyper-intro text-foreground${holding ? " hyper-hold" : ""}`} role={holding ? "status" : undefined} aria-hidden={holding ? undefined : true}>
    <div className="hyper-iris" aria-hidden="true">
      {sides.map(([side]) => <div key={side} className={`hyper-iris-panel hyper-iris-${side} bg-background`} />)}
      {sides.map(([side]) => <div key={side} className={`hyper-iris-line hyper-iris-${side} bg-primary`} />)}
    </div>
    <div className="hyper-tunnel" aria-hidden="true">{tunnel.map(i => <span key={i} className="border-primary" style={{ animationDelay: `${-i * .3}s` }} />)}</div>
    <div className="hyper-streaks" aria-hidden="true">{streaks.map(i => <span key={i} className="hyper-streak-axis" style={{ transform: `rotate(${i * 360 / streaks.length + (i * 47 % 7) - 3}deg)` }}>
      <span className="hyper-streak-mover" style={{ animationDuration: `${.7 + (i * 29 % 10) / 20}s`, animationDelay: `${-(i * .137 % 1)}s` }}>
        <span className={`hyper-streak${i % 5 ? "" : " hyper-streak-bold"}`} />
      </span>
    </span>)}</div>
    <span className="hyper-frame border-primary" aria-hidden="true" />
    <span className="hyper-frame hyper-frame-inner border-muted-foreground" aria-hidden="true" />
    <div className="hyper-core"><div className="hyper-shake">
      <div className="hyper-dial" aria-hidden="true">
        <div className="hyper-dial-ring">{segments.map(i => <span key={i} className="hyper-seg-axis" style={{ transform: `rotate(${i * 360 / segments.length}deg)` }}><span className={`hyper-seg ${i / segments.length < p ? "bg-primary" : "bg-border"}`} /></span>)}</div>
        <div className="hyper-icon text-primary"><GameControllerIcon size={44} weight="fill" /></div>
      </div>
      <p className="hyper-kicker hyper-meta text-muted-foreground">{holding ? `Keep holding to ${exiting ? "exit" : "enter"}` : "Hyperdrive engaged"}</p>
      <div className="hyper-word" aria-hidden="true">
        <span className="hyper-ghost hyper-ghost-a text-primary">{cells(word)}</span>
        <span className="hyper-ghost hyper-ghost-b text-muted-foreground">{cells(word)}</span>
        {cells(scramble(word, Math.min(1, p * 1.15)), "hyper-letter")}
      </div>
      <p className="hyper-count hyper-meta tabular-nums" aria-hidden="true">{String(percent).padStart(3, "0")}<span className="text-muted-foreground">%</span></p>
      <div className="hyper-meter hyper-meta bg-border" role={holding ? "progressbar" : undefined} aria-label={holding ? `Hold to ${exiting ? "exit" : "enter"} Game Mode` : undefined} aria-valuemin={holding ? 0 : undefined} aria-valuemax={holding ? 100 : undefined} aria-valuenow={holding ? percent : undefined}>
        <div className="hyper-meter-fill bg-primary" />
      </div>
    </div></div>
    <div className="hyper-burst bg-primary" aria-hidden="true" />
    <span className="hyper-shock border-primary" aria-hidden="true" />
    <span className="hyper-shock border-foreground" aria-hidden="true" />
    <div className="hyper-flash bg-primary" aria-hidden="true" />
  </div>;
}
