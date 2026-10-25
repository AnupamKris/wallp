import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { addSpace, noteKey, pinResource, useSpaces } from "./workspace-store";
import { captureNote, linkedItem } from "./workspace-actions";
import { loadItems, productivityChanged } from "./productivity-store";
import type { WorkspaceId } from "./workspace-layout";
import { openResource } from "./WorkspaceApps";

export function QuickCapture({ onClose }: { onClose: () => void }) {
  const { state } = useSpaces();
  const [spaceId, setSpaceId] = useState(state.activeId);
  const [kind, setKind] = useState("note");
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState("");
  return <form className="flex min-h-0 flex-col gap-3 overflow-auto p-4 text-xs" onSubmit={e => { e.preventDefault(); try {
    if (!text.trim()) return;
    if (kind === "note") captureNote(text, spaceId);
    else if (kind === "link") { const url = new URL(text.trim()); if (!["https:", "http:"].includes(url.protocol)) throw new Error("Use an http or https link."); pinResource({ kind: "link", title: url.hostname, value: url.href }, spaceId); }
    else { const time = kind === "reminder" ? new Date(due).toISOString() : undefined; linkedItem(kind === "todo" ? "todos" : "reminders", text, undefined, time); }
    setText(""); onClose();
  } catch (err) { setError(String(err)); } }}>
    <div className="flex flex-wrap gap-2" aria-label="Capture type">{["note", "todo", "reminder", "link"].map(type => <Button key={type} type="button" size="sm" variant={kind === type ? "secondary" : "outline"} aria-pressed={kind === type} onClick={() => setKind(type)}>{type[0].toUpperCase() + type.slice(1)}</Button>)}</div>
    {(kind === "note" || kind === "link") && <label>Workspace<select className="workspace-select mt-1" aria-label="Capture workspace" value={spaceId} onChange={e => setSpaceId(e.target.value)}>{state.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>}
    <Textarea autoFocus aria-label="Capture text" required placeholder={kind === "link" ? "https://…" : "Save a thought or something to do…"} maxLength={kind === "todo" || kind === "reminder" ? 300 : undefined} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
    {kind === "reminder" && <label>When<Input aria-label="Capture reminder time" type="datetime-local" required value={due} onChange={e => setDue(e.target.value)} /></label>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!text.trim() || (kind === "reminder" && !due)}>Save</Button></div>
  </form>;
}
export function ManageSpaces({ onClose }: { onClose: () => void }) {
  const { state, space, update, error } = useSpaces();
  const [name, setName] = useState("");
  const [rename, setRename] = useState(space.name);
  const [localError, setLocalError] = useState("");
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogTitle>Workspaces</DialogTitle><DialogDescription>Each space keeps its layout, notes, and pinned resources. Todos, reminders, mail, and clipboard history are shared.</DialogDescription>
    <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); if (rename.trim() && update(current => ({ ...current, spaces: current.spaces.map(s => s.id === space.id ? { ...s, name: rename.trim() } : s) }))) onClose(); }}><label>Rename {space.name}<Input aria-label="Workspace name" required maxLength={80} value={rename} onChange={e => setRename(e.target.value)} /></label><Button type="submit" variant="outline" disabled={!rename.trim()}>Rename</Button></form>
    <form className="flex flex-col gap-2 border-t border-border pt-3" onSubmit={e => { e.preventDefault(); try { addSpace(name); onClose(); } catch (err) { setLocalError(String(err)); } }}><label>New workspace<Input aria-label="New workspace name" required maxLength={80} placeholder="Work, Personal, Coding…" value={name} onChange={e => setName(e.target.value)} /></label><Button type="submit" disabled={!name.trim()}>Create workspace</Button></form>
    <p className="text-muted-foreground">{state.spaces.length} saved workspace{state.spaces.length === 1 ? "" : "s"}</p>{(error || localError) && <p role="alert" className="text-destructive">{error || localError}</p>}
  </DialogContent></Dialog>;
}

type Result = { id: string; title: string; detail: string; app?: WorkspaceId; spaceId?: string; noteId?: string; url?: string; resourceId?: string };
type CachedMail = { id: string; threadId: string; subject: string; snippet: string; account: string };
export function WorkspaceSearch({ onClose, onOpen }: { onClose: () => void; onOpen: (app: WorkspaceId, spaceId?: string) => void }) {
  const { state } = useSpaces();
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [mail, setMail] = useState<CachedMail[]>([]);
  const [error, setError] = useState("");
  const [mailError, setMailError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const refresh = () => setRevision(n => n + 1);
    window.addEventListener("storage", refresh); window.addEventListener(productivityChanged, refresh); window.addEventListener("wallp:notes-changed", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(productivityChanged, refresh); window.removeEventListener("wallp:notes-changed", refresh); };
  }, []);
  useEffect(() => {
    let disposed = false; setMail([]); setMailError("");
    if (!query.trim() || !isTauri()) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => { void invoke<CachedMail[]>("email_search_cached", { query: query.trim() }).then(result => { if (!disposed) setMail(result); }).catch(err => { if (!disposed) setMailError(String(err)); }).finally(() => { if (!disposed) setLoading(false); }); }, 180);
    return () => { disposed = true; clearTimeout(timer); };
  }, [query]);
  void revision;
  const matches = (text: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const results: Result[] = [];
  const warnings: string[] = [];
  if (query.trim()) {
    try { const items = loadItems(); for (const kind of ["todos", "reminders"] as const) for (const item of items[kind]) if (matches(item.title)) results.push({ id: item.id, title: item.title, detail: `${kind === "todos" ? "Todo" : "Reminder"}${item.done ? " · Completed" : ""}`, app: kind }); } catch { warnings.push("Saved tasks could not be searched."); }
    for (const space of state.spaces) {
      try { const notes = JSON.parse(localStorage.getItem(noteKey(space.id)) ?? "null"); for (const note of notes?.tabs ?? []) if (matches(`${note.title} ${note.text}`)) results.push({ id: note.id, title: note.title, detail: `Note · ${space.name}`, app: "notes", spaceId: space.id, noteId: note.id }); } catch { warnings.push(`Notes in ${space.name} could not be searched.`); }
      for (const resource of space.resources) if (matches(`${resource.title} ${resource.value} ${resource.tags}`)) results.push({ id: resource.id, title: resource.title, detail: `Pinned ${resource.kind} · ${space.name}`, spaceId: space.id, resourceId: resource.id });
    }
    for (const message of mail) results.push({ id: `mail-${message.id}`, title: message.subject || "(No subject)", detail: `Cached email · ${message.snippet}`, url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(message.account)}#all/${encodeURIComponent(message.threadId)}` });
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="sm:max-w-xl"><DialogTitle>Search workspace</DialogTitle><DialogDescription>Search tasks, notes, pinned resources, and locally cached email.</DialogDescription><Input autoFocus aria-label="Search workspace" placeholder="Search across your workspaces…" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="flex max-h-[55vh] flex-col gap-1 overflow-auto">{results.slice(0, 100).map(result => <Button key={result.id} variant="ghost" className="h-auto flex-col items-start gap-1 whitespace-normal py-3 text-left" onClick={() => { void (async () => {
      try {
        if (result.url) { if (isTauri()) await openUrl(result.url); else window.open(result.url, "_blank", "noopener,noreferrer"); }
        else if (result.resourceId) { const resource = state.spaces.find(s => s.id === result.spaceId)?.resources.find(r => r.id === result.resourceId); if (resource) await openResource(resource); }
        else if (result.app) {
          if (result.noteId) { const key = noteKey(result.spaceId!), notes = JSON.parse(localStorage.getItem(key)!); localStorage.setItem(key, JSON.stringify({ ...notes, activeId: result.noteId })); window.dispatchEvent(new Event("wallp:notes-changed")); }
          onOpen(result.app, result.spaceId);
        }
        onClose();
      } catch (err) { setError(String(err)); }
    })(); }}><span className="break-words">{result.title}</span><span className="line-clamp-2 break-all text-muted-foreground">{result.detail}</span></Button>)}{!query.trim() ? <p className="py-5 text-muted-foreground">Type to search.</p> : !results.length && !loading ? <p className="py-5 text-muted-foreground">No results found.</p> : null}</div>
    {loading && <p role="status">Searching cached mail…</p>}{results.length > 100 && <p className="text-muted-foreground">Showing the first 100 matches. Refine your search.</p>}{mailError && <p className="text-muted-foreground">Cached email: {mailError}</p>}{warnings.map(warning => <p key={warning} className="text-destructive">{warning}</p>)}{error && <p role="alert" className="text-destructive">{error}</p>}
  </DialogContent></Dialog>;
}
