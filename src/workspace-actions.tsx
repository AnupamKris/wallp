import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { mutateItems, type Item } from "./productivity-store";
import { noteKey } from "./workspace-store";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export function linkedItem(kind: "todos" | "reminders", title: string, source?: Item["source"], due?: string) {
  const item: Item = { id: crypto.randomUUID(), title: title.trim().slice(0, 300), done: false, source, ...(due ? { due } : {}) };
  if (!item.title) throw new Error("Enter a title.");
  mutateItems(items => ({ ...items, [kind]: [...items[kind], item] }));
}
export async function openItemSource(source: NonNullable<Item["source"]>) {
  if (source.url) {
    const url = new URL(source.url); if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported source link.");
    if (isTauri()) await openUrl(url.href); else window.open(url.href, "_blank", "noopener,noreferrer");
  } else if (source.noteId && source.spaceId) {
    const key = noteKey(source.spaceId), state = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!state?.tabs?.some((note: { id: string }) => note.id === source.noteId)) throw new Error("The source note is closed. Reopen it in Notes first.");
    localStorage.setItem(key, JSON.stringify({ ...state, activeId: source.noteId }));
    window.dispatchEvent(new Event("wallp:notes-changed"));
    window.dispatchEvent(new CustomEvent("wallp:open-note", { detail: source.spaceId }));
  }
}
export function captureNote(text: string, spaceId: string) {
  const key = noteKey(spaceId), raw = localStorage.getItem(key);
  const note = { id: crypto.randomUUID(), title: text.trim().split("\n")[0].slice(0, 80) || "Untitled", text };
  const state = raw ? JSON.parse(raw) : { tabs: [], closed: [], activeId: "" };
  if (!Array.isArray(state.tabs) || !Array.isArray(state.closed)) throw new Error("Saved notes could not be read.");
  if (!raw && spaceId === "default" && localStorage.getItem("wallp.notes")) state.tabs.push({ id: crypto.randomUUID(), title: "Notes", text: localStorage.getItem("wallp.notes") });
  localStorage.setItem(key, JSON.stringify({ ...state, tabs: [...state.tabs, note], activeId: note.id }));
  window.dispatchEvent(new Event("wallp:notes-changed"));
}
export function ReminderAction({ text, source, onClose }: { text: string; source?: Item["source"]; onClose: () => void }) {
  const [title, setTitle] = useState(text.slice(0, 300));
  const [due, setDue] = useState("");
  const [error, setError] = useState("");
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogTitle>Create reminder</DialogTitle><DialogDescription>Choose a time for this reminder. Its source stays attached.</DialogDescription><form className="flex flex-col gap-3" onSubmit={event => {
    event.preventDefault();
    try { const date = new Date(due); if (!Number.isFinite(date.getTime())) throw new Error("Choose a valid date and time."); linkedItem("reminders", title, source, date.toISOString()); onClose(); } catch (err) { setError(String(err)); }
  }}><label>Title<Input required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} /></label><label>When<Input required type="datetime-local" value={due} onChange={event => setDue(event.target.value)} /></label>{error && <p role="alert" className="text-destructive">{error}</p>}<Button type="submit" disabled={!title.trim() || !due}>Create reminder</Button></form></DialogContent></Dialog>;
}
