import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { InstalledApp } from "./launcher-search";

export function useHomeShortcuts(onError: (error: string) => void) {
  const [pins, setPins] = useState<InstalledApp[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: UnlistenFn | undefined;
    let revision = 0;
    async function refresh() {
      const request = ++revision;
      try {
        const entries = await invoke<InstalledApp[]>("home_shortcuts");
        if (!disposed && request === revision) setPins(entries);
      } catch (error) { if (!disposed) onError(String(error)); }
    }
    void listen("home://shortcuts", () => void refresh()).then(unlisten => {
      if (disposed) unlisten();
      else { off = unlisten; void refresh(); }
    }).catch(error => { if (!disposed) onError(String(error)); });
    return () => { disposed = true; off?.(); };
  }, [onError]);

  async function setPinned(id: string, pinned: boolean) {
    if (saving || !isTauri()) return;
    setSaving(true);
    try { await invoke("set_home_shortcut", { id, pinned }); }
    catch (error) { onError(String(error)); }
    finally { setSaving(false); }
  }
  return { pins, saving, setPinned };
}
