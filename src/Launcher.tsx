import { Fragment, useEffect, useRef, useState } from "react";
import { AlertDialog } from "radix-ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ArrowLeftIcon, ArrowRightIcon, ClipboardTextIcon, MagnifyingGlassIcon, ArrowClockwiseIcon, TrashIcon, ImageIcon, CommandIcon, SparkleIcon, PushPinIcon, PowerIcon, MoonIcon, FileIcon, FolderIcon, DesktopIcon, SignOutIcon } from "@phosphor-icons/react";
import { useHomeShortcuts } from "./home-shortcuts";
import { engines, isClipboardCommand, parseBang, searchApps, searchPowerCommands, searchWallpCommands, type InstalledApp, type PowerAction, type WallpAction } from "./launcher-search";
import "./Launcher.css";
import { AiMarkdown } from "./AiMarkdown";
import { runAiTools, type AiResponse, type AiProgress, type ToolActivity } from "./ai-tools";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "./Theme";
import { pinResource, useSpaces } from "./workspace-store";
import { pinClip } from "./WorkspaceApps";
import { QuickCapture } from "./WorkspaceDialogs";

type Clip = { id: number; kind: "text" | "image"; text: string; preview?: string | null; width: number; height: number };
type ClipPage = { entries: Clip[]; total: number; hasMore: boolean };
type AiMessage = { role: "user" | "assistant"; content: string };
type ChatSummary = { id: string; title: string; updatedAt: number };
type Preferences = { ctrlSpace: boolean; clipboard: boolean; shadcnCommand: boolean; shortcutError?: string | null };
type FileMatch = { name: string; path: string; isDir: boolean };
const initialPreferences: Preferences = { ctrlSpace: true, clipboard: true, shadcnCommand: false };
type Result = { id: string; title: string; detail: string; kind: "app" | "clipboard" | "clip" | "search" | "ai" | "power" | "wallp" | "file"; app?: InstalledApp; clip?: Clip; engine?: string; query?: string; action?: PowerAction | WallpAction; path?: string };

function AiActivity({ activities, running }: { activities: ToolActivity[]; running: boolean }) {
  if (!activities.length) return null;
  const failed = activities.filter(activity => activity.status === "error").length;
  const stopped = activities.some(activity => activity.status === "stopped");
  return <details className="command-ai-activity" open={running}>
    <summary><span>Activity</span><small>{activities.length} step{activities.length === 1 ? "" : "s"} · {running ? "Working" : stopped ? "Stopped" : failed ? `${failed} failed` : "Complete"}</small></summary>
    <ol aria-label="AI activity">
      {activities.map(activity => <li key={activity.id} className={`command-ai-step ${activity.status}`}>
        <span className="command-ai-step-icon" aria-hidden="true">{activity.status === "running" ? <ArrowClockwiseIcon className="command-spinning" /> : activity.status === "complete" ? "✓" : activity.status === "error" ? "!" : "–"}</span>
        <div><strong>{activity.label}</strong><small>{activity.detail}</small></div>
        <span className="command-ai-step-state">{activity.status === "running" ? "Running" : activity.status === "complete" ? "Done" : activity.status === "error" ? "Failed" : "Stopped"}</span>
      </li>)}
    </ol>
  </details>;
}

function ClearClipboardHistory({ disabled, compact = false }: { disabled: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function clear() {
    if (pending.current) return;
    pending.current = true; setClearing(true); setError("");
    try { await invoke("clear_clipboard_history"); setOpen(false); }
    catch (err) { setError(String(err)); }
    finally { pending.current = false; setClearing(false); }
  }
  return <AlertDialog.Root open={open} onOpenChange={value => {
    if (pending.current) return;
    setOpen(value); setError("");
  }}>
    <AlertDialog.Trigger asChild>{compact ? <Button variant="ghost" size="sm" disabled={disabled}><TrashIcon />Clear history</Button> : <Button variant="outline" size="sm" disabled={disabled}>Clear clipboard history</Button>}</AlertDialog.Trigger>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="clipboard-clear-overlay" />
      <AlertDialog.Content className="clipboard-clear-dialog" onKeyDown={event => event.stopPropagation()} onEscapeKeyDown={event => { if (pending.current) event.preventDefault(); }}>
        <AlertDialog.Title>Clear clipboard history?</AlertDialog.Title>
        <AlertDialog.Description>All saved text and images will be permanently deleted. This can't be undone.</AlertDialog.Description>
        {error && <p className="clipboard-clear-error" role="alert">{error}</p>}
        <div className="clipboard-clear-actions">
          <AlertDialog.Cancel asChild><Button variant="ghost" size="sm" disabled={clearing}>Cancel</Button></AlertDialog.Cancel>
          <Button variant="destructive" size="sm" className="clipboard-clear-confirm" disabled={clearing} onClick={() => void clear()}>{clearing ? "Clearing…" : "Clear history"}</Button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

export function Launcher() {
  useTheme();
  const workspacePins = useSpaces();
  const [savingResource, setSavingResource] = useState(false);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipTotal, setClipTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [clipLoading, setClipLoading] = useState(false);
  const [clipRevision, setClipRevision] = useState(0);
  const clipRequest = useRef(0);
  const [query, setQuery] = useState("");
  const [fileState, setFileState] = useState<{ query: string; entries: FileMatch[]; loading: boolean; error: string }>({ query: "", entries: [], loading: false, error: "" });
  const [mode, setMode] = useState("apps");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const { pins, saving: savingPin, setPinned } = useHomeShortcuts(setError);
  const pinnedIds = new Set(pins.map(app => app.id));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState(initialPreferences);
  const [opening, setOpening] = useState(0);
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [aiChatId, setAiChatId] = useState<string | null>(null);
  const [aiChats, setAiChats] = useState<ChatSummary[]>([]);
  const [aiHistoryOpen, setAiHistoryOpen] = useState(false);
  const [aiHistoryLoading, setAiHistoryLoading] = useState(false);
  const [aiHistoryError, setAiHistoryError] = useState("");
  const [aiHistoryQuery, setAiHistoryQuery] = useState("");
  const [aiHistorySelected, setAiHistorySelected] = useState(0);
  const [aiExpanded, setAiExpanded] = useState(false);
  const resizePending = useRef(false);
  const historySearch = useRef<HTMLInputElement>(null);
  const historyList = useRef<HTMLDivElement>(null);
  const [aiUnsaved, setAiUnsaved] = useState(false);
  const historyRequest = useRef(0);
  const [aiPromptPending, setAiPromptPending] = useState("");
  const [aiError, setAiError] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiProgress, setAiProgress] = useState<AiProgress>({ phase: "thinking", activities: [] });
  const [aiActivityIndex, setAiActivityIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const aiRequest = useRef(0);
  const aiPending = useRef(false);
  const aiSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const focusAnswer = useRef(false);
  // Native open listeners are registered once; read the current view through a ref.
  const aiView = mode === "ai" || (mode === "apps" && parseBang(query)?.key === "ai");
  const view = useRef({ ai: aiView, query, mode });
  view.current = { ai: aiView, query, mode };
  function open(mode: string, reopening = false) {
    const resumeAi = reopening && mode === "apps" && view.current.ai;
    setMode(resumeAi ? "ai" : mode === "capture" ? "capture" : mode === "clipboard" ? "clipboard" : "apps");
    if (!resumeAi) setQuery("");
    else if (view.current.mode !== "ai") setQuery(parseBang(view.current.query)?.query ?? "");
    setSelected(0); setError(""); setOpening(value => value + 1);
  }
  function resetAi() {
    cancelAi(); ++historyRequest.current; setAiMessages([]); setAiChatId(null); setAiUnsaved(false); setAiHistoryOpen(false); setAiHistoryError(""); setAiHistoryLoading(false);
    setAiProgress({ phase: "thinking", activities: [] });
  }
  function cancelAi() {
    ++aiRequest.current; aiPending.current = false;
    setAiPromptPending(""); setAiError(""); setAiLoading(false); setCopied(false);
    setAiProgress(progress => ({ ...progress, activities: progress.activities.map(activity => activity.status === "running" ? { ...activity, status: "stopped", detail: "Stopped waiting for this step" } : activity) }));
  }
  function changeQuery(value: string) {
    setQuery(value);
  }
  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight });
  }, [aiMessages, aiPromptPending]);
  useEffect(() => () => { ++aiRequest.current; }, []);
  useEffect(() => {
    document.documentElement.classList.add("launcher-view");
    let disposed = false;
    const subscriptions: UnlistenFn[] = [];
    async function subscribe<T,>(event: string, handler: (payload: T) => void) {
      const off = await listen<T>(event, event => { if (!disposed) handler(event.payload); });
      if (disposed) off(); else subscriptions.push(off);
    }
    if (isTauri()) void (async () => {
      await Promise.all([
        subscribe<string>("launcher://open", mode => open(mode, true)),
        subscribe<InstalledApp[]>("launcher://apps", apps => { setApps(apps); setLoading(false); }),
        subscribe<void>("launcher://clipboard", () => setClipRevision(value => value + 1)),
        subscribe<Preferences>("launcher://preferences", setPreferences),
        subscribe<string>("launcher://error", error => { setError(error); setLoading(false); }),
      ]);
      const [apps, prefs] = await Promise.all([invoke<InstalledApp[]>("launcher_apps"), invoke<Preferences>("launcher_preferences")]);
      if (disposed) return;
      setApps(apps); setPreferences(prefs); setLoading(false);
      const mode = await invoke<string>("launcher_ready");
      if (!disposed) open(mode, true);
    })().catch(err => { if (!disposed) { setError(String(err)); setLoading(false); } });
    else { setLoading(false); }
    return () => { disposed = true; subscriptions.forEach(off => off()); document.documentElement.classList.remove("launcher-view"); };
  }, []);
  useEffect(() => { if (!aiHistoryOpen) (focusAnswer.current ? conversation.current : input.current)?.focus(); }, [opening, mode, preferences.shadcnCommand, aiHistoryOpen]);
  useEffect(() => { setSelected(0); }, [query, mode]);

  const clipQuery = mode === "clipboard" ? query : "";
  useEffect(() => {
    if (!isTauri()) return;
    const request = ++clipRequest.current;
    let disposed = false;
    setClipLoading(true); setHasMore(false); setClips([]);
    const timer = window.setTimeout(() => {
      void invoke<ClipPage>("clipboard_entries", { query: clipQuery, offset: 0 })
        .then(page => { if (!disposed && request === clipRequest.current) { setClips(page.entries); setClipTotal(page.total); setHasMore(page.hasMore); } })
        .catch(err => { if (!disposed) setError(String(err)); })
        .finally(() => { if (!disposed && request === clipRequest.current) setClipLoading(false); });
    }, 120);
    return () => { disposed = true; ++clipRequest.current; window.clearTimeout(timer); };
  }, [clipQuery, mode, clipRevision, opening]);
  async function loadMore() {
    if (clipLoading || !hasMore || !isTauri()) return;
    const request = clipRequest.current;
    setClipLoading(true);
    try {
      const page = await invoke<ClipPage>("clipboard_entries", { query, offset: clips.length });
      if (request === clipRequest.current) { setClips(items => [...items, ...page.entries]); setClipTotal(page.total); setHasMore(page.hasMore); }
    } catch (err) { if (request === clipRequest.current) setError(String(err)); }
    finally { if (request === clipRequest.current) setClipLoading(false); }
  }
  const bang = mode === "apps" ? parseBang(query) : null;
  const fileMode = bang?.key === "f";
  const fileQuery = fileMode ? bang.query : "";
  const currentFiles = fileState.query === fileQuery ? fileState.entries : [];
  const fileLoading = fileMode && !!fileQuery && (fileState.query !== fileQuery || fileState.loading);
  const fileError = fileMode && fileState.query === fileQuery ? fileState.error : "";
  useEffect(() => {
    let disposed = false;
    setFileState({ query: fileQuery, entries: [], loading: !!fileQuery, error: "" });
    if (!fileMode || !fileQuery) return;
    const timer = window.setTimeout(() => {
      if (!isTauri()) {
        setFileState({ query: fileQuery, entries: [], loading: false, error: "Open wallp on your desktop to search files." });
        return;
      }
      void invoke<FileMatch[]>("search_files", { query: fileQuery })
        .then(entries => { if (!disposed) setFileState({ query: fileQuery, entries, loading: false, error: "" }); })
        .catch(err => { if (!disposed) setFileState({ query: fileQuery, entries: [], loading: false, error: String(err) }); });
    }, 180);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [fileMode, fileQuery, opening]);
  const aiMode = mode === "ai" || bang?.key === "ai";
  const aiPrompt = mode === "ai" ? query.trim() : bang?.query ?? "";
  const runningStep = aiProgress.activities.find(activity => activity.status === "running");
  const aiStatus = runningStep ? `${runningStep.label}…` : aiProgress.phase === "thinking" ? "Thinking…" : "Reviewing results…";
  const filteredChats = aiChats.filter(chat => chat.title.toLocaleLowerCase().includes(aiHistoryQuery.toLocaleLowerCase().trim()));
  const historyIndex = Math.min(aiHistorySelected, Math.max(0, filteredChats.length - 1));
  useEffect(() => {
    if (aiHistoryOpen && !aiHistoryLoading) historySearch.current?.focus();
  }, [aiHistoryOpen, aiHistoryLoading, opening]);
  useEffect(() => {
    historyList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [historyIndex, aiHistoryQuery]);
  const results: Result[] = mode === "clipboard"
    ? clips.map(clip => ({ id: `clip-${clip.id}`, title: clip.text.slice(0, 400), detail: clip.kind === "image" ? `${clip.width} × ${clip.height} pixels` : `${clip.text.length.toLocaleString()} characters`, kind: "clip", clip }))
    : aiMode
      ? [{ id: "ai", title: aiPrompt ? `${aiMessages.length ? "Reply" : "Ask AI"}: ${aiPrompt}` : aiMessages.length ? "Type a reply to continue the conversation" : "Type a question after ai", detail: aiLoading ? aiStatus : "agnes-3.0-flash · Enter to send", kind: "ai", query: aiPrompt }]
    : fileMode
      ? currentFiles.map(file => ({ id: `file-${file.path}`, title: file.name, detail: `${file.isDir ? "Folder" : "File"} · ${file.path}`, kind: "file", path: file.path }))
    : bang
      ? [{ id: "bang", title: bang.query ? `Search ${bang.name} for “${bang.query}”` : `Type a ${bang.name} search`, detail: `${bang.key} · ${bang.name}`, kind: "search", engine: bang.key, query: bang.query }]
      : [
        ...searchPowerCommands(query).map(command => ({ id: `power-${command.action}`, title: command.title, detail: command.detail, kind: "power" as const, action: command.action })),
        ...searchWallpCommands(query).map(command => ({ id: `wallp-${command.action}`, title: command.title, detail: command.detail, kind: "wallp" as const, action: command.action })),
        ...(isClipboardCommand(query) || !query.trim() ? [{ id: "clipboard", title: "Paste from clipboard history", detail: `${clipTotal.toLocaleString()} copied items · Type paste`, kind: "clipboard" as const }] : []),
        ...searchApps(apps, query).map(app => ({ id: app.id, title: app.name, detail: "Application", kind: "app" as const, app })),
        ...(query.trim() && !isClipboardCommand(query) ? [{ id: "google", title: `Search Google for “${query.trim()}”`, detail: "Web search", kind: "search" as const, engine: "g", query: query.trim() }] : []),
      ];
  const activeIndex = Math.min(selected, Math.max(results.length - 1, 0));
  const active = results[activeIndex];
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [activeIndex, query, mode, apps, clips]);
  async function close() { if (isTauri()) await invoke("close_launcher"); }
  async function askAi(prompt: string) {
    if (!prompt.trim() || aiPending.current) return;
    if (!isTauri()) { setAiError("Open wallp on your desktop to ask AI."); return; }
    const request = ++aiRequest.current;
    const chatId = aiChatId ?? crypto.randomUUID();
    setAiProgress({ phase: "thinking", activities: [] }); setAiActivityIndex(aiMessages.length + 1);
    setMode("ai"); setQuery("");
    setAiChatId(chatId); setAiHistoryOpen(false);
    aiPending.current = true; setAiLoading(true); setAiPromptPending(prompt); setAiError(""); setCopied(false);
    try {
      const history = aiMessages;
      const answer = await runAiTools(
        exchanges => invoke<AiResponse>("launcher_ai", {
          prompt, history, exchanges,
          localTime: `${new Date().toString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}); UTC: ${new Date().toISOString()}`,
        }),
        () => request === aiRequest.current,
        receipts => {
          const messages: AiMessage[] = [...history, { role: "user", content: prompt }, { role: "assistant", content: receipts.join("\n\n") }];
          setAiMessages(messages);
          setAiPromptPending("");
          void saveChat(chatId, messages, request);
        },
        undefined,
        progress => { if (request === aiRequest.current) setAiProgress(progress); },
      );
      if (request === aiRequest.current && answer !== null) {
        const messages: AiMessage[] = [...aiMessages, { role: "user", content: prompt }, { role: "assistant", content: answer }];
        setAiMessages(messages);
        setAiPromptPending("");
        // Finishing in the background must not interrupt another launcher view/draft.
        await saveChat(chatId, messages, request);
      }
    } catch (err) {
      if (request === aiRequest.current) setAiError(String(err));
    } finally {
      if (request === aiRequest.current) { aiPending.current = false; setAiLoading(false); setAiPromptPending(""); }
    }
  }
  async function saveChat(id: string, messages: AiMessage[], request = aiRequest.current) {
    const saving = aiSaveQueue.current.catch(() => {}).then(() => invoke("ai_save_chat", { id, messages }));
    aiSaveQueue.current = saving;
    try {
      await saving;
      if (request === aiRequest.current) { setAiUnsaved(false); setAiHistoryError(""); }
    } catch {
      if (request === aiRequest.current) { setAiUnsaved(true); setAiHistoryError("Could not save this chat. Keep it open and retry saving."); }
    }
  }
  async function showHistory() {
    if (aiPending.current || aiHistoryLoading) return;
    setAiHistoryOpen(true); setAiHistoryLoading(true); setAiHistoryError(""); setAiHistoryQuery(""); setAiHistorySelected(0);
    const request = ++historyRequest.current;
    try {
      if (!isTauri()) throw new Error("Open wallp on your desktop to view saved chats.");
      const chats = await invoke<ChatSummary[]>("ai_list_chats");
      if (request === historyRequest.current) setAiChats(chats);
    } catch (err) { if (request === historyRequest.current) setAiHistoryError(String(err)); }
    finally { if (request === historyRequest.current) setAiHistoryLoading(false); }
  }
  async function loadChat(id: string) {
    if (aiPending.current || aiHistoryLoading) return;
    const request = ++historyRequest.current;
    setAiHistoryLoading(true); setAiHistoryError("");
    try {
      const messages = await invoke<AiMessage[]>("ai_load_chat", { id });
      if (request !== historyRequest.current) return;
      focusAnswer.current = false;
      setAiProgress({ phase: "thinking", activities: [] });
      cancelAi(); setAiMessages(messages); setAiChatId(id); setAiUnsaved(false); setAiHistoryOpen(false); setMode("ai"); setQuery(""); input.current?.focus();
    } catch (err) { if (request === historyRequest.current) setAiHistoryError(String(err)); }
    finally { if (request === historyRequest.current) setAiHistoryLoading(false); }
  }
  async function deleteChat(id: string) {
    const request = ++historyRequest.current;
    setAiHistoryLoading(true); setAiHistoryError("");
    try {
      await invoke("ai_delete_chat", { id });
      if (request !== historyRequest.current) return;
      setAiChats(chats => chats.filter(chat => chat.id !== id));
      if (id === aiChatId) { cancelAi(); setAiMessages([]); setAiChatId(null); setAiUnsaved(false); }
    } catch (err) { if (request === historyRequest.current) setAiHistoryError(String(err)); }
    finally { if (request === historyRequest.current) setAiHistoryLoading(false); }
  }
  async function copyAnswer() {
    const request = aiRequest.current;
    try {
      await navigator.clipboard.writeText(aiMessages[aiMessages.length - 1]?.content ?? "");
      if (request === aiRequest.current) setCopied(true);
    } catch {
      if (request === aiRequest.current) setAiError("Could not copy. Select the answer text to copy it manually.");
    }
  }
  function replyToChat(read = false) {
    ++historyRequest.current; setAiHistoryOpen(false); setAiHistoryLoading(false);
    focusAnswer.current = read;
    if (mode !== "ai") setQuery(aiPrompt);
    setMode("ai"); (read ? conversation.current : input.current)?.focus();
  }
  function newChat() {
    if (aiPending.current || aiHistoryLoading) return;
    focusAnswer.current = false;
    resetAi(); setMode("ai"); setQuery(""); input.current?.focus();
  }
  async function toggleExpanded() {
    if (resizePending.current) return;
    if (!isTauri()) { setAiError("Open wallp on your desktop to resize the chat window."); return; }
    resizePending.current = true;
    try { setAiExpanded(await invoke<boolean>("launcher_set_expanded", { expanded: !aiExpanded })); }
    catch (err) { setAiError(String(err)); }
    finally { resizePending.current = false; }
  }
  function aiKeyboard(event: React.KeyboardEvent<HTMLElement>) {
    if (!aiMode || event.nativeEvent.isComposing) return;
    const key = event.key.toLowerCase();
    const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey;
    let action: (() => void) | undefined;
    if (shortcut && !event.shiftKey) {
      if (key === "h") action = () => { if (aiHistoryOpen) replyToChat(); else void showHistory(); };
      if (key === "n") action = newChat;
      if (key === "l") action = replyToChat;
      if (key === "j") action = () => replyToChat(true);
    }
    if (shortcut && event.shiftKey) {
      if (key === "f") action = () => { void toggleExpanded(); };
      if (key === "c") action = () => { if (aiMessages[aiMessages.length - 1]?.role === "assistant") void copyAnswer(); };
      if (key === "x") action = () => { if (aiPending.current) cancelAi(); };
    }
    if (aiHistoryOpen && !shortcut && !event.altKey) {
      if (key === "escape") action = replyToChat;
      if (["arrowdown", "arrowup", "home", "end"].includes(key)
          && (!["home", "end"].includes(key) || event.target !== historySearch.current)) {
        action = () => {
          if (aiHistoryLoading || !filteredChats.length) return;
          setAiHistorySelected(key === "home" ? 0 : key === "end" ? filteredChats.length - 1
            : (historyIndex + (key === "arrowdown" ? 1 : -1) + filteredChats.length) % filteredChats.length);
        };
      }
      const target = event.target as HTMLElement;
      if (key === "enter" && (target === input.current || target === historySearch.current || target.dataset?.aiChat !== undefined)) {
        action = () => { if (!aiHistoryLoading && filteredChats[historyIndex]) void loadChat(filteredChats[historyIndex].id); };
      }
    }
    if (action) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat || !shortcut) action();
    }
  }
  async function run(result?: Result) {
    if (!result || busy || aiHistoryLoading) return;
    if (result.kind === "ai") { if (aiHistoryOpen) { ++historyRequest.current; setAiHistoryOpen(false); } await askAi(result.query ?? ""); return; }
    if (result.kind === "clipboard") { open("clipboard"); return; }
    if (!isTauri()) { setError("Open wallp on your desktop to run commands."); return; }
    setBusy(true); setError("");
    try {
      if (result.kind === "power") await invoke("launcher_power", { action: result.action });
      if (result.kind === "wallp") await invoke("launcher_wallp", { action: result.action });
      if (result.kind === "app") await invoke("launch_app", { id: result.app!.id });
      if (result.kind === "search") await invoke("launcher_search", { engine: result.engine, query: result.query });
      if (result.kind === "file") await invoke("open_search_file", { path: result.path });
      if (result.kind === "clip") await invoke("paste_clipboard", { id: result.clip!.id });
    } catch (err) {
      if (result.kind === "clip") await invoke("open_launcher", { mode: "clipboard" }).catch(() => {});
      if (result.kind === "power" && result.action === "sleep") await invoke("open_launcher").catch(() => {});
      setError(String(err));
    } finally { setBusy(false); }
  }
  function pinnedResource(result: Result) {
    return workspacePins.space.resources.find(resource => result.clip ? resource.clipId === result.clip.id : result.kind === "file" && resource.kind === "file" && resource.value === result.path);
  }
  async function toggleResourcePin(result: Result) {
    if (savingResource) return;
    setSavingResource(true); setError("");
    const spaceId = workspacePins.space.id;
    try {
      const existing = pinnedResource(result);
      if (existing) {
        const saved = workspacePins.update(current => ({ ...current, spaces: current.spaces.map(space => space.id !== spaceId ? space : { ...space, resources: space.resources.filter(resource => resource.id !== existing.id) }) }));
        if (saved && existing.clipId !== undefined) await invoke("remove_clipboard_pin", { key: existing.id });
      } else if (result.clip) await pinClip(result.clip, spaceId);
      else if (result.path) pinResource({ kind: "file", title: result.title, value: result.path }, spaceId);
    } catch (err) { setError(String(err)); }
    finally { setSavingResource(false); }
  }
  async function refresh() {
    if (!isTauri() || busy) return;
    setBusy(true); setError("");
    try { setApps(await invoke<InstalledApp[]>("refresh_launcher_apps")); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  const shadcn = preferences.shadcnCommand;
  const MenuRoot = shadcn ? Command : "div";
  const MenuInput = shadcn ? CommandInput : Input;
  const MenuList = shadcn ? CommandList : "div";
  const MenuItem = shadcn ? CommandItem : "div";
  const activity = <AiActivity activities={aiProgress.activities} running={aiLoading} />;
  if (mode === "capture") return <main className="flex h-full flex-col overflow-hidden border border-border bg-card text-card-foreground" aria-label="Quick capture" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setMode("apps"); void close(); } }}><header className="flex items-center justify-between border-b border-border p-4"><h1 className="text-sm font-medium">Quick capture</h1><span className="text-xs text-muted-foreground">Ctrl+Enter saves ? Esc closes</span></header><QuickCapture key={opening} onClose={() => { setMode("apps"); void close(); }} /></main>;
  return <main className={`command-menu${shadcn ? " command-shadcn" : ""}${aiMode ? " command-ai-mode" : ""}`} aria-label="wallp command menu" onKeyDownCapture={aiKeyboard} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); if (mode === "clipboard") open("apps"); else void close(); }
  }}>
    <MenuRoot className="command-body" onKeyDownCapture={event => {
      if (shadcn && event.target !== input.current && ["Enter", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) event.stopPropagation();
    }} {...(shadcn ? { label: mode === "clipboard" ? "Search clipboard history" : mode === "ai" ? "Reply to AI" : "Search apps and commands", shouldFilter: false, loop: true, value: active?.id ?? "", onValueChange: (id: string) => { const index = results.findIndex(result => result.id === id); if (index >= 0) setSelected(index); } } : {})}>
    <header className="command-search">
      {mode === "clipboard" || mode === "ai" ? <Button variant="ghost" size="icon-sm" className="command-icon-button" aria-label="Back to apps" onClick={() => open("apps")}><ArrowLeftIcon /></Button> : !shadcn && <MagnifyingGlassIcon size={23} />}
      <MenuInput ref={input} className={!shadcn ? "border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent" : undefined} aria-label={mode === "clipboard" ? "Search clipboard history" : mode === "ai" ? "Reply to AI" : "Search apps and commands"} {...(shadcn ? { onValueChange: changeQuery } : { role: "combobox", "aria-expanded": true, "aria-autocomplete": "list" as const, "aria-controls": "command-results", "aria-activedescendant": active ? `command-result-${activeIndex}` : undefined, onChange: (event: React.ChangeEvent<HTMLInputElement>) => changeQuery(event.target.value) })} autoComplete="off" spellCheck={false} value={query} placeholder={mode === "ai" ? "Reply to Agnes..." : mode === "clipboard" ? "Search saved text or images…" : "Search apps, f files, paste, or ai anything…"} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (shadcn) {
          if (event.key === "Enter" && event.ctrlKey && (active?.app || active?.path || active?.clip)) { event.preventDefault(); event.stopPropagation(); if (active.app) void setPinned(active.app.id, !pinnedIds.has(active.app.id)); else void toggleResourcePin(active); }
          if (event.key === "ArrowDown" && mode === "clipboard" && activeIndex === results.length - 1 && hasMore) { event.preventDefault(); event.stopPropagation(); void loadMore(); }
          if (event.key === "Backspace" && !query && mode === "clipboard") open("apps");
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (event.key === "ArrowDown" && mode === "clipboard" && activeIndex === results.length - 1 && hasMore) { void loadMore(); return; }
          setSelected((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % Math.max(results.length, 1));
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.ctrlKey && active?.app) void setPinned(active.app.id, !pinnedIds.has(active.app.id));
          else if (event.ctrlKey && active && (active.path || active.clip)) void toggleResourcePin(active);
          else void run(active);
        }
        if (event.key === "Backspace" && !query && mode === "clipboard") open("apps");
      }} />
      <kbd>esc</kbd>
    </header>
    <div className="command-section"><span>{mode === "clipboard" ? "Clipboard history" : aiMode ? "Ask AI · agnes-3.0-flash" : fileMode ? "Global files · Sigma index · Up to 50 results" : bang ? "Search shortcut" : "Applications & commands"}</span><div>
      {aiMode ? <><Button variant="ghost" size="sm" title="Ctrl+H" aria-keyshortcuts="Control+h" disabled={aiLoading || aiHistoryLoading} onClick={() => { if (aiHistoryOpen) replyToChat(); else void showHistory(); }}>{aiHistoryOpen ? "Back to chat" : "History"}</Button><Button variant="ghost" size="sm" title="Ctrl+N" aria-keyshortcuts="Control+n" disabled={aiLoading || aiHistoryLoading} onClick={newChat}>New chat</Button><Button variant="ghost" size="sm" title="Ctrl+Shift+F" aria-keyshortcuts="Control+Shift+f" aria-pressed={aiExpanded} onClick={() => void toggleExpanded()}>{aiExpanded ? "Compact" : "Expand"}</Button></> : mode === "clipboard" ? <ClearClipboardHistory compact disabled={!clipTotal || busy || !isTauri()} /> : fileMode ? null : <Button variant="ghost" size="sm" disabled={busy || !isTauri()} onClick={() => void refresh()}><ArrowClockwiseIcon className={busy ? "command-spinning" : ""} />Refresh apps</Button>}
    </div></div>
    {mode === "clipboard" && !preferences.clipboard && <p className="command-notice">Clipboard capture is paused. Enable it in Settings to collect new items.</p>}
    {(mode === "clipboard" || fileMode) && <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs"><span className="text-muted-foreground">Pin to Files &amp; Links in</span><select className="workspace-select" aria-label="Pin destination workspace" value={workspacePins.state.activeId} onChange={event => { const id = event.target.value; workspacePins.update(current => ({ ...current, activeId: id })); }}>{workspacePins.state.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select><span className="text-muted-foreground">Ctrl+Enter</span></div>}
    {workspacePins.error && <p className="command-error" role="alert">{workspacePins.error}</p>}
    {(error || fileError) && <p className="command-error" role="alert">{error || fileError}</p>}
    <MenuList ref={list} {...(!shadcn ? { id: "command-results", role: "listbox" } : {})} className="command-results" aria-label={mode === "clipboard" ? "Copied text and images" : fileMode ? "Files and folders" : "Apps and commands"} aria-busy={busy || loading || clipLoading || aiLoading || fileLoading}>
      {results.map((result, index) => <MenuItem key={result.id} className={`${shadcn ? "gap-3 py-3" : "command-result"}${result.kind === "clip" ? " clipboard-result" : ""}`} {...(shadcn ? { value: result.id, onSelect: () => void run(result) } : { id: `command-result-${index}`, role: "option", "aria-selected": index === activeIndex, onMouseMove: () => setSelected(index), onClick: () => void run(result) })} onMouseDown={event => event.preventDefault()}>
        <span className={`command-result-icon ${result.kind}`} aria-hidden="true">{result.kind === "app" && result.app?.icon ? <img src={result.app.icon} alt="" onError={event => { event.currentTarget.style.display = "none"; }} /> : result.clip?.preview ? <img className="clipboard-thumbnail" src={result.clip.preview} alt="" /> : result.kind === "app" ? result.title.slice(0, 2).toUpperCase() : result.kind === "file" ? result.detail.startsWith("Folder") ? <FolderIcon /> : <FileIcon /> : result.kind === "power" ? result.action === "restart" ? <ArrowClockwiseIcon /> : result.action === "sleep" ? <MoonIcon /> : <PowerIcon /> : result.kind === "wallp" ? result.action === "reload" ? <ArrowClockwiseIcon /> : result.action === "quit" ? <SignOutIcon /> : <DesktopIcon /> : result.kind === "ai" ? <SparkleIcon /> : result.kind === "search" ? <MagnifyingGlassIcon /> : result.clip?.kind === "image" ? <ImageIcon /> : <ClipboardTextIcon />}</span>
        <span className="command-result-copy"><strong>{result.title}</strong><small title={result.detail}>{result.detail}</small></span>
        {result.app && <Button variant="ghost" size="icon-sm" className="command-pin aria-pressed:bg-muted aria-pressed:text-foreground" disabled={savingPin || !isTauri()} aria-pressed={pinnedIds.has(result.app.id)} aria-label={`${pinnedIds.has(result.app.id) ? "Unpin" : "Pin"} ${result.title} ${pinnedIds.has(result.app.id) ? "from" : "to"} Home`} title={pinnedIds.has(result.app.id) ? "Remove from Home (Ctrl+Enter)" : "Pin to Home (Ctrl+Enter)"} onClick={event => { event.stopPropagation(); void setPinned(result.app!.id, !pinnedIds.has(result.app!.id)); }}><PushPinIcon size={18} weight={pinnedIds.has(result.app.id) ? "fill" : "regular"} /></Button>}
        {(result.path || result.clip) && <Button className="shrink-0" variant="ghost" size="icon-sm" disabled={savingResource} aria-pressed={!!pinnedResource(result)} aria-label={`${pinnedResource(result) ? "Unpin" : "Pin"} ${result.title} ${pinnedResource(result) ? "from" : "to"} Files & Links`} title={`${pinnedResource(result) ? "Unpin from" : "Pin to"} Files & Links ? ${workspacePins.space.name} (Ctrl+Enter)`} onClick={event => { event.stopPropagation(); void toggleResourcePin(result); }}><PushPinIcon weight={pinnedResource(result) ? "fill" : "regular"} /></Button>}
        <ArrowRightIcon className="command-result-arrow" />
      </MenuItem>)}
      {mode === "clipboard" && (hasMore || clipLoading) && <Button variant="outline" size="sm" className="command-load-more" disabled={clipLoading} onClick={() => void loadMore()}>{clipLoading ? "Loading history…" : "Load older items"}</Button>}
      {fileMode && !results.length && <div className="command-empty" role="status"><MagnifyingGlassIcon size={34} /><strong>{fileLoading ? "Searching files…" : !fileQuery ? "Type a filename after f" : fileError ? "File search unavailable" : "No matching files or folders"}</strong><span>{fileLoading ? "Searching Sigma’s indexed drives" : "Searches filenames across Sigma’s indexed drives. Sigma manages index updates."}</span></div>}
      {!fileMode && !results.length && !clipLoading && <div className="command-empty"><ClipboardTextIcon size={34} /><strong>{mode === "clipboard" ? query ? "No matching clipboard items" : "Your clipboard history starts here" : loading ? "Loading installed apps…" : "No apps found"}</strong><span>{mode === "clipboard" ? "Copy text or an image in any app. History is saved across restarts." : "Refresh the app index to find newly installed apps."}</span></div>}
    </MenuList>
    </MenuRoot>
    {aiMode && <section className="command-ai" aria-label="AI conversation" aria-busy={aiLoading}>
      {aiHistoryError && <p className="command-error" role="alert">{aiHistoryError}</p>}
      {aiUnsaved && aiChatId && <Button variant="ghost" size="sm" className="command-save-retry" disabled={aiLoading} onClick={() => void saveChat(aiChatId, aiMessages)}>Retry saving</Button>}
      {aiHistoryOpen ? <div className="command-ai-history" aria-label="Saved AI chats" aria-busy={aiHistoryLoading}>
        <Input ref={historySearch} className="command-ai-history-search" aria-label="Search saved chats" role="combobox" aria-expanded="true" aria-controls="ai-chat-history" aria-activedescendant={filteredChats[historyIndex] ? `ai-chat-${historyIndex}` : undefined} placeholder="Search chats… ↑ ↓ to choose · Enter to open" value={aiHistoryQuery} onChange={event => { setAiHistoryQuery(event.target.value); setAiHistorySelected(0); }} />
        <p role="status">{aiHistoryLoading ? "Loading chats..." : !aiChats.length ? "No saved chats yet. Ask AI to start a conversation." : !filteredChats.length ? "No matching chats." : "↑ ↓ choose · Enter open · Esc back to chat"}</p>
        <div ref={historyList} id="ai-chat-history" role="listbox" aria-label="Chat history">
        {filteredChats.map((chat, index) => <div key={chat.id} className="command-ai-history-row" role="presentation">
          <Button variant="ghost" size="sm" id={`ai-chat-${index}`} data-ai-chat="" role="option" aria-selected={index === historyIndex} className="command-ai-history-open" disabled={aiHistoryLoading} onFocus={() => setAiHistorySelected(index)} onClick={() => void loadChat(chat.id)}><strong>{chat.title}</strong><small>{new Date(chat.updatedAt).toLocaleString()}</small></Button>
          <Button variant="ghost" size="sm" disabled={aiHistoryLoading} aria-label={"Delete chat: " + chat.title} onClick={() => void deleteChat(chat.id)}><TrashIcon /></Button>
        </div>)}
        </div>
      </div> : <>
      {!!aiMessages.length && <div className="command-ai-toolbar"><span>Agnes / agnes-3.0-flash</span><Button variant="ghost" size="sm" onClick={() => void copyAnswer()}>{copied ? "Copied" : "Copy last answer"}</Button></div>}
      <div ref={conversation} className="command-ai-answer" role="region" aria-label="Conversation" tabIndex={0}>
        {aiMessages.map((message, index) => <Fragment key={index}>{index === aiActivityIndex && activity}<article className={"command-ai-message " + message.role}><strong>{message.role === "user" ? "You" : "Agnes"}</strong><div>{message.role === "assistant" ? <AiMarkdown onError={setAiError}>{message.content}</AiMarkdown> : message.content}</div></article></Fragment>)}
        {aiPromptPending && <article className="command-ai-message user"><strong>You</strong><div>{aiPromptPending}</div></article>}
        {aiMessages.length <= aiActivityIndex && activity}
      </div>
      {aiLoading && <p className="command-ai-status" role="status"><ArrowClockwiseIcon className="command-spinning" />{aiStatus}<Button variant="ghost" size="sm" onClick={cancelAi}>Cancel</Button></p>}
      {aiError && <p className="command-error" role="alert">{aiError}</p>}
      {!!aiMessages.length && !aiLoading && <span className="command-ai-announcement" role="status">Answer ready. Type a reply to continue.</span>}
      </>}
    </section>}
    {aiMode && <div className="command-ai-shortcuts" aria-label="AI keyboard shortcuts"><span><kbd>Ctrl H</kbd> history</span><span><kbd>Ctrl N</kbd> new chat</span><span><kbd>Ctrl L</kbd> reply</span><span><kbd>Ctrl J</kbd> read</span><span><kbd>Ctrl ⇧ F</kbd> {aiExpanded ? "compact" : "expand"}</span><span><kbd>Ctrl ⇧ C</kbd> copy</span><span><kbd>Ctrl ⇧ X</kbd> stop</span></div>}
    <footer className="command-footer"><span><CommandIcon />wallp <i />{mode === "clipboard" ? `${clipTotal.toLocaleString()} saved · Text & images` : fileMode ? `${currentFiles.length}${currentFiles.length === 50 ? "+" : ""} file results` : `${apps.length} apps cached`}</span><span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> {mode === "clipboard" ? "paste" : aiMode ? "ask" : "open"}</span></footer>
    {mode === "apps" && !query && <div className="command-bangs">{engines.map(engine => <Button variant="ghost" size="xs" className="px-1.5 text-[10px]" key={engine.key} onClick={() => { changeQuery(`${engine.key} `); input.current?.focus(); }}><kbd>{engine.key}</kbd>{engine.name}</Button>)}</div>}
  </main>;
}

export function LauncherSettings() {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscription = listen<Preferences>("launcher://preferences", event => { if (!disposed) setPreferences(event.payload); });
    void invoke<Preferences>("launcher_preferences").then(value => { if (!disposed) setPreferences(value); }).catch(err => { if (!disposed) setError(String(err)); });
    return () => { disposed = true; void subscription.then(off => off()); };
  }, []);
  async function update(patch: Partial<Preferences>) {
    setBusy(true); setError("");
    const next = { ...preferences, ...patch };
    try { await invoke("set_launcher_preferences", { preferences: next }); setPreferences(next); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  return <div className="launcher-settings"><h3>Command menu</h3>
    <div className="setting-row toggle-row"><label htmlFor="launcher-shadcn">Use shadcn command menu<small>Switch between the shadcn command palette and the original menu.</small></label><Switch id="launcher-shadcn" checked={preferences.shadcnCommand} disabled={busy || !isTauri()} onCheckedChange={checked => void update({ shadcnCommand: checked })} /></div>
    <div className="setting-row toggle-row"><label htmlFor="launcher-shortcut">Ctrl + Space<small>Open the command menu from any app.</small></label><Switch id="launcher-shortcut" checked={preferences.ctrlSpace} disabled={busy || !isTauri()} onCheckedChange={checked => void update({ ctrlSpace: checked })} /></div>
    <div className="setting-row toggle-row"><label htmlFor="launcher-clipboard">Remember copied text and images<small>Saved locally across restarts, with no item-count limit. Clear history to delete saved items.</small></label><Switch id="launcher-clipboard" checked={preferences.clipboard} disabled={busy || !isTauri()} onCheckedChange={checked => void update({ clipboard: checked })} /></div>
    <div className="launcher-settings-actions"><Button variant="outline" size="sm" disabled={!isTauri()} onClick={() => void invoke("open_launcher").catch(err => setError(String(err)))}>Open command menu</Button><ClearClipboardHistory disabled={!isTauri()} /></div>
    {(error || preferences.shortcutError) && <p className="mt-3 break-words text-xs text-destructive" role="alert">{error || preferences.shortcutError}</p>}
  </div>;
}
