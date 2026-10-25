export type InstalledApp = { id: string; name: string; icon?: string | null };
export const powerCommands = [
  { action: "power_off", title: "Power off", detail: "Shut down the PC", aliases: ["power off", "shutdown", "shut down"] },
  { action: "restart", title: "Restart", detail: "Restart the PC", aliases: ["restart"] },
  { action: "sleep", title: "Sleep", detail: "Put the PC to sleep", aliases: ["sleep"] },
] as const;
export type PowerAction = typeof powerCommands[number]["action"];
// The tray menu's actions, reachable when wallp has hidden the Windows taskbar.
export const wallpCommands = [
  { action: "restore_taskbar", title: "Restore Windows taskbar", detail: "Bring back the Windows taskbar and tray", aliases: ["restore windows taskbar", "restore taskbar", "show taskbar", "windows taskbar", "taskbar", "tray"] },
  { action: "reload", title: "Reload wallp", detail: "Reload the desktop", aliases: ["reload wallp", "reload"] },
  { action: "quit", title: "Quit wallp", detail: "Close wallp and restore the Windows desktop", aliases: ["quit wallp", "quit", "exit wallp", "close wallp"] },
] as const;
export type WallpAction = typeof wallpCommands[number]["action"];
function matchCommands<T extends { aliases: readonly string[] }>(commands: readonly T[], query: string) {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  return phrase ? commands.filter(command => command.aliases.some(alias => alias.startsWith(phrase))) : [];
}
export function searchPowerCommands(query: string) {
  return matchCommands(powerCommands, query);
}
export function searchWallpCommands(query: string) {
  return matchCommands(wallpCommands, query);
}
export const engines = [
  { key: "f", name: "Files" },
  { key: "ai", name: "Ask AI" },
  { key: "g", name: "Google" },
  { key: "y", name: "YouTube" },
  { key: "d", name: "DuckDuckGo" },
  { key: "w", name: "Wikipedia" },
  { key: "gh", name: "GitHub" },
  { key: "r", name: "Reddit" },
] as const;
export function parseBang(query: string) {
  const match = query.trimStart().match(/^!?([a-z]+)(?:\s+(.*))?$/is);
  if (!match) return null;
  const engine = engines.find(engine => engine.key === match[1].toLowerCase());
  if (match[2] === undefined && engine?.key !== "ai") return null;
  return engine ? { ...engine, query: (match[2] ?? "").trim() } : null;
}
export function searchApps(apps: InstalledApp[], query: string): InstalledApp[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return apps;
  const ranked = apps.flatMap(app => {
    const name = app.name.toLocaleLowerCase();
    if (!words.every(word => name.includes(word))) return [];
    const phrase = words.join(" ");
    return [{ app, rank: name === phrase ? 0 : name.startsWith(phrase) ? 1 : 2 }];
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.app.name.localeCompare(b.app.name)).map(item => item.app);
}
export function isClipboardCommand(query: string) {
  return /^(paste|clipboard|clipboard history)$/i.test(query.trim());
}
