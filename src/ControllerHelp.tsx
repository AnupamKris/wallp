import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Layout = "xbox" | "playstation";
type Point = readonly [number, number];
/** A labelled control: the leader line runs from the label edge through `route` to the control. */
type Callout = { name: string; action: string; extra?: string; side: "left" | "right" | "top"; at: Point; route: Point[] };

const W = 1000;
/** Draws the right half of a symmetric outline, then mirrors it across the centre line. */
function mirrored(right: number[][]) {
  const flip = (n: number[]) => n.map((v, i) => i % 2 ? v : W - v);
  const [start, ...curves] = right;
  const back = [...curves].reverse().map((c, i, all) => {
    const from = i + 1 < all.length ? all[i + 1].slice(-2) : start;
    return c.length === 2 ? flip(from) : flip([c[2], c[3], c[0], c[1], ...from]);
  });
  const seg = (c: number[]) => `${c.length === 2 ? "L" : "C"} ${c.join(" ")}`;
  return `M ${start.join(" ")} ${curves.map(seg).join(" ")} ${back.map(seg).join(" ")} Z`;
}

const xboxBody = mirrored([[500, 128], [560, 128, 600, 118, 630, 116], [670, 114, 696, 130, 710, 160], [732, 210, 755, 300, 762, 370], [768, 420, 744, 446, 714, 446], [684, 446, 666, 424, 648, 398], [630, 372, 610, 352, 580, 352], [500, 352]]);
const psBody = mirrored([[500, 128], [585, 128], [640, 124, 690, 128, 712, 152], [738, 186, 768, 290, 782, 372], [792, 432, 766, 466, 734, 462], [706, 458, 690, 436, 674, 408], [658, 380, 636, 362, 606, 362], [500, 362]]);

const xbox: Callout[] = [
  { name: "LT", action: "Left click · hold to drag", side: "left", at: [318, 87], route: [[290, 60]] },
  { name: "LB", action: "Mouse on / off chord", side: "left", at: [318, 116], route: [] },
  { name: "Left stick", action: "Move pointer", extra: "Press (L3): keyboard", side: "left", at: [348, 205], route: [] },
  { name: "D-pad", action: "Down: show desktop", side: "left", at: [407, 292], route: [] },
  { name: "View", action: "Toggle keyboard", side: "top", at: [462, 196], route: [] },
  { name: "Menu", action: "Close app (asks first)", side: "top", at: [538, 196], route: [] },
  { name: "RT", action: "Right click · hold to drag", side: "right", at: [682, 87], route: [[710, 60]] },
  { name: "RB", action: "Mouse on / off chord", side: "right", at: [682, 116], route: [] },
  { name: "X", action: "Previous app (Alt+Tab)", side: "right", at: [597, 186], route: [[597, 154]] },
  { name: "Y", action: "Task View (Win+Tab)", side: "right", at: [639, 172], route: [[700, 194]] },
  { name: "B", action: "Escape", side: "right", at: [667, 200], route: [[720, 234]] },
  { name: "A", action: "Enter", side: "right", at: [639, 228], route: [[720, 274]] },
  { name: "Right stick", action: "Scroll up / down", extra: "Press (R3): show desktop", side: "right", at: [602, 292], route: [[720, 326]] },
];
const playstation: Callout[] = [
  { name: "L2", action: "Left click · hold to drag", side: "left", at: [318, 89], route: [[290, 60]] },
  { name: "L1", action: "Mouse on / off chord", side: "left", at: [318, 116], route: [] },
  { name: "D-pad", action: "Down: show desktop", side: "left", at: [337, 215], route: [] },
  { name: "Left stick", action: "Move pointer", extra: "Press (L3): keyboard", side: "left", at: [388, 300], route: [] },
  { name: "Create", action: "Toggle keyboard", side: "top", at: [412, 144], route: [] },
  { name: "Options", action: "Close app (asks first)", side: "top", at: [588, 144], route: [] },
  { name: "R2", action: "Right click · hold to drag", side: "right", at: [682, 89], route: [[710, 60]] },
  { name: "R1", action: "Mouse on / off chord", side: "right", at: [682, 116], route: [] },
  { name: "Square", action: "Previous app (Alt+Tab)", side: "right", at: [612, 199], route: [[612, 166]] },
  { name: "Triangle", action: "Task View (Win+Tab)", side: "right", at: [654, 185], route: [[720, 206]] },
  { name: "Circle", action: "Escape", side: "right", at: [682, 213], route: [[730, 246]] },
  { name: "Cross", action: "Enter", side: "right", at: [654, 241], route: [[720, 286]] },
  { name: "Right stick", action: "Scroll up / down", extra: "Press (R3): show desktop", side: "right", at: [612, 300], route: [[720, 336]] },
];

/** Label anchor positions; the order in each array above decides the stacking. */
function labelPositions(callouts: Callout[]) {
  const rows = { left: [60, 112, 205, 292], right: [60, 112, 154, 194, 234, 274, 326] };
  const playRows = { left: [60, 112, 215, 300], right: [60, 112, 166, 206, 246, 286, 336] };
  const set = callouts === playstation ? playRows : rows;
  let l = 0, r = 0;
  return callouts.map(c => {
    if (c.side === "top") return { x: c.at[0] + (c.at[0] < 500 ? 4 : -4), y: 22, anchor: (c.at[0] < 500 ? "end" : "start") as "end" | "start", line: [c.at[0], 50] as Point };
    const y = c.side === "left" ? set.left[l++] : set.right[r++];
    const x = c.side === "left" ? 200 : 800;
    return { x, y, anchor: (c.side === "left" ? "end" : "start") as "end" | "start", line: [c.side === "left" ? 208 : 792, y] as Point };
  });
}

function Stick({ x, y }: { x: number; y: number }) {
  return <g><circle cx={x} cy={y} r={32} className="fill-muted stroke-foreground" strokeWidth={2} /><circle cx={x} cy={y} r={20} className="fill-card stroke-foreground/50" strokeWidth={1.5} /></g>;
}
function Dpad({ x, y }: { x: number; y: number }) {
  const a = 23, b = 8;
  return <path d={`M ${x - b} ${y - a} h ${2 * b} v ${a - b} h ${a - b} v ${2 * b} h ${b - a} v ${a - b} h ${-2 * b} v ${b - a} h ${b - a} v ${-2 * b} h ${a - b} Z`} className="fill-muted stroke-foreground" strokeWidth={2} strokeLinejoin="round" />;
}
function Face({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <g><circle cx={x} cy={y} r={14} className="fill-muted stroke-foreground" strokeWidth={2} />{children}</g>;
}
function Letter({ x, y, children }: { x: number; y: number; children: string }) {
  return <text x={x} y={y + 5} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-foreground">{children}</text>;
}
function Shoulders() {
  return <g className="fill-muted stroke-foreground" strokeWidth={2}>
    <rect x={318} y={74} width={64} height={28} rx={10} /><rect x={618} y={74} width={64} height={28} rx={10} />
    <path d="M 296 138 C 306 116 334 104 382 106 L 382 118 C 342 118 318 126 308 144 Z" strokeLinejoin="round" />
    <path d="M 704 138 C 694 116 666 104 618 106 L 618 118 C 658 118 682 126 692 144 Z" strokeLinejoin="round" />
  </g>;
}

function XboxOutline() {
  return <g>
    <Shoulders />
    <path d={xboxBody} className="fill-card stroke-foreground" strokeWidth={2.5} strokeLinejoin="round" />
    <circle cx={500} cy={162} r={18} className="fill-muted stroke-foreground" strokeWidth={2} />
    <path d="M 489 152 L 511 172 M 511 152 L 489 172" className="stroke-foreground/60" strokeWidth={3} strokeLinecap="round" />
    <circle cx={462} cy={205} r={9} className="fill-muted stroke-foreground" strokeWidth={2} />
    <circle cx={538} cy={205} r={9} className="fill-muted stroke-foreground" strokeWidth={2} />
    <Stick x={380} y={205} /><Dpad x={430} y={292} /><Stick x={570} y={292} />
    <Face x={625} y={172}><Letter x={625} y={172}>Y</Letter></Face>
    <Face x={597} y={200}><Letter x={597} y={200}>X</Letter></Face>
    <Face x={653} y={200}><Letter x={653} y={200}>B</Letter></Face>
    <Face x={625} y={228}><Letter x={625} y={228}>A</Letter></Face>
  </g>;
}
function PlayStationOutline() {
  const glyph = "fill-none stroke-foreground";
  return <g>
    <Shoulders />
    <path d={psBody} className="fill-card stroke-foreground" strokeWidth={2.5} strokeLinejoin="round" />
    <rect x={425} y={132} width={150} height={82} rx={6} className="fill-muted stroke-foreground" strokeWidth={2} />
    <rect x={404} y={140} width={16} height={8} rx={4} transform="rotate(-20 412 144)" className="fill-muted stroke-foreground" strokeWidth={2} />
    <rect x={580} y={140} width={16} height={8} rx={4} transform="rotate(20 588 144)" className="fill-muted stroke-foreground" strokeWidth={2} />
    <circle cx={500} cy={300} r={11} className="fill-muted stroke-foreground" strokeWidth={2} />
    <Dpad x={360} y={215} /><Stick x={420} y={300} /><Stick x={580} y={300} />
    <Face x={640} y={185}><path d="M 640 178 L 647 190 L 633 190 Z" className={glyph} strokeWidth={2} strokeLinejoin="round" /></Face>
    <Face x={612} y={213}><rect x={606} y={207} width={12} height={12} className={glyph} strokeWidth={2} /></Face>
    <Face x={668} y={213}><circle cx={668} cy={213} r={6.5} className={glyph} strokeWidth={2} /></Face>
    <Face x={640} y={241}><path d="M 634 235 L 646 247 M 646 235 L 634 247" className={glyph} strokeWidth={2} strokeLinecap="round" /></Face>
  </g>;
}

export function ControllerHelp() {
  const [layout, setLayout] = useState<Layout>("xbox");
  const callouts = layout === "xbox" ? xbox : playstation;
  const labels = labelPositions(callouts);
  const chord = layout === "xbox" ? "LB + RB + LT + RT" : "L1 + R1 + L2 + R2";
  const [confirm, cancel] = layout === "xbox" ? ["A", "B"] : ["Cross", "Circle"];
  const typing = layout === "xbox"
    ? "X backspace · Y space · LT shift · RT symbols · LB / RB move the cursor · Menu enter"
    : "Square backspace · Triangle space · L2 shift · R2 symbols · L1 / R1 move the cursor · Options enter";
  return <section className="grid gap-4" aria-label="Controller mouse mode buttons">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-muted-foreground">Hold <strong className="font-medium text-foreground">{chord}</strong> for one second in Game Mode to turn mouse mode on or off.</p>
      <div className="flex gap-1" role="group" aria-label="Controller type">
        <Button size="sm" variant={layout === "xbox" ? "secondary" : "outline"} aria-pressed={layout === "xbox"} onClick={() => setLayout("xbox")}>Xbox</Button>
        <Button size="sm" variant={layout === "playstation" ? "secondary" : "outline"} aria-pressed={layout === "playstation"} onClick={() => setLayout("playstation")}>PS4 / PS5</Button>
      </div>
    </div>
    <svg viewBox={`0 0 ${W} 480`} className="w-full border border-border bg-background" role="group" aria-label={`${layout === "xbox" ? "Xbox" : "PlayStation"} controller in mouse mode`}>
      <g aria-hidden="true">{layout === "xbox" ? <XboxOutline /> : <PlayStationOutline />}</g>
      {callouts.map((c, i) => {
        const label = labels[i];
        const points = [label.line, ...c.route, c.at].map(p => p.join(",")).join(" ");
        const top = c.side === "top";
        return <g key={`${layout}-${c.name}`}>
          <polyline points={points} className="fill-none stroke-muted-foreground" strokeWidth={1.25} aria-hidden="true" />
          <circle cx={c.at[0]} cy={c.at[1]} r={3.5} className="fill-primary" aria-hidden="true" />
          <text x={label.x} y={label.y - (top ? 0 : 4)} textAnchor={label.anchor} fontSize={14} fontWeight={600} className="fill-foreground">{c.name}</text>
          <text x={label.x} y={label.y + (top ? 17 : 13)} textAnchor={label.anchor} fontSize={12.5} className="fill-muted-foreground">{c.action}</text>
          {c.extra && <text x={label.x} y={label.y + 29} textAnchor={label.anchor} fontSize={12.5} className="fill-muted-foreground">{c.extra}</text>}
        </g>;
      })}
    </svg>
    <ul className="grid gap-1 text-muted-foreground sm:grid-cols-2">
      <li className="sm:col-span-2"><strong className="font-medium text-foreground">Hold L3 + R3</strong> (press both sticks) for half a second to open the command menu, with or without mouse mode.</li>
      <li className="sm:col-span-2"><strong className="font-medium text-foreground">Keyboard shortcuts:</strong> {typing}.</li>
      <li>In the keyboard or close prompt: stick / D-pad selects, {confirm} chooses, {cancel} cancels.</li>
      <li>Closing asks first and starts on Cancel. It expires after 30 seconds.</li>
      <li>D-pad Down shows the desktop only when no panel is open. R3 works anywhere.</li>
      <li>Leaving Game Mode or disconnecting the controller turns mouse mode off.</li>
    </ul>
  </section>;
}
