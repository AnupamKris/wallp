import { useEffect, useState } from "react";
import { defaultScrollingLayout, parseScrollingLayout, type ScrollingLayout } from "./workspace-layout.ts";

export const workspaceKey = "wallp.spaces.v1";
export const workspaceChanged = "wallp:spaces-changed";
export type Resource = { id: string; title: string; kind: "file" | "link" | "text" | "image"; value: string; tags: string; clipId?: number; preview?: string | null };
export type Space = { id: string; name: string; layout: ScrollingLayout; resources: Resource[] };
export type Spaces = { activeId: string; spaces: Space[] };
export function loadSpaces(): Spaces {
  const raw = localStorage.getItem(workspaceKey);
  if (raw) {
    const value = JSON.parse(raw) as Spaces;
    if (!value || !Array.isArray(value.spaces) || !value.spaces.length || !value.spaces.some(s => s.id === value.activeId)
      || new Set(value.spaces.map(s => s.id)).size !== value.spaces.length
      || !value.spaces.every(s => typeof s.id === "string" && typeof s.name === "string" && Array.isArray(s.resources)
        && s.resources.every(r => r && typeof r.id === "string" && typeof r.title === "string" && typeof r.value === "string" && typeof r.tags === "string" && ["file", "link", "text", "image"].includes(r.kind)))) throw new Error("Saved workspaces could not be read.");
    return { ...value, spaces: value.spaces.map(s => ({ ...s, layout: parseScrollingLayout(JSON.stringify(s.layout)) })) };
  }
  return { activeId: "default", spaces: [{ id: "default", name: "Personal", resources: [], layout: parseScrollingLayout(localStorage.getItem("wallp.scrolling-layout.v1"), localStorage.getItem("wallp.grid-layout")) }] };
}
export function mutateSpaces(change: (state: Spaces) => Spaces) {
  const next = change(loadSpaces());
  localStorage.setItem(workspaceKey, JSON.stringify(next));
  window.dispatchEvent(new Event(workspaceChanged));
  return next;
}
export function addSpace(name: string) {
  const id = crypto.randomUUID();
  if (!name.trim()) throw new Error("Enter a workspace name.");
  mutateSpaces(state => ({ activeId: id, spaces: [...state.spaces, { id, name: name.trim().slice(0, 80), resources: [], layout: { open: [...defaultScrollingLayout.open], stacks: defaultScrollingLayout.stacks.map(stack => [...stack]), widths: { ...defaultScrollingLayout.widths } } }] }));
  return id;
}
export function pinResource(resource: Omit<Resource, "id" | "tags"> & { id?: string; tags?: string }, spaceId = loadSpaces().activeId) {
  mutateSpaces(state => ({ ...state, spaces: state.spaces.map(space => space.id !== spaceId ? space : { ...space, resources: [...space.resources.filter(r => !(r.kind === resource.kind && (resource.clipId !== undefined ? r.clipId === resource.clipId : r.value === resource.value))), { ...resource, id: resource.id ?? crypto.randomUUID(), tags: resource.tags ?? "" }] }) }));
}
export function useSpaces() {
  const [error, setError] = useState("");
  const [state, setState] = useState<Spaces>(() => { try { return loadSpaces(); } catch { return { activeId: "default", spaces: [{ id: "default", name: "Personal", resources: [], layout: defaultScrollingLayout }] }; } });
  useEffect(() => {
    const refresh = () => { try { setState(loadSpaces()); setError(""); } catch (err) { setError(String(err)); } };
    const storage = (event: StorageEvent) => { if (!event.key || event.key === workspaceKey) refresh(); };
    refresh(); window.addEventListener(workspaceChanged, refresh); window.addEventListener("storage", storage);
    return () => { window.removeEventListener(workspaceChanged, refresh); window.removeEventListener("storage", storage); };
  }, []);
  function update(change: (state: Spaces) => Spaces) { try { mutateSpaces(change); setError(""); return true; } catch (err) { setError(String(err)); return false; } }
  return { state, space: state.spaces.find(space => space.id === state.activeId)!, error, update };
}
export const noteKey = (spaceId: string) => spaceId === "default" ? "wallp.notes.tabs" : `wallp.notes.tabs.${spaceId}`;
