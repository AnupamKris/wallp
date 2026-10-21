import { useLayoutEffect, useState } from "react";
import { CheckIcon } from "@phosphor-icons/react";

export const backgrounds = [
  { id: "charcoal", label: "Charcoal", base: "#111111", paint: "#111111" },
  { id: "midnight", label: "Midnight", base: "#101b30", paint: "#101b30" },
  { id: "forest", label: "Forest", base: "#13251f", paint: "#13251f" },
  { id: "plum", label: "Plum", base: "#291b30", paint: "#291b30" },
  { id: "clay", label: "Clay", base: "#30211e", paint: "#30211e" },
  { id: "slate", label: "Slate", base: "#242b33", paint: "#242b33" },
  { id: "aurora", label: "Aurora", base: "#142527", paint: "radial-gradient(ellipse at 10% 10%, #315e52, transparent 65%), linear-gradient(135deg, #142527, #25223f)" },
  { id: "dusk", label: "Dusk", base: "#29213a", paint: "linear-gradient(135deg, #423657, #29213a 50%, #573c43)" },
  { id: "ocean", label: "Ocean", base: "#12283b", paint: "linear-gradient(145deg, #284d66, #12283b 55%, #1e4443)" },
  { id: "ember", label: "Ember", base: "#30201e", paint: "radial-gradient(ellipse at 90% 90%, #70432e, transparent 70%), linear-gradient(135deg, #231c2c, #30201e)" },
  { id: "moss", label: "Moss", base: "#202b22", paint: "linear-gradient(135deg, #3f5038, #202b22 55%, #383b29)" },
  { id: "twilight", label: "Twilight", base: "#20253f", paint: "radial-gradient(ellipse at 80% 10%, #4d426d, transparent 65%), linear-gradient(145deg, #172d40, #29233d)" },
] as const;
export const foregrounds = [
  { id: "chalk", label: "Chalk", color: "#eeeeee" },
  { id: "ivory", label: "Ivory", color: "#f3dfbb" },
  { id: "sage", label: "Sage", color: "#c1dfc4" },
  { id: "ice", label: "Ice", color: "#b9ddf4" },
  { id: "lavender", label: "Lavender", color: "#d9c7f4" },
  { id: "rose", label: "Rose", color: "#f2c4cb" },
] as const;
export type Theme = { background: typeof backgrounds[number]["id"]; foreground: typeof foregrounds[number]["id"] };
export const defaultTheme: Theme = { background: "charcoal", foreground: "chalk" };

export function loadTheme(): Theme {
  try {
    const saved = JSON.parse(localStorage.getItem("wallp.theme") || "null");
    return {
      background: backgrounds.find(item => item.id === saved?.background)?.id ?? defaultTheme.background,
      foreground: foregrounds.find(item => item.id === saved?.foreground)?.id ?? defaultTheme.foreground,
    };
  } catch { return { ...defaultTheme }; }
}

export function useTheme() {
  const [theme, setTheme] = useState(loadTheme);
  useLayoutEffect(() => {
    const background = backgrounds.find(item => item.id === theme.background)!;
    const foreground = foregrounds.find(item => item.id === theme.foreground)!;
    const root = document.documentElement.style;
    root.setProperty("--theme-base", background.base);
    root.setProperty("--theme-wallpaper", background.paint);
    root.setProperty("--theme-foreground", foreground.color);
    try { localStorage.setItem("wallp.theme", JSON.stringify(theme)); } catch { /* Keep live changes usable without storage. */ }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function ThemeSettings({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const background = backgrounds.find(item => item.id === theme.background)!;
  const foreground = foregrounds.find(item => item.id === theme.foreground)!;
  return <section className="theme-settings" aria-label="Appearance">
    <div className="theme-heading"><h3>Appearance</h3><button type="button" onClick={() => onChange({ ...defaultTheme })}>Reset colours</button></div>
    <div className="theme-preview" style={{ background: background.paint, color: foreground.color }} aria-label={`${background.label} background with ${foreground.label} foreground`}>
      <span className="theme-preview-caption">YOUR DESKTOP, YOUR PALETTE</span>
      <span className="theme-preview-time" aria-hidden="true">09:41</span>
      <span className="theme-preview-caption">{background.label} / {foreground.label}</span>
    </div>
    {([false, true] as const).map(gradient => <fieldset className="theme-fieldset" key={String(gradient)}>
      <legend>{gradient ? "Background gradients" : "Background colours"}</legend>
      <div className="theme-swatches">{backgrounds.filter((_, index) => (index >= 6) === gradient).map(item => <button type="button" key={item.id} className="theme-swatch" aria-label={`${item.label} background`} aria-pressed={theme.background === item.id} onClick={() => onChange({ ...theme, background: item.id })}>
        <span className="theme-swatch-paint" style={{ background: item.paint }}>{theme.background === item.id && <CheckIcon size={16} weight="bold" />}</span><span>{item.label}</span>
      </button>)}</div>
    </fieldset>)}
    <fieldset className="theme-fieldset"><legend>Foreground colours <small>Clocks, text &amp; icons</small></legend>
      <div className="theme-swatches">{foregrounds.map(item => <button type="button" key={item.id} className="theme-swatch" aria-label={`${item.label} foreground`} aria-pressed={theme.foreground === item.id} onClick={() => onChange({ ...theme, foreground: item.id })}>
        <span className="theme-swatch-paint foreground-swatch" style={{ background: item.color }}>{theme.foreground === item.id && <CheckIcon size={16} weight="bold" />}</span><span>{item.label}</span>
      </button>)}</div>
    </fieldset>
    <p className="theme-hint">Changes apply instantly and save automatically.</p>
  </section>;
}
