import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Card } from "@/components/ui/card";
import type { BuddyVariant } from "./home-layout";
import { isLinux } from "./platform";
import "./DeskBuddy.css";

type Activity = { x: number; y: number; presses: number };
const svgProps = { className: "desk-buddy", viewBox: "0 0 240 180", role: "img", fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function DeskBuddy({ active, variant = "cat" }: { active: boolean; variant?: BuddyVariant }) {
  const drawing = useRef<SVGSVGElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false, timer = 0, resetMouse = 0, resetKeyboard = 0, strikes = 0;
    let previous: Activity | undefined;
    const svg = drawing.current!;
    const rest = () => { svg.dataset.typing = "false"; svg.dataset.moving = "false"; };
    function react(next: Activity) {
      if (disposed) return;
      const dx = previous ? next.x - previous.x : 0;
      const dy = previous ? next.y - previous.y : 0;
      if (dx || dy) {
        svg.style.setProperty("--buddy-x", `${Math.max(-8, Math.min(8, dx / 3))}px`);
        svg.style.setProperty("--buddy-y", `${Math.max(-4, Math.min(4, dy / 3))}px`);
        svg.dataset.moving = "true";
        window.clearTimeout(resetMouse);
        resetMouse = window.setTimeout(() => { svg.dataset.moving = "false"; }, 160);
      }
      if (previous && next.presses !== previous.presses) {
        strikes++;
        svg.dataset.typing = "true";
        svg.dataset.paw = String(strikes % 2);
        window.clearTimeout(resetKeyboard);
        resetKeyboard = window.setTimeout(() => { svg.dataset.typing = "false"; }, 160);
      }
      previous = next;
    }
    // Global activity comes from a Windows hook; elsewhere react to input within Home.
    const native = isTauri() && !isLinux;
    if (native) {
      const poll = async () => {
        try {
          const next = await invoke<Activity>("desk_buddy_activity", { enabled: true });
          if (!disposed) { setError(false); react(next); }
        } catch { if (!disposed) setError(true); }
        if (!disposed) timer = window.setTimeout(poll, 40);
      };
      void poll();
    }
    // Browser previews react to input within the page; native Home uses Windows activity.
    let browser: Activity = { x: 0, y: 0, presses: 0 };
    const move = (event: MouseEvent) => { browser = { ...browser, x: event.screenX, y: event.screenY }; react(browser); };
    const key = () => { browser = { ...browser, presses: browser.presses + 1 }; react(browser); };
    if (!native) {
      previous = browser;
      window.addEventListener("mousemove", move);
      window.addEventListener("keydown", key);
    }
    return () => {
      disposed = true;
      window.clearTimeout(timer); window.clearTimeout(resetMouse); window.clearTimeout(resetKeyboard);
      window.removeEventListener("mousemove", move); window.removeEventListener("keydown", key);
      rest();
      // Also expires natively if the webview closes without running cleanup.
      if (native) void invoke("desk_buddy_activity", { enabled: false }).catch(() => {});
    };
  }, [active, variant]);
  return <Card size="sm" className="h-full w-full gap-1 px-3" aria-label="Desk buddy">
    <div className="flex min-h-0 flex-1 items-center justify-center">
      {variant === "simple" ?
      <svg ref={drawing} {...svgProps} data-variant="simple" aria-label="A round cat leaning over a desk, moving its mouse and tapping its keyboard">
        <path className="fill-muted" stroke="none" d="M2 110 238 134V178H2Z" />
        <path d="M2 110 238 134" strokeWidth={2.5} />
        <g>
          <path className="fill-card" stroke="var(--muted-foreground)" strokeWidth={1.2} opacity={0.5} d="M44 118 L 218 135 L 213 167 L 39 150 Z" />
          <path stroke="currentColor" strokeWidth={0.8} strokeDasharray="2 2" opacity={0.3} d="M46 120 L 216 137 L 211 165 L 41 148 Z" />
        </g>
        <g className="buddy-head">
          <path className="fill-card" strokeWidth={2.5} d="M30 148 C 24 102 36 68 62 54 C 64 42 70 28 82 22 C 92 18 98 32 104 42 C 114 39 126 39 136 42 C 142 32 148 18 158 22 C 170 28 176 42 178 54 C 204 68 216 102 210 148 Z" />
          <path className="buddy-ears" d="M76 46 C 79 36 84 31 87 29 C 89 36 91 43 93 47" />
          <path className="buddy-ears" d="M164 46 C 161 36 156 31 153 29 C 151 36 149 43 147 47" />
          <path className="buddy-whiskers" d="M64 78 l -16 -2 M65 85 l -15 3 M176 78 l 16 -2 M175 85 l 15 3" />
          <path className="buddy-blush" d="M86 82l-2 5 M90 82l-2 5 M94 82l-2 5 M148 82l-2 5 M152 82l-2 5 M156 82l-2 5" />
          <g className="buddy-eyes" style={{ transformOrigin: "120px 74px" }}>
            <circle cx="98" cy="74" r="4.5" fill="currentColor" stroke="none" />
            <circle cx="96.5" cy="72.2" r="1.5" className="fill-card" stroke="none" />
            <circle cx="142" cy="74" r="4.5" fill="currentColor" stroke="none" />
            <circle cx="140.5" cy="72.2" r="1.5" className="fill-card" stroke="none" />
          </g>
          <path d="M118.5 79.5 l 1.5 1.5 l 1.5 -1.5" strokeWidth={1.5} stroke="currentColor" />
          <path d="M112 83 q 4 5 8 0 q 4 5 8 0" strokeWidth={2} />
        </g>
        <g className="buddy-cable">
          <path d="M80 120 C 78 114 74 113 75 109 C 76 105 82 106 81 110 C 80 114 74 114 76 107 C 77 101 70 98 64 96" />
          <path d="M78 120 l 5 0.5" strokeWidth={2.5} stroke="currentColor" />
        </g>
        <path className="fill-muted" stroke="currentColor" strokeWidth={1.8} d="M59 149 L 157 159 L 156 164 L 58 154 Z" />
        <path className="fill-card" stroke="currentColor" strokeWidth={2} d="M63 121 L 161 131 L 157 159 L 59 149 Z" />
        <g className="buddy-keys">
          <line x1="62" y1="128" x2="160" y2="138" />
          <line x1="61" y1="135" x2="159" y2="145" />
          <line x1="60" y1="142" x2="158" y2="152" />
          <line x1="72" y1="122" x2="71.5" y2="129" strokeWidth={1.3} />
          <line x1="81" y1="123" x2="80.5" y2="130" strokeWidth={1} />
          <line x1="90" y1="124" x2="89.5" y2="131" strokeWidth={1} />
          <line x1="99" y1="125" x2="98.5" y2="132" strokeWidth={1} />
          <line x1="108" y1="126" x2="107.5" y2="133" strokeWidth={1} />
          <line x1="117" y1="127" x2="116.5" y2="134" strokeWidth={1} />
          <line x1="126" y1="128" x2="125.5" y2="135" strokeWidth={1} />
          <line x1="135" y1="129" x2="134.5" y2="136" strokeWidth={1} />
          <line x1="145" y1="130" x2="144.5" y2="137" strokeWidth={1.4} />
          <line x1="75" y1="129.5" x2="74.5" y2="136.5" strokeWidth={1.4} />
          <line x1="85" y1="130.5" x2="84.5" y2="137.5" strokeWidth={1} />
          <line x1="95" y1="131.5" x2="94.5" y2="138.5" strokeWidth={1} />
          <line x1="105" y1="132.5" x2="104.5" y2="139.5" strokeWidth={1} />
          <line x1="115" y1="133.5" x2="114.5" y2="140.5" strokeWidth={1} />
          <line x1="125" y1="134.5" x2="124.5" y2="141.5" strokeWidth={1} />
          <line x1="135" y1="135.5" x2="134.5" y2="142.5" strokeWidth={1} />
          <line x1="146" y1="136.5" x2="145.5" y2="143.5" strokeWidth={1.2} />
          <line x1="77" y1="136.5" x2="76.5" y2="143.5" strokeWidth={1.5} />
          <line x1="88" y1="137.5" x2="87.5" y2="144.5" strokeWidth={1} />
          <line x1="99" y1="138.5" x2="98.5" y2="145.5" strokeWidth={1} />
          <line x1="110" y1="139.7" x2="109.5" y2="146.7" strokeWidth={1} />
          <line x1="121" y1="140.8" x2="120.5" y2="147.8" strokeWidth={1} />
          <line x1="132" y1="142" x2="131.5" y2="149" strokeWidth={1} />
          <line x1="143" y1="143" x2="142.5" y2="150" strokeWidth={1.6} />
          <line x1="72" y1="143.2" x2="71.5" y2="150.2" strokeWidth={1.2} />
          <line x1="83" y1="144.5" x2="82.5" y2="151.5" strokeWidth={1.3} />
          <line x1="93" y1="145.5" x2="92.5" y2="152.5" stroke="currentColor" strokeWidth={1.8} />
          <line x1="134" y1="149.5" x2="133.5" y2="156.5" stroke="currentColor" strokeWidth={1.8} />
          <line x1="144" y1="150.5" x2="143.5" y2="157.5" strokeWidth={1.3} />
        </g>
        <path d="M96 149 L 131 153" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <g className="buddy-mouse">
          <path className="fill-card" stroke="currentColor" strokeWidth={1.8} d="M174 139 C 172 134 175 130 182 130 C 189 130 192 134 190 139 C 193 148 193 158 188 163 C 183 166 179 166 175 162 C 171 157 171 147 174 139 Z" />
          <line x1="182" y1="130" x2="182" y2="142" stroke="var(--muted-foreground)" strokeWidth={1.2} />
          <rect x="180.5" y="133" width="3" height="6" rx="1.5" className="fill-card" stroke="currentColor" strokeWidth={1.2} />
          <path d="M173 145 C 174 149 174 153 175 156" stroke="var(--muted-foreground)" strokeWidth={1} />
        </g>
        <g className="buddy-left-paw">
          <path className="fill-card" strokeWidth={2.5} d="M68 94 C 63 110 63 126 68 136 C 72 144 94 144 98 135 C 102 125 99 110 95 94 Z" />
          <path stroke="var(--muted-foreground)" strokeWidth={1.3} d="M77 137 C 77 140 78 142 79 143 M86 138 C 86 141 86 143 85 144" />
        </g>
        <g className="buddy-right-paw">
          <path className="fill-card" strokeWidth={2.5} d="M166 96 C 162 110 162 124 165 133 C 169 143 191 143 194 133 C 197 124 195 110 190 96 Z" />
          <path stroke="var(--muted-foreground)" strokeWidth={1.3} d="M176 135 C 176 138 177 140 178 141 M184 135 C 184 138 183 140 182 141" />
        </g>
        <g className="buddy-impact"><path d="m54 116-6-4m54-4 1-7m58 14 6-4" strokeWidth={2} /></g>
      </svg> :
      <svg ref={drawing} {...svgProps} aria-label="A little cat at a desk, moving its mouse and tapping its keyboard">
        <path className="buddy-tail" d="M166 131c49 9 48-39 25-26-11 6-4 19 8 16" />
        <path className="fill-muted" d="M66 148c0-51 15-73 54-73s54 22 54 73" />
        <g className="buddy-head">
          <path className="fill-card" strokeWidth={2.5} d="M68 62 C 67 36 78 22 88 22 C 98 22 104 36 108 44 C 114 41 126 41 132 44 C 136 36 142 22 152 22 C 162 22 173 36 172 62 C 186 102 165 125 120 125 C 75 125 54 102 68 62 Z" />
          <path className="buddy-ears" d="M82 42 C 85 34 89 29 93 28 M158 42 C 155 34 151 29 147 28" />
          <path className="buddy-whiskers" d="M72 88 l -16 -2 M73 95 l -15 3 M168 88 l 16 -2 M167 95 l 15 3" />
          <path className="buddy-blush" d="M88 88l-2 5 M92 88l-2 5 M96 88l-2 5 M144 88l-2 5 M148 88l-2 5 M152 88l-2 5" />
          <g className="buddy-eyes" style={{ transformOrigin: "120px 80px" }}>
            <circle cx="102" cy="80" r="4.5" fill="currentColor" stroke="none" />
            <circle cx="100.5" cy="78.2" r="1.5" className="fill-card" stroke="none" />
            <circle cx="138" cy="80" r="4.5" fill="currentColor" stroke="none" />
            <circle cx="136.5" cy="78.2" r="1.5" className="fill-card" stroke="none" />
          </g>
          <path d="M118.5 86 l 1.5 1.5 l 1.5 -1.5" strokeWidth={1.5} stroke="currentColor" />
          <path d="M112 90 q 4 5 8 0 q 4 5 8 0" strokeWidth={2} />
        </g>
        <path className="fill-muted" d="M24 139h192v25H24z" />
        <path d="M18 139h204M34 164v10m172-10v10" strokeWidth={2.5} />
        <path className="fill-muted" stroke="currentColor" strokeWidth={1.8} d="m49 137 2 5 h94 l 2 -5 Z" />
        <path className="fill-card" stroke="currentColor" strokeWidth={2} d="m51 137 6-22h86l6 22Z" />
        <g className="buddy-keys">
          <line x1="55" y1="120" x2="141" y2="120" />
          <line x1="53" y1="126" x2="143" y2="126" />
          <line x1="51.5" y1="132" x2="144.5" y2="132" />
          <line x1="64" y1="115" x2="63.5" y2="120" />
          <line x1="74" y1="115" x2="73.5" y2="120" />
          <line x1="84" y1="115" x2="83.5" y2="120" />
          <line x1="94" y1="115" x2="93.5" y2="120" />
          <line x1="104" y1="115" x2="103.5" y2="120" />
          <line x1="114" y1="115" x2="113.5" y2="120" />
          <line x1="124" y1="115" x2="123.5" y2="120" />
          <line x1="133" y1="115" x2="132.5" y2="120" />
          <line x1="66" y1="120" x2="65" y2="126" />
          <line x1="77" y1="120" x2="76" y2="126" />
          <line x1="88" y1="120" x2="87" y2="126" />
          <line x1="99" y1="120" x2="98" y2="126" />
          <line x1="110" y1="120" x2="109" y2="126" />
          <line x1="121" y1="120" x2="120" y2="126" />
          <line x1="132" y1="120" x2="131" y2="126" />
          <line x1="68" y1="126" x2="67" y2="132" />
          <line x1="80" y1="126" x2="79" y2="132" />
          <line x1="92" y1="126" x2="91" y2="132" />
          <line x1="104" y1="126" x2="103" y2="132" />
          <line x1="116" y1="126" x2="115" y2="132" />
          <line x1="128" y1="126" x2="127" y2="132" />
          <line x1="72" y1="132" x2="70.5" y2="137" />
          <line x1="82" y1="132" x2="81" y2="137" stroke="currentColor" strokeWidth={1.8} />
          <line x1="118" y1="132" x2="117.5" y2="137" stroke="currentColor" strokeWidth={1.8} />
          <line x1="128" y1="132" x2="127.5" y2="137" />
        </g>
        <path d="M84 135 h 32" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <g className="buddy-mouse">
          <path className="fill-card" stroke="currentColor" strokeWidth={1.8} d="M172 132v-9a10 10 0 0 1 20 0v9Z" />
          <path d="M182 114v7" stroke="var(--muted-foreground)" strokeWidth={1.2} />
          <path d="M182 114c0-13 17-6 17-17" stroke="var(--muted-foreground)" strokeWidth={1.5} />
        </g>
        <g className="buddy-left-paw">
          <path className="fill-card" strokeWidth={2.5} d="M78 107c-12-6-21 4-14 14 5 8 25 10 29 0 2-6-7-11-15-14Z" />
          <path stroke="var(--muted-foreground)" strokeWidth={1.3} d="m72 119 1 4m6-3 1 4" />
        </g>
        <g className="buddy-right-paw">
          <path className="fill-card" strokeWidth={2.5} d="M158 106c10-7 24 0 26 10 2 11-17 12-25 6-6-4-7-11-1-16Z" />
          <path stroke="var(--muted-foreground)" strokeWidth={1.3} d="m171 117 1 4m6-5 1 4" />
        </g>
        <g className="buddy-impact"><path d="m54 108-5-5m47 9 5-5m19 2 2-7" strokeWidth={2} /></g>
      </svg>}
    </div>
    <p className="shrink-0 text-center text-[10px] leading-snug text-muted-foreground" role={error ? "status" : undefined}>
      {error ? "Input unavailable. Trying again…" : "Desk buddy"}
    </p>
  </Card>;
}
