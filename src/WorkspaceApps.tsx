import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { pinResource, useSpaces, type Resource } from "./workspace-store";
import { changeItem } from "./productivity-store";
import type { useProductivity } from "./productivity";
import { AiMarkdown } from "./AiMarkdown";
import { runAiTools, type AiProgress, type AiResponse } from "./ai-tools";

export type Clip = { id: number; kind: "text" | "image"; text: string; preview?: string | null; width: number; height: number };
type ClipPage = { entries: Clip[]; total: number; hasMore: boolean };
export async function pinClip(clip: Clip, spaceId: string) {
  const id = crypto.randomUUID();
  await invoke("pin_clipboard", { id: clip.id, key: id });
  try { pinResource({ id, clipId: clip.id, title: clip.kind === "image" ? `Image ${clip.width} × ${clip.height}` : clip.text.slice(0, 80), kind: clip.kind, value: clip.text, preview: clip.preview }, spaceId); }
  catch (err) { await invoke("remove_clipboard_pin", { key: id }).catch(() => {}); throw err; }
}
export async function openResource(resource: Resource) {
  if (resource.kind === "link") {
    const url = new URL(resource.value); if (!["https:", "http:"].includes(url.protocol)) throw new Error("Use an http or https link.");
    if (isTauri()) await openUrl(url.href); else window.open(url.href, "_blank", "noopener,noreferrer");
  } else if (resource.kind === "file") {
    if (!isTauri()) throw new Error("Open wallp on your desktop to open files.");
    await invoke("open_search_file", { path: resource.value });
  } else if (resource.clipId !== undefined) await invoke("copy_clipboard_pin", { key: resource.id });
  else await navigator.clipboard.writeText(resource.value);
}
export function FilesLinks({ spaceId }: { spaceId: string }) {
  const { state, update, error } = useSpaces();
  const resources = state.spaces.find(s => s.id === spaceId)?.resources ?? [];
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [status, setStatus] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const filtered = resources.filter(r => `${r.title} ${r.value} ${r.tags}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="flex flex-col gap-3 p-4 text-xs">
    <p className="text-muted-foreground">Files, links, and pinned clipboard items for this workspace. Pin file or clipboard results from the command menu with Ctrl+Enter.</p>
    <Input aria-label="Search files and links" placeholder="Search pins and tags…" value={query} onChange={e => setQuery(e.target.value)} />
    <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); try {
      const target = value.trim(); const kind = /^https?:\/\//i.test(target) ? "link" : "file";
      if (kind === "file" && !/^(?:[a-z]:[\\/]|\\\\)/i.test(target)) throw new Error("Enter an absolute Windows path or an http(s) link.");
      pinResource({ kind, value: target, title: title.trim() || target.split(/[\\/]/).filter(Boolean).pop() || target, tags }, spaceId);
      setValue(""); setTitle(""); setTags(""); setActionError(""); setStatus("Pinned.");
    } catch (err) { setActionError(String(err)); } }}>
      <Input aria-label="File path or link" required placeholder="C:\\Projects or https://…" value={value} onChange={e => setValue(e.target.value)} />
      <div className="flex gap-2"><Input aria-label="Pin title" placeholder="Title (optional)" value={title} onChange={e => setTitle(e.target.value)} /><Input aria-label="Pin tags" placeholder="Tags (optional)" value={tags} onChange={e => setTags(e.target.value)} /></div>
      <Button variant="outline" type="submit" disabled={!value.trim()}>Pin file or link</Button>
    </form>
    {filtered.map(resource => <Card key={resource.id}><CardContent className="flex flex-col gap-2 p-3">
      <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="break-words font-medium">{resource.title}</p><p className="text-muted-foreground">{resource.kind === "text" || resource.kind === "image" ? "Clipboard" : resource.kind}</p></div><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setBusy(true); setActionError(""); void openResource(resource).then(() => setStatus(resource.kind === "text" || resource.kind === "image" ? "Copied to clipboard." : "Opened.")).catch(err => setActionError(String(err))).finally(() => setBusy(false)); }}>{resource.kind === "text" || resource.kind === "image" ? "Copy" : "Open"}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => {
        if (update(current => ({ ...current, spaces: current.spaces.map(s => s.id !== spaceId ? s : { ...s, resources: s.resources.filter(r => r.id !== resource.id) }) }))) {
          if (resource.clipId !== undefined) void invoke("remove_clipboard_pin", { key: resource.id }).catch(err => setActionError(String(err)));
        }
      }}>Unpin</Button></div>
      {resource.preview && <img className="max-h-36 max-w-full self-start object-contain" src={resource.preview} alt={resource.title} />}
      <p className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">{resource.value}</p>
      <Input aria-label={`Tags for ${resource.title}`} placeholder="Add tags…" defaultValue={resource.tags} onBlur={e => { const tags = e.target.value; if (tags !== resource.tags) update(current => ({ ...current, spaces: current.spaces.map(s => s.id !== spaceId ? s : { ...s, resources: s.resources.map(r => r.id === resource.id ? { ...r, tags } : r) }) })); }} />
    </CardContent></Card>)}
    {!filtered.length && <p className="py-6 text-center text-muted-foreground">{query ? "No matching pins." : "Pin your first file, link, or clipboard item."}</p>}
    {(error || actionError) && <p role="alert" className="break-words text-destructive">{error || actionError}</p>}{status && <p role="status" className="text-muted-foreground">{status}</p>}
  </div>;
}

export function ClipboardPanel({ spaceId }: { spaceId: string }) {
  const { state } = useSpaces();
  const resources = state.spaces.find(s => s.id === spaceId)?.resources ?? [];
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<ClipPage>({ entries: [], total: 0, hasMore: false });
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false; const off = listen("launcher://clipboard", () => { if (!disposed) setRevision(n => n + 1); });
    return () => { disposed = true; void off.then(fn => fn()); };
  }, []);
  useEffect(() => {
    const id = ++request.current;
    if (!isTauri()) { setError("Clipboard history needs the desktop app."); return; }
    setLoading(true); setError("");
    const timer = setTimeout(() => { void invoke<ClipPage>("clipboard_entries", { query, offset: 0 }).then(page => { if (id === request.current) setPage(page); }).catch(err => { if (id === request.current) setError(String(err)); }).finally(() => { if (id === request.current) setLoading(false); }); }, 120);
    return () => { clearTimeout(timer); ++request.current; };
  }, [query, revision]);
  async function more() { const id = request.current; setLoading(true); try { const next = await invoke<ClipPage>("clipboard_entries", { query, offset: page.entries.length }); if (id === request.current) setPage(current => ({ ...next, entries: [...current.entries, ...next.entries] })); } catch (err) { if (id === request.current) setError(String(err)); } finally { if (id === request.current) setLoading(false); } }
  return <div className="flex flex-col gap-3 p-4 text-xs"><Input aria-label="Search workspace clipboard" placeholder="Search clipboard history…" value={query} onChange={e => setQuery(e.target.value)} />
    <p className="text-muted-foreground">{page.total} saved items. Pins appear in Files &amp; Links and survive clearing history.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {page.entries.map(clip => <Card key={clip.id}><CardContent className="flex flex-col gap-2 p-3">{clip.preview && <img className="max-h-28 max-w-full self-start" src={clip.preview} alt={`Clipboard image ${clip.width} by ${clip.height}`} />}<p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{clip.text}</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => { setBusy(true); setError(""); void invoke("copy_clipboard_entry", { id: clip.id }).catch(err => setError(String(err))).finally(() => setBusy(false)); }}>Copy</Button><Button variant="ghost" size="sm" disabled={busy || resources.some(r => r.clipId === clip.id)} onClick={() => { setBusy(true); setError(""); void pinClip(clip, spaceId).catch(err => setError(String(err))).finally(() => setBusy(false)); }}>{resources.some(r => r.clipId === clip.id) ? "Pinned in Files & Links" : "Pin to Files & Links"}</Button></div></CardContent></Card>)}
    {!loading && !page.entries.length && <p className="py-6 text-center text-muted-foreground">{query ? "No matching items." : "Copy text or an image to start your history."}</p>}
    {loading && <p role="status">Loading…</p>}{page.hasMore && <Button variant="outline" disabled={loading} onClick={() => void more()}>Load older items</Button>}
  </div>;
}

function dayKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
export function Agenda({ data }: { data: ReturnType<typeof useProductivity> }) {
  const [date, setDate] = useState(() => dayKey(new Date()));
  const [error, setError] = useState("");
  const all = [...data.items.todos.map(item => ({ ...item, kind: "todos" as const })), ...data.items.reminders.map(item => ({ ...item, kind: "reminders" as const }))].filter(item => !item.done && item.due).sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
  const today = dayKey(new Date());
  const day = all.filter(item => dayKey(new Date(item.due!)) === date);
  const overdue = all.filter(item => Date.parse(item.due!) < Date.now() && dayKey(new Date(item.due!)) < date);
  return <div className="flex flex-col gap-4 p-4 text-xs"><div className="flex flex-wrap items-center gap-2"><Input className="w-auto" aria-label="Agenda date" type="date" value={date} required onChange={e => { if (e.target.value) setDate(e.target.value); }} /><Button variant="outline" size="sm" onClick={() => setDate(today)}>Today</Button></div>
    <p className="text-muted-foreground">Local reminders and task deadlines, in your timezone.</p>
    {[["Overdue", overdue], [new Date(date + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }), day], ["Upcoming", all.filter(item => dayKey(new Date(item.due!)) > date)]].map(([label, items]) => <section key={label as string} className="flex flex-col gap-2"><h3 className="font-medium">{label as string}</h3>{(items as typeof all).map(item => <Card key={item.id}><CardContent className="flex items-start gap-3 p-3"><Button variant="outline" size="sm" onClick={() => { try { changeItem(item.kind, item.id, { done: true }); setError(""); } catch (err) { setError(String(err)); } }}>Done</Button><div className="min-w-0"><p className="break-words">{item.title}</p><p className="text-muted-foreground">{new Date(item.due!).toLocaleString()} · {item.kind === "todos" ? "Todo" : "Reminder"}</p></div></CardContent></Card>)}{!(items as typeof all).length && <p className="text-muted-foreground">Nothing scheduled.</p>}</section>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}

type Message = { role: "user" | "assistant"; content: string };
type Chat = { id: string; title: string; updatedAt: number };
export function WorkspaceAI() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [id, setId] = useState<string>(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unsaved, setUnsaved] = useState(false);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [progress, setProgress] = useState<AiProgress>({ phase: "thinking", activities: [] });
  const serial = useRef(0), pending = useRef(false), bottom = useRef<HTMLDivElement>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => () => { ++serial.current; }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [messages, busy]);
  async function save(chatId: string, next: Message[]) {
    const saving = saveQueue.current.catch(() => {}).then(() => invoke("ai_save_chat", { id: chatId, messages: next }));
    saveQueue.current = saving;
    try { await saving; setUnsaved(false); } catch { setUnsaved(true); }
  }
  async function send() {
    if (pending.current || !prompt.trim()) return;
    if (!isTauri()) { setError("Open wallp on your desktop to ask Agnes."); return; }
    const text = prompt.trim(), history = messages, request = ++serial.current;
    pending.current = true; setBusy(true); setPrompt(""); setError(""); setChats(null);
    const user: Message = { role: "user", content: text }; setMessages([...history, user]);
    try {
      const answer = await runAiTools(exchanges => invoke<AiResponse>("launcher_ai", { prompt: text, history, exchanges, localTime: `${new Date().toString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}); UTC: ${new Date().toISOString()}` }), () => serial.current === request,
        receipts => { const next: Message[] = [...history, user, { role: "assistant", content: receipts.join("\n\n") }]; setMessages(next); void save(id, next); }, undefined, setProgress);
      if (serial.current === request && answer !== null) { const next: Message[] = [...history, user, { role: "assistant", content: answer }]; setMessages(next); await save(id, next); }
    } catch (err) { if (serial.current === request) { setError(String(err)); setPrompt(text); } }
    finally { if (serial.current === request) { pending.current = false; setBusy(false); } }
  }
  return <div className="flex h-full min-h-0 flex-col gap-3 p-4 text-xs"><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => { setMessages([]); setId(crypto.randomUUID()); setChats(null); setError(""); setUnsaved(false); }}>New chat</Button><Button variant="ghost" size="sm" disabled={busy || !isTauri()} onClick={() => { void invoke<Chat[]>("ai_list_chats").then(setChats).catch(err => setError(String(err))); }}>History</Button>{chats && <Button variant="ghost" size="sm" onClick={() => setChats(null)}>Back to chat</Button>}</div>
    <div className="min-h-0 flex-1 overflow-auto" aria-label="Workspace AI conversation" tabIndex={0}>{chats ? chats.map(chat => <Button key={chat.id} variant="ghost" className="mb-2 h-auto w-full justify-start whitespace-normal text-left" disabled={busy} onClick={() => { pending.current = true; setBusy(true); void invoke<Message[]>("ai_load_chat", { id: chat.id }).then(messages => { setMessages(messages); setId(chat.id); setChats(null); setUnsaved(false); }).catch(err => setError(String(err))).finally(() => { pending.current = false; setBusy(false); }); }}>{chat.title}</Button>) : <>{!messages.length && <p className="text-muted-foreground">Ask Agnes about your tasks or connected Gmail. History is shared with the command menu.</p>}{messages.map((message, i) => <article key={i} className="mb-4 break-words border-b border-border pb-3"><p className="mb-2 font-medium">{message.role === "user" ? "You" : "Agnes"}</p><AiMarkdown onError={setError}>{message.content}</AiMarkdown></article>)}<div ref={bottom} /></>}</div>
    {busy && <div role="status" className="text-muted-foreground">{progress.activities.filter(a => a.status === "running").map(a => a.label).join(" · ") || "Thinking…"}<Button variant="ghost" size="sm" onClick={() => { ++serial.current; pending.current = false; setBusy(false); }}>Stop</Button></div>}
    {error && <p role="alert" className="break-words text-destructive">{error}</p>}{unsaved && <div role="status" className="text-destructive">Chat could not be saved.<Button variant="outline" size="sm" onClick={() => void save(id, messages)}>Retry save</Button></div>}
    <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); void send(); }}><Textarea aria-label="Workspace AI prompt" placeholder="Ask Agnes… Ctrl+Enter to send" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); void send(); } }} /><Button type="submit" disabled={busy || !prompt.trim()}>Send</Button></form>
  </div>;
}
