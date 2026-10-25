import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DesktopSettings } from "./Taskbar";
import { LauncherSettings } from "./Launcher";
import { startClockSweep } from "./clock-motion";
import { ThemeSettings, type Theme } from "./Theme";

export const zones = [
  { label: "Shanghai", zone: "Asia/Shanghai", color: "#82cbd1" },
  { label: "Melbourne", zone: "Australia/Melbourne", color: "#e5ad78" },
  { label: "India", zone: "Asia/Kolkata", color: "#b3a0df" },
] as const;
export const styles = [
  { id: "dial", label: "Index", description: "Fine minute markers" },
  { id: "bauhaus", label: "Baton", description: "Bold geometric hands" },
  { id: "orbit", label: "Orbit", description: "An open, quiet dial" },
  { id: "numeral", label: "Numeral", description: "Twelve clear hour numbers" },
  { id: "roman", label: "Roman", description: "A classic chapter ring" },
  { id: "railway", label: "Railway", description: "Bold station-clock markers" },
  { id: "dots", label: "Dots", description: "Twelve small points of light" },
  { id: "sector", label: "Sector", description: "Concentric rings and quarters" },
  { id: "minimal", label: "Minimal", description: "Only hands, only time" },
  { id: "digital", label: "Mono", description: "Classic digital" },
  { id: "split", label: "Split", description: "Stacked hours and minutes" },
  { id: "segment", label: "Segment", description: "Seven-segment display" },
  { id: "flip", label: "Flip", description: "Split-flap number cards" },
  { id: "matrix", label: "Matrix", description: "Dots of light" },
  { id: "outline", label: "Outline", description: "Light, hollow numerals" },
  { id: "terminal", label: "Terminal", description: "A quiet command line" },
  { id: "words", label: "Words", description: "Time, spelled out" },
  { id: "blocks", label: "Blocks", description: "A column for every unit" },
] as const;
export type ClockStyle = typeof styles[number]["id"];
const analogueStyles: readonly ClockStyle[] = ["dial", "bauhaus", "orbit", "numeral", "roman", "railway", "dots", "sector", "minimal"];
const MIN_CLOCK_SIZE = 120;
const MAX_CLOCK_SIZE = 2400;
const sizePresets = [
  { label: "Regular", size: 240 },
  { label: "Large", size: 600 },
  { label: "Huge", size: 1000 },
  { label: "Absurd", size: 1800 },
];
export type Settings = { style: ClockStyle; layout: "row" | "stack"; size: number; stackedAnalogue: boolean; seconds: boolean; labels: boolean };
export const defaults: Settings = { style: "dial", layout: "row", size: 240, stackedAnalogue: true, seconds: true, labels: true };
export function loadSettings(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem("wallp.clocks") || "null");
    if (!value || typeof value !== "object") return defaults;
    return {
      style: styles.some(s => s.id === value.style) ? value.style : defaults.style,
      layout: value.layout === "stack" ? "stack" : "row",
      size: typeof value.size === "number" && Number.isFinite(value.size) ? Math.max(MIN_CLOCK_SIZE, Math.min(MAX_CLOCK_SIZE, value.size)) : defaults.size,
      stackedAnalogue: typeof value.stackedAnalogue === "boolean" ? value.stackedAnalogue : defaults.stackedAnalogue,
      seconds: typeof value.seconds === "boolean" ? value.seconds : defaults.seconds,
      labels: typeof value.labels === "boolean" ? value.labels : defaults.labels,
    };
  } catch { return defaults; }
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function zonedTime(now: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return { hour: get("hour"), minute: get("minute"), second: get("second") };
}
const segments = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];
function Digit({ value }: { value: string }) {
  return <svg viewBox="0 0 40 70" aria-hidden="true" className="segment-digit">
    {Object.entries({ a: "7,3 33,3 29,7 11,7", b: "34,5 34,32 30,29 30,10", c: "34,37 34,64 30,59 30,41", d: "7,67 33,67 29,63 11,63", e: "6,37 10,41 10,59 6,64", f: "6,5 10,10 10,29 6,32", g: "7,35 11,32 29,32 33,35 29,38 11,38" }).map(([id, points]) => <polygon key={id} points={points} className={segments[Number(value)].includes(id) ? "lit" : "unlit"} />)}
  </svg>;
}
const dotDigits = [
  ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
];
function MatrixDigit({ value }: { value: string }) {
  return <svg viewBox="0 0 30 42" aria-hidden="true">{dotDigits[Number(value)].flatMap((row, y) => row.split("").map((dot, x) => <circle key={`${x}-${y}`} cx={3 + x * 6} cy={3 + y * 6} r="1.9" className={dot === "1" ? "lit" : "unlit"} />))}</svg>;
}
const numberWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
function spellNumber(value: number): string {
  if (value < 20) return numberWords[value];
  return ["", "", "twenty", "thirty", "forty", "fifty"][Math.floor(value / 10)] + (value % 10 ? ` ${numberWords[value % 10]}` : "");
}
function DialMarks({ style }: { style: ClockStyle }) {
  if (style === "minimal") return null;
  if (style === "numeral" || style === "roman") {
    const romans = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
    return <>{style === "roman" && <><circle cx="160" cy="160" r="148" className="dial-ring" /><circle cx="160" cy="160" r="112" className="dial-ring" /></>}{Array.from({ length: 12 }, (_, i) => {
      const angle = i * Math.PI / 6;
      return <text key={i} x={160 + Math.sin(angle) * 130} y={160 - Math.cos(angle) * 130} className="dial-number" textAnchor="middle" dominantBaseline="central">{style === "roman" ? romans[i] : i || 12}</text>;
    })}</>;
  }
  if (style === "dots" || style === "orbit") return <>{style === "orbit" && <circle cx="160" cy="160" r="144" className="orbit-ring" />}{Array.from({ length: style === "dots" ? 12 : 4 }, (_, i) => <circle key={i} cx="160" cy="16" r={style === "dots" ? (i % 3 === 0 ? 4 : 2) : 3} transform={`rotate(${i * (style === "dots" ? 30 : 90)} 160 160)`} className="dial-dot" />)}</>;
  return <>
    {style === "sector" && <><circle cx="160" cy="160" r="145" className="dial-ring" /><circle cx="160" cy="160" r="104" className="dial-ring" />{[0, 90, 180, 270].map(angle => <line key={angle} x1="160" y1="15" x2="160" y2="65" transform={`rotate(${angle} 160 160)`} className="sector-divider" />)}</>}
    {Array.from({ length: style === "bauhaus" ? 12 : 60 }, (_, i) => {
      const major = style === "bauhaus" || i % 5 === 0;
      return <line key={i} x1="160" y1="14" x2="160" y2={major ? (style === "railway" ? 39 : 26) : 18} transform={`rotate(${i * (style === "bauhaus" ? 30 : 6)} 160 160)`} className={major ? "tick major" : "tick"} />;
    })}
  </>;
}
export function ClockFace({ now, zone, style, seconds, stacked = false, animate = false }: { now: Date; zone: string; style: ClockStyle; seconds: boolean; stacked?: boolean; animate?: boolean }) {
  const face = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!animate || !face.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Only touch hand transforms each frame; dial marks and React stay at 1 Hz.
    return startClockSweep(face.current, now.getTime());
  }, [animate, now, zone, style, seconds, stacked]);
  const time = zonedTime(now, zone);
  const s = Number(time.second) + now.getMilliseconds() / 1000, m = Number(time.minute) + s / 60, h = Number(time.hour) % 12 + m / 60;
  if (style === "digital") return <div className="digital-face"><span>{time.hour}<span className="digital-colon">:</span>{time.minute}</span>{seconds && <small>{time.second}</small>}</div>;
  if (style === "split") return <div className="split-face"><span>{time.hour}</span><span>{time.minute}</span>{seconds && <small>{time.second}</small>}</div>;
  if (style === "segment") return <div className="segment-face"><div>{time.hour.split("").map((v, i) => <Digit key={i} value={v} />)}<span className="segment-colon">:</span>{time.minute.split("").map((v, i) => <Digit key={i} value={v} />)}</div>{seconds && <small>{time.second}</small>}</div>;
  if (style === "flip") return <div className="flip-face"><div className="flip-cards">{[time.hour, time.minute].map((value, i) => <span className="flip-card" key={i}>{value}</span>)}</div>{seconds && <small>{time.second}</small>}</div>;
  if (style === "matrix") return <div className="matrix-face"><div className="matrix-display">{time.hour.split("").map((value, i) => <MatrixDigit key={`h${i}`} value={value} />)}<svg className="matrix-colon" viewBox="0 0 12 42" aria-hidden="true"><circle cx="6" cy="15" r="2" /><circle cx="6" cy="27" r="2" /></svg>{time.minute.split("").map((value, i) => <MatrixDigit key={`m${i}`} value={value} />)}</div>{seconds && <small>{time.second}</small>}</div>;
  if (style === "outline") return <div className="outline-face"><span>{time.hour}</span><span>{time.minute}</span>{seconds && <small>{time.second}</small>}</div>;
  if (style === "terminal") return <div className="terminal-face"><span className="terminal-heading">LOCAL TIME / 24H</span><div><span className="terminal-prompt">&gt;</span>{time.hour}:{time.minute}{seconds && <small>:{time.second}</small>}<i aria-hidden="true" /></div><span className="terminal-rule" /></div>;
  if (style === "words") return <div className="words-face"><span>{spellNumber(Number(time.hour))}</span><span>{time.minute === "00" ? "o’clock" : `${Number(time.minute) < 10 ? "oh " : ""}${spellNumber(Number(time.minute))}`}</span>{seconds && <small>{time.second} SEC</small>}</div>;
  if (style === "blocks") return <div className="blocks-face">{[[time.hour, "HRS"], [time.minute, "MIN"], ...(seconds ? [[time.second, "SEC"]] : [])].map(([value, label]) => <div key={label}><span>{value}</span><small>{label}</small></div>)}</div>;
  return <svg ref={face} viewBox="0 0 320 320" aria-hidden="true" className={`analog-face face-${style}`}>
    <DialMarks style={style} />
    {stacked ? zones.map(({ zone: handZone, color }, index) => {
      const local = zonedTime(now, handZone);
      const minute = Number(local.minute) + (Number(local.second) + now.getMilliseconds() / 1000) / 60;
      const hour = Number(local.hour) % 12 + minute / 60;
      // Different lengths keep coincident minute hands visible as coloured tips.
      return <g key={handZone} className="zone-hands" data-zone={handZone} style={{ "--hand-color": color } as CSSProperties}>
        <line x1="160" y1="160" x2="160" y2={76 + index * 10} data-angle={hour * 30} data-period="43200" transform={`rotate(${hour * 30} 160 160)`} className="hand hour-hand" />
        <line x1="160" y1="160" x2="160" y2={36 + index * 12} data-angle={minute * 6} data-period="3600" transform={`rotate(${minute * 6} 160 160)`} className="hand minute-hand" />
      </g>;
    }) : <>
      <line x1="160" y1="160" x2="160" y2="83" data-angle={h * 30} data-period="43200" transform={`rotate(${h * 30} 160 160)`} className="hand hour-hand" />
      <line x1="160" y1="160" x2="160" y2="45" data-angle={m * 6} data-period="3600" transform={`rotate(${m * 6} 160 160)`} className="hand minute-hand" />
    </>}
    {seconds && <line x1="160" y1="179" x2="160" y2="34" data-angle={s * 6} data-period="60" transform={`rotate(${s * 6} 160 160)`} className="second-hand" />}
    {seconds && style === "railway" && <circle cx="160" cy="45" r="7" data-angle={s * 6} data-period="60" transform={`rotate(${s * 6} 160 160)`} className="railway-second-dot" />}
    <circle cx="160" cy="160" r="3" className="clock-pin" />
  </svg>;
}
export function WorldClocks({ now, settings, active = true, fit = false }: { now: Date; settings: Settings; active?: boolean; fit?: boolean }) {
  const region = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!fit || !region.current) return;
    const measure = () => {
      const rect = region.current?.getBoundingClientRect();
      if (rect) setAvailable({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(region.current);
    return () => observer.disconnect();
  }, [fit]);
  const analog = analogueStyles.includes(settings.style);
  const shared = analog && settings.stackedAnalogue;
  const stacked = !shared && settings.layout === "stack";
  const count = shared ? 1 : zones.length;
  const gap = 32;
  const fittedSize = fit && available.width && available.height
    ? Math.max(24, Math.min(settings.size, stacked ? available.width : (available.width - gap * (count - 1)) / count,
        stacked ? (available.height - gap * (count - 1)) / count - 40 : available.height - 40))
    : settings.size;
  const regionStyle = { "--clock-size": `${fittedSize}px`, ...(fit ? { gap: `${gap}px` } : {}) } as CSSProperties;
  if (analog && settings.stackedAnalogue) {
    const description = zones.map(({ label, zone }) => {
      const time = zonedTime(now, zone);
      return `${label}, ${time.hour}:${time.minute}:${time.second}`;
    }).join("; ");
    return <section ref={region} className="world-clocks shared-clock" aria-label="World clocks" style={regionStyle}>
      <time className="world-clock" dateTime={now.toISOString()} aria-label={description}>
        <div className="clock-art"><ClockFace now={now} zone={zones[0].zone} style={settings.style} seconds={settings.seconds} stacked animate={active} /></div>
        <div className="clock-legend" aria-label="Hand colours">
          {zones.map(({ label, color }) => <span key={label} className="legend-item" title={label} style={{ "--hand-color": color } as CSSProperties}><i aria-hidden="true" />{settings.labels ? label : <span className="sr-only">{label}</span>}</span>)}
        </div>
      </time>
    </section>;
  }
  return <section ref={region} className={`world-clocks layout-${settings.layout}`} aria-label="World clocks" style={regionStyle}>
    {zones.map(({ label, zone }) => {
      const time = zonedTime(now, zone);
      return <time key={zone} className="world-clock" dateTime={now.toISOString()} aria-label={`${label}, ${time.hour}:${time.minute}:${time.second}`}>
        <div className="clock-art"><ClockFace now={now} zone={zone} style={settings.style} seconds={settings.seconds} animate={active} /></div>
        {settings.labels && <span className="city-label">{label}</span>}
      </time>;
    })}
  </section>;
}
export function ClockSettings({ settings, onChange, theme, onThemeChange, onClose, now }: { settings: Settings; onChange: (settings: Settings) => void; theme: Theme; onThemeChange: (theme: Theme) => void; onClose: () => void; now: Date }) {
  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent layout="viewport" className="settings-dialog">
      <header className="settings-header"><span className="settings-eyebrow">PERSONALIZE / 01</span><DialogTitle className="text-2xl font-normal tracking-tight">Settings</DialogTitle><DialogDescription>Personalize your clocks and desktop.</DialogDescription></header>
      <div className="settings-body">
      <div className="settings-gallery">
      <ThemeSettings theme={theme} onChange={onThemeChange} />
      {([true, false] as const).map(analogue => <fieldset key={String(analogue)} className="style-fieldset"><legend>{analogue ? "Analogue" : "Digital"}<span>{styles.filter(style => analogueStyles.includes(style.id) === analogue).length} styles</span></legend><div className="style-grid">
        {styles.filter(style => analogueStyles.includes(style.id) === analogue).map(style => <Button key={style.id} variant="outline" className={`style-option${settings.style === style.id ? " selected" : ""}`} aria-label={style.label} aria-pressed={settings.style === style.id} onClick={() => update({ style: style.id })}>
          <div className="style-preview"><ClockFace now={now} zone="Asia/Kolkata" style={style.id} seconds={false} /></div><span>{style.label}</span><small>{style.description}</small>
        </Button>)}
      </div></fieldset>)}
      </div>
      <section className="settings-controls" aria-label="Display and desktop settings">
      <h3>Display</h3>
      <div className="setting-row"><span id="layout-label">Separate clock layout</span><div className="segmented" role="group" aria-labelledby="layout-label">{(["row", "stack"] as const).map(layout => <Button key={layout} variant={settings.layout === layout ? "default" : "ghost"} aria-pressed={settings.layout === layout} onClick={() => update({ layout })}>{layout === "row" ? "Side by side" : "Vertical"}</Button>)}</div></div>
      <div className="setting-row size-row">
        <label id="clock-size-label" htmlFor="clock-size">Clock size <output>{settings.size}px</output></label>
        <div className="size-presets" role="group" aria-label="Clock size presets">
          {sizePresets.map(preset => <Button variant="outline" className="size-preset" key={preset.size} aria-pressed={settings.size === preset.size} onClick={() => update({ size: preset.size })}>{preset.label}<small>{preset.size}px</small></Button>)}
        </div>
        <Slider id="clock-size" aria-labelledby="clock-size-label" min={MIN_CLOCK_SIZE} max={MAX_CLOCK_SIZE} step={10} value={[settings.size]} onValueChange={([size]) => update({ size })} />
        <small className="size-hint">120–2400px. Clocks scale down to fit the space above your inbox brief.</small>
      </div>
      {([
        ["stackedAnalogue", "Stacked analogue", "One dial, three coloured sets of hands"],
        ["seconds", "Seconds", ""],
        ["labels", "City labels", ""],
      ] as const).map(([key, label, hint]) => <div key={key} className="setting-row toggle-row"><label htmlFor={`setting-${key}`}>{label}{hint && <small>{hint}</small>}</label><Switch id={`setting-${key}`} checked={settings[key]} onCheckedChange={checked => update({ [key]: checked })} /></div>)}
      <DesktopSettings />
      <LauncherSettings />
      </section>
      </div>
      <footer className="settings-footer"><Button variant="ghost" onClick={() => onChange({ ...defaults })}>Reset clocks</Button><Button onClick={onClose}>Done</Button></footer>
    </DialogContent>
  </Dialog>;
}
