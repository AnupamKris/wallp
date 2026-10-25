import { useLayoutEffect, useRef } from "react";
import { GameControllerIcon } from "@phosphor-icons/react";
import { gsap } from "gsap";
import "./GameIntroOverdrive.css";

const ticks = Array.from({ length: 24 }, (_, i) => i);
const title = ["GAME", "MODE"];

/** Both phases use this exact scene and charge timeline, so the completed hold is the intro's first frame. */
function chargeTimeline(el: HTMLDivElement) {
  const q = gsap.utils.selector(el);
  return gsap.timeline({ paused: true, defaults: { ease: "none" } })
    .fromTo(q(".overdrive-veil"), { opacity: 0 }, { opacity: .86, duration: 1 }, 0)
    .fromTo(q(".overdrive-gate"), { xPercent: i => i ? 106 : -106 }, { xPercent: 0, duration: .85, ease: "power2.inOut" }, .15)
    .fromTo(q(".overdrive-orbit"), { scale: 1.7, rotation: i => i ? -100 : 100, opacity: 0 }, { scale: 1, rotation: i => i ? -45 : 45, opacity: .7, duration: 1, ease: "power2.out" }, 0)
    .fromTo(q(".overdrive-cross"), { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: .45, duration: .65 }, .15)
    .fromTo(q(".overdrive-stage"), { scale: .7, opacity: 0, y: 24 }, { scale: 1, opacity: 1, y: 0, duration: .8, ease: "power3.out" }, 0)
    .fromTo(q(".overdrive-title"), { xPercent: i => i ? 32 : -32, opacity: 0 }, { xPercent: 0, opacity: 1, duration: .7, ease: "power3.out" }, .15)
    .fromTo(q(".overdrive-echo"), { xPercent: i => i ? 20 : -20, opacity: 0 }, { xPercent: 0, opacity: .13, duration: .8 }, .1);
}

export function OverdriveGameTransition({ progress, exiting = false, covered = false, onDone }: {
  progress?: number; exiting?: boolean; covered?: boolean; onDone?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const charge = useRef<gsap.core.Timeline | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const holding = progress !== undefined;
  const p = Math.min(1, Math.max(0, progress ?? 1));
  const initial = useRef(p);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ctx = gsap.context(() => {
      const q = gsap.utils.selector(el);
      const charging = chargeTimeline(el);
      charge.current = charging;
      charging.progress(holding ? initial.current : 1);
      if (holding) return;

      const tl = gsap.timeline({ defaults: { ease: "expo.out" }, onComplete: () => done.current?.() });
      // Button/keyboard activation closes the gates first. A completed hold starts fully covered.
      if (!covered) {
        tl.fromTo(q(".overdrive-gate"), { xPercent: i => i ? 106 : -106 }, { xPercent: 0, duration: .24, ease: "power3.in" }, 0);
        tl.fromTo(q(".overdrive-letter"), { yPercent: i => i < 4 ? 120 : -120, rotationX: -80 }, { yPercent: 0, rotationX: 0, duration: .55, stagger: { each: .025, from: "center" } }, .12);
      } else {
        // Keep the charged wordmark visible across the handoff, then kick its letters on impact.
        tl.to(q(".overdrive-letter"), { yPercent: i => i % 2 ? 10 : -10, rotationX: -15, duration: .1 }, .05)
          .to(q(".overdrive-letter"), { yPercent: 0, rotationX: 0, duration: .3, stagger: .015 }, .15);
      }
      tl.to(q(".overdrive-orbit"), { rotation: i => i ? -225 : 225, scale: .6, opacity: 0, duration: .65 }, .04)
        .fromTo(q(".overdrive-icon"), { rotation: -18, scale: .65 }, { rotation: 0, scale: 1, duration: .4, ease: "back.out(2)" }, .04)
        .to(q(".overdrive-stage"), { scale: 1.12, duration: .7 }, .1)
        .to(q(".overdrive-title"), { skewX: -9, duration: .28 }, .18)
        .to(q(".overdrive-echo"), { xPercent: i => i ? -28 : 28, opacity: 0, duration: 1.1, ease: "power2.in" }, .06)
        .fromTo(q(".overdrive-impact"), { scale: .3, rotation: 45, opacity: .8 }, { scale: 5.5, rotation: 135, opacity: 0, duration: .9 }, .28)
        .fromTo(q(".overdrive-impact-inner"), { scale: .3, rotation: 45, opacity: .6 }, { scale: 4.5, rotation: -45, opacity: 0, duration: .9 }, .4)
        .fromTo(q(".overdrive-scan"), { scaleX: 0, opacity: .9 }, { scaleX: 1, opacity: 0, duration: .7 }, .3)
        .to(q(".overdrive-cross"), { scaleX: 1.5, opacity: 0, duration: .5 }, .5)
        // A single diagonal cut turns into the seam that tears the scene open.
        .fromTo(q(".overdrive-cut"), { scaleY: 0, opacity: 1 }, { scaleY: 1, duration: .22, ease: "power4.in" }, .76)
        .to(q(".overdrive-title"), { xPercent: i => i ? 130 : -130, opacity: 0, duration: .42, ease: "power4.in", stagger: .04 }, .96)
        .to(q(".overdrive-icon, .overdrive-caption, .overdrive-charge"), { y: -18, opacity: 0, duration: .22 }, .94)
        .to(q(".overdrive-cut"), { scaleX: 24, opacity: 0, duration: .38, ease: "power2.out" }, 1.02)
        .to(q(".overdrive-veil"), { opacity: 0, duration: .2 }, 1.13)
        .to(q(".overdrive-gate"), { xPercent: i => i ? 106 : -106, duration: .65, ease: "expo.inOut" }, 1.15);
    }, el);
    return () => { ctx.revert(); charge.current = null; };
  }, [holding, covered]);

  useLayoutEffect(() => {
    if (!holding || !charge.current) return;
    // Smooth the controller's 50ms input samples. The entrance starts from the completed scene.
    const tween = gsap.to(charge.current, { progress: p, duration: .08, ease: "power1.out", overwrite: true });
    return () => { tween.kill(); };
  }, [holding, p]);

  return <div ref={root} className={`overdrive-intro text-foreground${holding ? " overdrive-hold" : ""}`} aria-hidden={holding ? undefined : true}>
    <div className="overdrive-veil bg-background" />
    <div className="overdrive-gate overdrive-gate-left bg-background border-primary" />
    <div className="overdrive-gate overdrive-gate-right bg-background border-primary" />
    <div className="overdrive-cross border-primary" />
    <div className="overdrive-echo overdrive-echo-top" aria-hidden="true">GAME / GAME / GAME</div>
    <div className="overdrive-echo overdrive-echo-bottom" aria-hidden="true">MODE / MODE / MODE</div>
    <div className="overdrive-orbit border-primary" aria-hidden="true" />
    <div className="overdrive-orbit overdrive-orbit-inner border-muted-foreground" aria-hidden="true" />
    <div className="overdrive-impact border-primary" aria-hidden="true" />
    <div className="overdrive-impact overdrive-impact-inner border-primary" aria-hidden="true" />
    <div className="overdrive-stage">
      <div className="overdrive-icon text-primary" aria-hidden="true"><GameControllerIcon size={36} weight="fill" /></div>
      <p className="overdrive-caption text-muted-foreground">{holding ? `Keep holding to ${exiting ? "exit" : "enter"}` : "Overdrive / engaged"}</p>
      <div className="overdrive-wordmark" aria-hidden="true">{title.map(row => <div key={row} className="overdrive-title">{[...row].map((letter, i) => <span key={i} className="overdrive-letter">{letter}</span>)}</div>)}</div>
      <div className="overdrive-charge" role={holding ? "progressbar" : undefined} aria-label={holding ? `Hold to ${exiting ? "exit" : "enter"} Game Mode` : undefined} aria-valuemin={holding ? 0 : undefined} aria-valuemax={holding ? 100 : undefined} aria-valuenow={holding ? Math.round(p * 100) : undefined}>
        <div className="overdrive-ticks" aria-hidden="true">{ticks.map(i => <span key={i} className={i / ticks.length < p ? "bg-primary" : "bg-border"} />)}</div>
        <span className="overdrive-count tabular-nums" aria-hidden="true">{String(Math.round(p * 100)).padStart(3, "0")}<span className="text-muted-foreground"> / 100</span></span>
      </div>
    </div>
    <div className="overdrive-scan bg-primary" aria-hidden="true" />
    <div className="overdrive-cut bg-primary" aria-hidden="true" />
  </div>;
}
