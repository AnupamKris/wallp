/** Animate only SVG hands. The caller cancels this loop whenever clocks are hidden. */
export function startClockSweep(face: SVGSVGElement, timestamp: number): () => void {
  const hands = Array.from(face.querySelectorAll<SVGElement>("[data-period]")).map(element => ({
    element,
    angle: Number(element.getAttribute("data-angle")),
    period: Number(element.getAttribute("data-period")),
  }));
  let frame: number;
  const sweep = () => {
    const elapsed = (Date.now() - timestamp) / 1000;
    for (const { element, angle, period } of hands) {
      element.setAttribute("transform", `rotate(${angle + elapsed * 360 / period} 160 160)`);
    }
    frame = requestAnimationFrame(sweep);
  };
  sweep();
  return () => cancelAnimationFrame(frame);
}

/** Keep text/accessibility time current; resume from real time instead of catching up. */
export function startClockTicker(update: (now: Date) => void): () => void {
  update(new Date());
  const timer = setInterval(() => update(new Date()), 1000);
  return () => clearInterval(timer);
}
