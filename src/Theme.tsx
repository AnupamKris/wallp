import { useEffect, useLayoutEffect, useState } from "react";
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
/* Maia is a light, editorial style: ivory paper and dark ink, with one jewel-tone accent for buttons, selection and a soft wallpaper wash. */
export const accents = [
  { id: "iris", label: "Iris", color: "#5a4fcf", glow: "#e7dcc8", ink: "#ffffff", paper: "#f7f6f2", text: "#1d1b26" },
  { id: "sapphire", label: "Sapphire", color: "#1f5bb8", glow: "#dfe6e4", ink: "#ffffff", paper: "#f5f6f4", text: "#141c2b" },
  { id: "jade", label: "Jade", color: "#0f7a63", glow: "#e6e0c9", ink: "#ffffff", paper: "#f5f6f1", text: "#13221d" },
  { id: "ochre", label: "Ochre", color: "#a8661a", glow: "#eedcc0", ink: "#ffffff", paper: "#f8f5ef", text: "#251c12" },
  { id: "garnet", label: "Garnet", color: "#9f2441", glow: "#efdcd2", ink: "#ffffff", paper: "#f8f5f2", text: "#26161b" },
  { id: "ink", label: "Ink", color: "#22252e", glow: "#e5e1d8", ink: "#ffffff", paper: "#f6f5f1", text: "#18191d" },
] as const;
const maiaWallpaper = (accent: typeof accents[number]) => `radial-gradient(ellipse 70% 60% at 0% 0%, ${accent.color}1f, transparent 70%), radial-gradient(ellipse 60% 60% at 100% 100%, ${accent.glow}, transparent 70%), ${accent.paper}`;
export const styles = [
  { id: "lyra", label: "Lyra", description: "Sharp, square corners" },
  { id: "maia", label: "Maia", description: "Light, rounded & refined" },
] as const;
export type Theme = { background: typeof backgrounds[number]["id"]; foreground: typeof foregrounds[number]["id"]; style: typeof styles[number]["id"]; accent: typeof accents[number]["id"] };
export const defaultTheme: Theme = { background: "charcoal", foreground: "chalk", style: "lyra", accent: "iris" };

export function loadTheme(): Theme {
  try {
    const saved = JSON.parse(localStorage.getItem("wallp.theme") || "null");
    return {
      background: backgrounds.find(item => item.id === saved?.background)?.id ?? defaultTheme.background,
      foreground: foregrounds.find(item => item.id === saved?.foreground)?.id ?? defaultTheme.foreground,
      style: styles.find(item => item.id === saved?.style)?.id ?? defaultTheme.style,
      accent: accents.find(item => item.id === saved?.accent)?.id ?? defaultTheme.accent,
    };
  } catch { return { ...defaultTheme }; }
}

export function useTheme() {
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "wallp.theme" || event.key === null) setTheme(loadTheme());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useLayoutEffect(() => {
    const background = backgrounds.find(item => item.id === theme.background) ?? backgrounds[0];
    const foreground = foregrounds.find(item => item.id === theme.foreground) ?? foregrounds[0];
    const root = document.documentElement.style;
    const accent = accents.find(item => item.id === theme.accent) ?? accents[0];
    const maia = theme.style === "maia";
    root.setProperty("--theme-base", maia ? accent.paper : background.base);
    root.setProperty("--theme-wallpaper", maia ? maiaWallpaper(accent) : background.paint);
    root.setProperty("--theme-foreground", maia ? accent.text : foreground.color);
    root.setProperty("--maia-accent", accent.color);
    root.setProperty("--maia-glow", accent.glow);
    root.setProperty("--maia-ink", accent.ink);
    document.documentElement.dataset.style = theme.style;
    document.documentElement.classList.toggle("dark", !maia);
    try {
      const saved = JSON.stringify(theme);
      if (localStorage.getItem("wallp.theme") !== saved) localStorage.setItem("wallp.theme", saved);
    } catch { /* Keep live changes usable without storage. */ }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function ThemeSettings({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const background = backgrounds.find(item => item.id === theme.background) ?? backgrounds[0];
  const foreground = foregrounds.find(item => item.id === theme.foreground) ?? foregrounds[0];
  const accent = accents.find(item => item.id === theme.accent) ?? accents[0];
  const maia = theme.style === "maia";
  return <section className="theme-settings" aria-label="Appearance">
    <div className="theme-heading"><h3>Appearance</h3><button type="button" onClick={() => onChange({ ...defaultTheme, style: theme.style })}>Reset colours</button></div>
    <div className="theme-preview" style={{ background: maia ? maiaWallpaper(accent) : background.paint, color: maia ? accent.text : foreground.color }} aria-label={maia ? `Light ${accent.label} accent` : `${background.label} background with ${foreground.label} foreground`}>
      <span className="theme-preview-caption">YOUR DESKTOP, YOUR PALETTE</span>
      <span className="theme-preview-time" aria-hidden="true">09:41</span>
      <span className="theme-preview-caption">{maia ? `Light / ${accent.label}` : `${background.label} / ${foreground.label}`}</span>
    </div>
    <fieldset className="theme-fieldset"><legend>Style <small>Corners &amp; controls</small></legend>
      <div className="theme-styles">{styles.map(item => <button type="button" key={item.id} className="theme-swatch theme-style" data-style-option={item.id} aria-pressed={theme.style === item.id} onClick={() => onChange({ ...theme, style: item.id })}>
        <span className="theme-style-sample" aria-hidden="true"><i /><b /></span><span>{item.label}</span><small>{item.description}</small>
      </button>)}</div>
    </fieldset>
    {maia && <fieldset className="theme-fieldset"><legend>Accent <small>Buttons, selection &amp; wallpaper wash</small></legend>
      <div className="theme-swatches accent-swatches">{accents.map(item => <button type="button" key={item.id} className="theme-swatch" aria-label={`${item.label} accent`} aria-pressed={theme.accent === item.id} onClick={() => onChange({ ...theme, accent: item.id })}>
        <span className="theme-swatch-paint" style={{ background: item.color, color: item.ink }}>{theme.accent === item.id && <CheckIcon size={16} weight="bold" />}</span><span>{item.label}</span>
      </button>)}</div>
    </fieldset>}
    {!maia && ([false, true] as const).map(gradient => <fieldset className="theme-fieldset" key={String(gradient)}>
      <legend>{gradient ? "Background gradients" : "Background colours"}</legend>
      <div className="theme-swatches">{backgrounds.filter((_, index) => (index >= 6) === gradient).map(item => <button type="button" key={item.id} className="theme-swatch" aria-label={`${item.label} background`} aria-pressed={theme.background === item.id} onClick={() => onChange({ ...theme, background: item.id })}>
        <span className="theme-swatch-paint" style={{ background: item.paint }}>{theme.background === item.id && <CheckIcon size={16} weight="bold" />}</span><span>{item.label}</span>
      </button>)}</div>
    </fieldset>)}
    {!maia && <fieldset className="theme-fieldset"><legend>Foreground colours <small>Clocks, text &amp; icons</small></legend>
      <div className="theme-swatches">{foregrounds.map(item => <button type="button" key={item.id} className="theme-swatch" aria-label={`${item.label} foreground`} aria-pressed={theme.foreground === item.id} onClick={() => onChange({ ...theme, foreground: item.id })}>
        <span className="theme-swatch-paint foreground-swatch" style={{ background: item.color }}>{theme.foreground === item.id && <CheckIcon size={16} weight="bold" />}</span><span>{item.label}</span>
      </button>)}</div>
    </fieldset>}
    <p className="theme-hint">Changes apply instantly and save automatically.</p>
  </section>;
}
