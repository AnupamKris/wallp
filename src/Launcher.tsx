import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ArrowLeftIcon, ArrowRightIcon, ClipboardTextIcon, MagnifyingGlassIcon, ArrowClockwiseIcon, TrashIcon, ImageIcon, CommandIcon, SparkleIcon, PushPinIcon, PowerIcon, MoonIcon } from "@phosphor-icons/react";
import { useHomeShortcuts } from "./home-shortcuts";
import { engines, isClipboardCommand, parseBang, searchApps, searchPowerCommands, type InstalledApp, type PowerAction } from "./launcher-search";
import "./Launcher.css";
import { AiMarkdown } from "./AiMarkdown";
import { runAiTools, type AiResponse } from "./ai-tools";

type Clip = { id: number; kind: "text" | "image"; text: string; preview?: string | null; width: number; height: number };
type ClipPage = { entries: Clip[]; total: number; hasMore: boolean };
type AiMessage = { role: "user" | "assistant"; content: string };
type ChatSummary = { id: string; title: string; updatedAt: number };
type Preferences = { ctrlSpace: boolean; clipboard: boolean; shortcutError?: string | null };
const initialPreferences: Preferences = { ctrlSpace: true, clipboard: true };
type Result = { id: string; title: string; detail: string; kind: "app" | "clipboard" | "clip" | "search" | "ai" | "power"; app?: InstalledApp; clip?: Clip; engine?: string; query?: string; action?: PowerAction };

export function Launcher() {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipTotal, setClipTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [clipLoading, setClipLoading] = useState(false);
  const [clipRevision, setClipRevision] = useState(0);
  const clipRequest = useRef(0);
  const [query, setQuery] = useState("");
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
  const [aiUnsaved, setAiUnsaved] = useState(false);
  const historyRequest = useRef(0);
  const [aiPromptPending, setAiPromptPending] = useState("");
  const [aiError, setAiError] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const aiRequest = useRef(0);
  const aiPending = useRef(false);
  const aiSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  function open(mode: string) {
    resetAi();
    setMode(mode === "clipboard" ? "clipboard" : "apps"); setQuery(""); setSelected(0); setError(""); setOpening(value => value + 1);
  }
  function resetAi() {
    cancelAi(); ++historyRequest.current; setAiMessages([]); setAiChatId(null); setAiUnsaved(false); setAiHistoryOpen(false); setAiHistoryError(""); setAiHistoryLoading(false);
  }
  function cancelAi() {
    ++aiRequest.current; aiPending.current = false;
    setAiPromptPending(""); setAiError(""); setAiLoading(false); setCopied(false);
  }
  function changeQuery(value: string) {
    if (mode === "ai" || parseBang(value)?.key === "ai") cancelAi(); else resetAi();
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
        subscribe<string>("launcher://open", open),
        subscribe<InstalledApp[]>("launcher://apps", apps => { setApps(apps); setLoading(false); }),
        subscribe<void>("launcher://clipboard", () => setClipRevision(value => value + 1)),
        subscribe<Preferences>("launcher://preferences", setPreferences),
        subscribe<string>("launcher://error", error => { setError(error); setLoading(false); }),
      ]);
      const [apps, prefs] = await Promise.all([invoke<InstalledApp[]>("launcher_apps"), invoke<Preferences>("launcher_preferences")]);
      if (disposed) return;
      setApps(apps); setPreferences(prefs); setLoading(false);
      const mode = await invoke<string>("launcher_ready");
      if (!disposed) open(mode);
    })().catch(err => { if (!disposed) { setError(String(err)); setLoading(false); } });
    else { setLoading(false); }
    return () => { disposed = true; subscriptions.forEach(off => off()); document.documentElement.classList.remove("launcher-view"); };
  }, []);
  useEffect(() => { input.current?.focus(); }, [opening, mode]);
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
  const aiMode = mode === "ai" || bang?.key === "ai";
  const aiPrompt = mode === "ai" ? query.trim() : bang?.query ?? "";
  const results: Result[] = mode === "clipboard"
    ? clips.map(clip => ({ id: `clip-${clip.id}`, title: clip.text.slice(0, 400), detail: clip.kind === "image" ? `${clip.width} × ${clip.height} pixels` : `${clip.text.length.toLocaleString()} characters`, kind: "clip", clip }))
    : aiMode
      ? [{ id: "ai", title: aiPrompt ? `${aiMessages.length ? "Reply" : "Ask AI"}: ${aiPrompt}` : aiMessages.length ? "Type a reply to continue the conversation" : "Type a question after ai", detail: aiLoading ? "Thinking…" : "agnes-3.0-flash · Enter to send", kind: "ai", query: aiPrompt }]
    : bang
      ? [{ id: "bang", title: bang.query ? `Search ${bang.name} for “${bang.query}”` : `Type a ${bang.name} search`, detail: `${bang.key} · ${bang.name}`, kind: "search", engine: bang.key, query: bang.query }]
      : [
        ...searchPowerCommands(query).map(command => ({ id: `power-${command.action}`, title: command.title, detail: command.detail, kind: "power" as const, action: command.action })),
        ...(isClipboardCommand(query) || !query.trim() ? [{ id: "clipboard", title: "Paste from clipboard history", detail: `${clipTotal.toLocaleString()} copied items · Type paste`, kind: "clipboard" as const }] : []),
        ...searchApps(apps, query).map(app => ({ id: app.id, title: app.name, detail: "Application", kind: "app" as const, app })),
        ...(query.trim() && !isClipboardCommand(query) ? [{ id: "google", title: `Search Google for “${query.trim()}”`, detail: "Web search", kind: "search" as const, engine: "g", query: query.trim() }] : []),
      ];
  const activeIndex = Math.min(selected, Math.max(results.length - 1, 0));
  const active = results[activeIndex];
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [activeIndex, query, mode, apps, clips]);
  async function close() { resetAi(); if (isTauri()) await invoke("close_launcher"); }
  async function askAi(prompt: string) {
    if (!prompt.trim() || aiPending.current) return;
    if (!isTauri()) { setAiError("Open wallp on your desktop to ask AI."); return; }
    const request = ++aiRequest.current;
    const chatId = aiChatId ?? crypto.randomUUID();
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
      );
      if (request === aiRequest.current && answer !== null) {
        const messages: AiMessage[] = [...aiMessages, { role: "user", content: prompt }, { role: "assistant", content: answer }];
        setAiMessages(messages);
        setAiPromptPending("");
        setMode("ai"); setQuery(""); input.current?.focus();
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
    cancelAi(); setAiHistoryOpen(true); setAiHistoryLoading(true); setAiHistoryError("");
    const request = ++historyRequest.current;
    try {
      if (!isTauri()) throw new Error("Open wallp on your desktop to view saved chats.");
      const chats = await invoke<ChatSummary[]>("ai_list_chats");
      if (request === historyRequest.current) setAiChats(chats);
    } catch (err) { if (request === historyRequest.current) setAiHistoryError(String(err)); }
    finally { if (request === historyRequest.current) setAiHistoryLoading(false); }
  }
  async function loadChat(id: string) {
    const request = ++historyRequest.current;
    setAiHistoryLoading(true); setAiHistoryError("");
    try {
      const messages = await invoke<AiMessage[]>("ai_load_chat", { id });
      if (request !== historyRequest.current) return;
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
  async function run(result?: Result) {
    if (!result || busy || aiHistoryLoading) return;
    if (result.kind === "ai") { if (aiHistoryOpen) { ++historyRequest.current; setAiHistoryOpen(false); } await askAi(result.query ?? ""); return; }
    if (result.kind === "clipboard") { open("clipboard"); return; }
    if (!isTauri()) { setError("Open wallp on your desktop to run commands."); return; }
    setBusy(true); setError("");
    try {
      if (result.kind === "power") await invoke("launcher_power", { action: result.action });
      if (result.kind === "app") await invoke("launch_app", { id: result.app!.id });
      if (result.kind === "search") await invoke("launcher_search", { engine: result.engine, query: result.query });
      if (result.kind === "clip") await invoke("paste_clipboard", { id: result.clip!.id });
    } catch (err) {
      if (result.kind === "clip") await invoke("open_launcher", { mode: "clipboard" }).catch(() => {});
      if (result.kind === "power" && result.action === "sleep") await invoke("open_launcher").catch(() => {});
      setError(String(err));
    } finally { setBusy(false); }
  }
  async function refresh() {
    if (!isTauri() || busy) return;
    setBusy(true); setError("");
    try { setApps(await invoke<InstalledApp[]>("refresh_launcher_apps")); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  return <main className={`command-menu${aiMode ? " command-ai-mode" : ""}`} aria-label="wallp command menu" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); if (mode === "clipboard" || mode === "ai") open("apps"); else void close(); }
  }}>
    <header className="command-search">
      {mode === "clipboard" || mode === "ai" ? <button className="command-icon-button" aria-label="Back to apps" onClick={() => open("apps")}><ArrowLeftIcon /></button> : <MagnifyingGlassIcon size={23} />}
      <input ref={input} role="combobox" aria-label={mode === "clipboard" ? "Search clipboard history" : mode === "ai" ? "Reply to AI" : "Search apps and commands"} aria-expanded="true" aria-autocomplete="list" aria-controls="command-results" aria-activedescendant={active ? `command-result-${activeIndex}` : undefined} autoComplete="off" spellCheck={false} value={query} placeholder={mode === "ai" ? "Reply to Agnes..." : mode === "clipboard" ? "Search saved text or images…" : "Search apps, paste, or ai anything…"} onChange={event => changeQuery(event.target.value)} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (event.key === "ArrowDown" && mode === "clipboard" && activeIndex === results.length - 1 && hasMore) { void loadMore(); return; }
          setSelected((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % Math.max(results.length, 1));
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.ctrlKey && active?.app) void setPinned(active.app.id, !pinnedIds.has(active.app.id));
          else void run(active);
        }
        if (event.key === "Backspace" && !query && mode === "clipboard") open("apps");
      }} />
      <kbd>esc</kbd>
    </header>
    <div className="command-section"><span>{mode === "clipboard" ? "Clipboard history" : aiMode ? "Ask AI · agnes-3.0-flash" : bang ? "Search shortcut" : "Applications & commands"}</span><div>
      {aiMode ? <><button disabled={aiLoading || aiHistoryLoading} onClick={() => { if (aiHistoryOpen) { ++historyRequest.current; setAiHistoryOpen(false); } else void showHistory(); }}>{aiHistoryOpen ? "Back to chat" : "History"}</button><button disabled={aiLoading || aiHistoryLoading} onClick={() => { resetAi(); setMode("ai"); setQuery(""); input.current?.focus(); }}>New chat</button></> : mode === "clipboard" ? <button disabled={!clipTotal || busy || !isTauri()} onClick={() => void invoke("clear_clipboard_history").catch(err => setError(String(err)))}><TrashIcon />Clear history</button> : <button disabled={busy || !isTauri()} onClick={() => void refresh()}><ArrowClockwiseIcon className={busy ? "command-spinning" : ""} />Refresh apps</button>}
    </div></div>
    {mode === "clipboard" && !preferences.clipboard && <p className="command-notice">Clipboard capture is paused. Enable it in Settings to collect new items.</p>}
    {error && <p className="command-error" role="alert">{error}</p>}
    <div ref={list} id="command-results" className="command-results" role="listbox" aria-label={mode === "clipboard" ? "Copied text and images" : "Apps and commands"} aria-busy={busy || loading || clipLoading || aiLoading}>
      {results.map((result, index) => <div key={result.id} id={`command-result-${index}`} className={`command-result${result.kind === "clip" ? " clipboard-result" : ""}`} role="option" aria-selected={index === activeIndex} onMouseMove={() => setSelected(index)} onMouseDown={event => event.preventDefault()} onClick={() => void run(result)}>
        <span className={`command-result-icon ${result.kind}`} aria-hidden="true">{result.kind === "app" && result.app?.icon ? <img src={result.app.icon} alt="" onError={event => { event.currentTarget.style.display = "none"; }} /> : result.clip?.preview ? <img className="clipboard-thumbnail" src={result.clip.preview} alt="" /> : result.kind === "app" ? result.title.slice(0, 2).toUpperCase() : result.kind === "power" ? result.action === "restart" ? <ArrowClockwiseIcon /> : result.action === "sleep" ? <MoonIcon /> : <PowerIcon /> : result.kind === "ai" ? <SparkleIcon /> : result.kind === "search" ? <MagnifyingGlassIcon /> : result.clip?.kind === "image" ? <ImageIcon /> : <ClipboardTextIcon />}</span>
        <span className="command-result-copy"><strong>{result.title}</strong><small>{result.detail}</small></span>
        {result.app && <button className="command-pin" disabled={savingPin || !isTauri()} aria-pressed={pinnedIds.has(result.app.id)} aria-label={`${pinnedIds.has(result.app.id) ? "Unpin" : "Pin"} ${result.title} ${pinnedIds.has(result.app.id) ? "from" : "to"} Home`} title={pinnedIds.has(result.app.id) ? "Remove from Home (Ctrl+Enter)" : "Pin to Home (Ctrl+Enter)"} onClick={event => { event.stopPropagation(); void setPinned(result.app!.id, !pinnedIds.has(result.app!.id)); }}><PushPinIcon size={18} weight={pinnedIds.has(result.app.id) ? "fill" : "regular"} /></button>}
        <ArrowRightIcon className="command-result-arrow" />
      </div>)}
      {mode === "clipboard" && (hasMore || clipLoading) && <button className="command-load-more" disabled={clipLoading} onClick={() => void loadMore()}>{clipLoading ? "Loading history…" : "Load older items"}</button>}
      {!results.length && !clipLoading && <div className="command-empty"><ClipboardTextIcon size={34} /><strong>{mode === "clipboard" ? query ? "No matching clipboard items" : "Your clipboard history starts here" : loading ? "Loading installed apps…" : "No apps found"}</strong><span>{mode === "clipboard" ? "Copy text or an image in any app. History is saved across restarts." : "Refresh the app index to find newly installed apps."}</span></div>}
    </div>
    {aiMode && <section className="command-ai" aria-label="AI conversation" aria-busy={aiLoading}>
      {aiHistoryError && <p className="command-error" role="alert">{aiHistoryError}</p>}
      {aiUnsaved && aiChatId && <button className="command-save-retry" disabled={aiLoading} onClick={() => void saveChat(aiChatId, aiMessages)}>Retry saving</button>}
      {aiHistoryOpen ? <div className="command-ai-history" aria-label="Saved AI chats" aria-busy={aiHistoryLoading}>
        <p>{aiHistoryLoading ? "Loading chats..." : aiChats.length ? "Saved on this device" : "No saved chats yet. Ask AI to start a conversation."}</p>
        {aiChats.map(chat => <div key={chat.id} className="command-ai-history-row">
          <button className="command-ai-history-open" disabled={aiHistoryLoading} onClick={() => void loadChat(chat.id)}><strong>{chat.title}</strong><small>{new Date(chat.updatedAt).toLocaleString()}</small></button>
          <button disabled={aiHistoryLoading} aria-label={"Delete chat: " + chat.title} onClick={() => void deleteChat(chat.id)}><TrashIcon /></button>
        </div>)}
      </div> : <>
      {!!aiMessages.length && <div className="command-ai-toolbar"><span>Agnes / agnes-3.0-flash</span><button onClick={() => void copyAnswer()}>{copied ? "Copied" : "Copy last answer"}</button></div>}
      <div ref={conversation} className="command-ai-answer" role="region" aria-label="Conversation" tabIndex={0}>
        {aiMessages.map((message, index) => <article key={index} className={"command-ai-message " + message.role}><strong>{message.role === "user" ? "You" : "Agnes"}</strong><div>{message.role === "assistant" ? <AiMarkdown onError={setAiError}>{message.content}</AiMarkdown> : message.content}</div></article>)}
        {aiPromptPending && <article className="command-ai-message user"><strong>You</strong><div>{aiPromptPending}</div></article>}
      </div>
      {aiLoading && <p className="command-ai-status" role="status"><ArrowClockwiseIcon className="command-spinning" />Thinking...<button onClick={cancelAi}>Cancel</button></p>}
      {aiError && <p className="command-error" role="alert">{aiError}</p>}
      {!!aiMessages.length && !aiLoading && <span className="command-ai-announcement" role="status">Answer ready. Type a reply to continue.</span>}
      </>}
    </section>}
    <footer className="command-footer"><span><CommandIcon />wallp <i />{mode === "clipboard" ? `${clipTotal.toLocaleString()} saved · Text & images` : `${apps.length} apps cached`}</span><span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> {mode === "clipboard" ? "paste" : aiMode ? "ask" : "open"}</span></footer>
    {mode === "apps" && !query && <div className="command-bangs">{engines.map(engine => <button key={engine.key} onClick={() => { changeQuery(`${engine.key} `); input.current?.focus(); }}><kbd>{engine.key}</kbd>{engine.name}</button>)}</div>}
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
    <label><input type="checkbox" checked={preferences.ctrlSpace} disabled={busy || !isTauri()} onChange={event => void update({ ctrlSpace: event.target.checked })} /><span>Ctrl + Space<small>Open the command menu from any app.</small></span></label>
    <label><input type="checkbox" checked={preferences.clipboard} disabled={busy || !isTauri()} onChange={event => void update({ clipboard: event.target.checked })} /><span>Remember copied text and images<small>Saved locally across restarts, with no item-count limit. Clear history to delete saved items.</small></span></label>
    <div className="launcher-settings-actions"><button disabled={!isTauri()} onClick={() => void invoke("open_launcher").catch(err => setError(String(err)))}>Open command menu</button><button disabled={!isTauri()} onClick={() => void invoke("clear_clipboard_history").catch(err => setError(String(err)))}>Clear clipboard history</button></div>
    {(error || preferences.shortcutError) && <p role="alert">{error || preferences.shortcutError}</p>}
  </div>;
}
