import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowBendUpLeftIcon, EnvelopeSimpleIcon, SignOutIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

type Account = { email: string; name?: string };
type Address = { name?: string; email: string };
type Message = { id: string; threadId: string; from: Address; to: Address[]; subject: string; snippet: string; date: number; unread: boolean; body?: string; bodyHtml?: string; pending?: boolean };
type InboxPage = { messages: Message[]; nextPageToken?: string };
type Conversation = { latest: Message; count: number; unread: boolean };

const SYNC_MS = 60_000;
const LIST_WIDTH_KEY = "wallp.email-list-width";
const LIST_MIN = 200, READER_MIN = 280, LIST_DEFAULT = 340;
function savedListWidth() {
  const value = Number(localStorage.getItem(LIST_WIDTH_KEY));
  return Number.isFinite(value) && value >= LIST_MIN ? value : LIST_DEFAULT;
}
const PREFETCH = 15;
const who = (a: Address) => a.name || a.email;
function when(ms: number) {
  const date = new Date(ms), now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
const hasRemoteImages = (html: string) => /<img[^>]+src\s*=\s*["']?\s*(https?:)?\/\//i.test(html) || /url\(\s*["']?\s*https?:/i.test(html);

// Reuse unchanged message objects so a sync only re-renders what actually changed.
function reconcile(previous: Message[], next: Message[]) {
  const byId = new Map(previous.map(m => [m.id, m]));
  let changed = previous.length !== next.length;
  const merged = next.map((m, i) => {
    const old = byId.get(m.id);
    const same = old && !old.pending && old.unread === m.unread && old.subject === m.subject && old.snippet === m.snippet && old.date === m.date && (old.body ?? old.bodyHtml) === (m.body ?? m.bodyHtml);
    if (!same || previous[i] !== old) changed = true;
    return same ? old : m;
  });
  return changed ? merged : previous;
}

// Scripts never run (no allow-scripts) and CSP blocks remote loads unless images are allowed.
function emailDocument(html: string, images: boolean) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, iframe, object, embed, form, link, meta, base").forEach(el => el.remove());
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${images ? " https: http:" : ""}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;padding:0}body{padding:16px;background:#f4f4f2;color:#202124;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#1a5fb4}blockquote{margin:0 0 0 .8ex;border-left:1px solid #bbb;padding-left:1ex}</style>
${Array.from(doc.head.querySelectorAll("style"), s => s.outerHTML).join("")}</head><body>${doc.body.innerHTML}</body></html>`;
}

// Remembered frame heights stop reopened messages from jumping while they lay out.
const frameHeights = new Map<string, number>();
const HtmlBody = memo(function HtmlBody({ id, html, images }: { id: string; html: string; images: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(() => frameHeights.get(id) ?? 160);
  const srcDoc = useMemo(() => emailDocument(html, images), [html, images]);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  function bind() {
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    doc.addEventListener("click", event => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) void openUrl(href).catch(() => {});
    });
    const measure = () => { const h = Math.max(40, doc.documentElement.scrollHeight); frameHeights.set(id, h); setHeight(h); };
    measure();
    observer.current?.disconnect();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(doc.body);
  }
  return <iframe ref={frame} className="email-frame" title="Email message" sandbox="allow-same-origin" srcDoc={srcDoc} style={{ height }} onLoad={bind} />;
});

function textOf(message: Message) {
  if (message.body) return message.body;
  if (message.bodyHtml) return new DOMParser().parseFromString(message.bodyHtml, "text/html").body.innerText.trim();
  return message.snippet;
}

function Skeleton({ rows = 6 }: { rows?: number }) {
  return <div className="app-placeholder placeholder-emails" aria-label="Loading">{Array.from({ length: rows }, (_, i) =>
    <div key={i} className="app-placeholder-row"><span className="app-placeholder-marker" /><span className="app-placeholder-lines"><i /><i /></span><span className="app-placeholder-meta" /></div>)}</div>;
}

const Row = memo(function Row({ conversation, selected, fresh, onOpen }: { conversation: Conversation; selected: boolean; fresh: boolean; onOpen: (threadId: string) => void }) {
  const { latest: m, count, unread } = conversation;
  return <button className={`email-row${unread ? " unread" : ""}${selected ? " selected" : ""}${fresh ? " email-row-new" : ""}`} onClick={() => onOpen(m.threadId)}>
    <span className="email-row-top"><strong>{who(m.from)}{count > 1 && <em> {count}</em>}</strong><small>{when(m.date)}</small></span>
    <span className="email-subject">{m.subject}</span>
    <small className="email-snippet">{m.snippet}</small>
  </button>;
}, (a, b) => a.conversation.latest === b.conversation.latest && a.conversation.count === b.conversation.count && a.conversation.unread === b.conversation.unread && a.selected === b.selected && a.fresh === b.fresh && a.onOpen === b.onOpen);

const Thread = memo(function Thread({ thread, account, onBack, onSend }: { thread: Message[]; account: Account; onBack: () => void; onSend: (replyTo: Message, body: string) => Promise<void> }) {
  const [html, setHtml] = useState(true);
  const [images, setImages] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const last = [...thread].reverse().find(m => !m.pending) ?? thread[thread.length - 1];
  const replyTo = last.from.email.toLowerCase() === account.email.toLowerCase() ? last.to.map(who).join(", ") : who(last.from);
  const anyHtml = thread.some(m => m.bodyHtml);
  const remote = html && thread.some(m => m.bodyHtml && hasRemoteImages(m.bodyHtml));
  async function send() {
    if (!reply.trim() || sending) return;
    const body = reply;
    setSending(true); setStatus(""); setReply("");
    try { await onSend(last, body); setStatus("Reply sent."); }
    catch (err) { setReply(body); setStatus(String(err)); }
    finally { setSending(false); }
  }
  return <div className="email-reader">
    <header className="email-reader-head">
      <Button variant="ghost" size="icon-sm" className="email-back" aria-label="Back to inbox" onClick={onBack}><ArrowLeftIcon /></Button>
      <h3>{thread[0].subject}</h3>
      {anyHtml && <Button variant="ghost" size="sm" aria-pressed={!html} title="Toggle between formatted and plain text" onClick={() => setHtml(!html)}>{html ? "Text" : "HTML"}</Button>}
    </header>
    {remote && !images && <p className="email-notice">Remote images are blocked. <button onClick={() => setImages(true)}>Load images</button></p>}
    {thread.map(message => <article key={message.id} className={`email-message${message.pending ? " pending" : ""}`}>
      <div className="email-meta"><strong>{who(message.from)}</strong><small title={new Date(message.date).toLocaleString()}>{message.pending ? "Sending…" : when(message.date)}</small></div>
      <small className="email-to">to {message.to.map(who).join(", ") || "(no recipients)"}</small>
      {html && message.bodyHtml ? <HtmlBody id={message.id} html={message.bodyHtml} images={images} /> : <div className="email-text">{textOf(message)}</div>}
    </article>)}
    <form className="email-reply" onSubmit={e => { e.preventDefault(); void send(); }}>
      <label htmlFor={`reply-${last.threadId}`}><ArrowBendUpLeftIcon size={13} /> Reply to {replyTo}</label>
      <textarea id={`reply-${last.threadId}`} value={reply} placeholder="Write a reply…" rows={4} disabled={sending} onChange={e => setReply(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); void send(); } }} />
      <div><small role="status">{status || "Ctrl+Enter to send"}</small><Button type="submit" disabled={!reply.trim() || sending}>{sending ? "Sending…" : "Send"}</Button></div>
    </form>
  </div>;
});

export function Email() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextPage, setNextPage] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [thread, setThread] = useState<Message[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const openRef = useRef<string | null>(null);
  const syncRef = useRef(false);
  const seen = useRef<Set<string> | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [listWidth, setListWidth] = useState(savedListWidth);
  const [resizing, setResizing] = useState(false);
  // The list never squeezes the reader below READER_MIN; CSS clamps again if the panel shrinks later.
  const clampWidth = (width: number) => Math.round(Math.max(LIST_MIN, Math.min(width, (shell.current?.clientWidth ?? Infinity) - READER_MIN)));
  const saveWidth = (width: number) => { try { localStorage.setItem(LIST_WIDTH_KEY, String(width)); } catch { /* Keep resizing usable without storage. */ } };

  useEffect(() => {
    if (!isTauri()) return;
    invoke<Account | null>("email_account").then(setAccount).catch(err => { setAccount(null); setError(String(err)); });
  }, []);

  const apply = useCallback((page: InboxPage) => {
    setMessages(current => reconcile(current, page.messages));
    setNextPage(page.nextPageToken);
  }, []);

  // Newest message per conversation, in inbox order.
  const conversations = useMemo(() => {
    const byThread = new Map<string, Conversation>();
    for (const m of messages) {
      const c = byThread.get(m.threadId);
      if (c) { c.count++; c.unread ||= m.unread; }
      else byThread.set(m.threadId, { latest: m, count: 1, unread: m.unread });
    }
    return [...byThread.values()];
  }, [messages]);
  // Rows that arrive after the first paint fade in; nothing else moves.
  const freshIds = useMemo(() => new Set(seen.current ? conversations.filter(c => !seen.current!.has(c.latest.id)).map(c => c.latest.id) : []), [conversations]);
  useEffect(() => {
    if (!ready) return;
    seen.current ??= new Set();
    conversations.forEach(c => seen.current!.add(c.latest.id));
  }, [conversations, ready]);

  const sync = useCallback(async () => {
    if (syncRef.current) return;
    syncRef.current = true; setSyncing(true);
    try {
      const page = await invoke<InboxPage>("email_inbox", { pageToken: null });
      apply(page); setSyncError("");
      // Warm the cache for the newest conversations so opening them is instant.
      const targets: { threadId: string; latestId: string }[] = [];
      for (const m of page.messages) {
        if (targets.length >= PREFETCH) break;
        if (!targets.some(t => t.threadId === m.threadId)) targets.push({ threadId: m.threadId, latestId: m.id });
      }
      void invoke("email_prefetch", { targets }).catch(() => {});
    } catch (err) { setSyncError(String(err)); }
    finally { syncRef.current = false; setSyncing(false); setReady(true); }
  }, [apply]);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    // Paint the saved inbox immediately, then sync in the background.
    invoke<InboxPage | null>("email_cached_inbox").then(cached => {
      if (cancelled) return;
      if (cached?.messages.length) { apply(cached); setReady(true); }
    }).catch(() => {}).finally(() => { if (!cancelled) void sync(); });
    const timer = setInterval(() => { if (!document.hidden) void sync(); }, SYNC_MS);
    const onVisible = () => { if (!document.hidden) void sync(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [account, apply, sync]);

  async function loadMore() {
    if (!nextPage || loadingMore) return;
    setLoadingMore(true);
    try { apply(await invoke<InboxPage>("email_inbox", { pageToken: nextPage })); setSyncError(""); }
    catch (err) { setSyncError(String(err)); }
    finally { setLoadingMore(false); }
  }

  const open = useCallback(async (threadId: string, quiet = false) => {
    openRef.current = threadId; setOpenId(threadId); setError("");
    // Read state flips immediately; Gmail catches up in the background.
    setMessages(current => current.some(m => m.threadId === threadId && m.unread) ? current.map(m => m.threadId === threadId && m.unread ? { ...m, unread: false } : m) : current);
    let shown = quiet;
    if (!quiet) {
      setThread(null);
      const cached = await invoke<Message[] | null>("email_cached_thread", { threadId }).catch(() => null);
      if (openRef.current !== threadId) return;
      if (cached?.length) { setThread(cached); shown = true; }
    }
    try {
      const loaded = await invoke<Message[]>("email_thread", { threadId });
      if (openRef.current === threadId) setThread(current => current ? reconcile(current, loaded) : loaded);
    } catch (err) {
      if (openRef.current !== threadId) return;
      if (shown) setSyncError(String(err));
      else { setError(String(err)); setOpenId(null); openRef.current = null; }
    }
  }, []);
  const close = useCallback(() => { openRef.current = null; setOpenId(null); setThread(null); }, []);
  const send = useCallback(async (replyTo: Message, body: string) => {
    if (!account) return;
    const threadId = replyTo.threadId;
    // Show the reply in the conversation right away, then swap in Gmail's copy.
    const local: Message = { id: `pending-${Date.now()}`, threadId, from: { email: account.email, name: account.name }, to: [replyTo.from], subject: replyTo.subject, snippet: body, body, date: Date.now(), unread: false, pending: true };
    setThread(current => current && current[0]?.threadId === threadId ? [...current, local] : current);
    try { await invoke("email_reply", { messageId: replyTo.id, body }); }
    catch (err) { setThread(current => current?.filter(m => m.id !== local.id) ?? null); throw err; }
    if (openRef.current === threadId) void open(threadId, true);
    void sync();
  }, [account, open, sync]);

  async function connect() {
    setConnecting(true); setError("");
    try { setAccount(await invoke<Account>("email_connect")); }
    catch (err) { setError(String(err)); }
    finally { setConnecting(false); }
  }
  async function disconnect() {
    try { await invoke("email_disconnect"); setAccount(null); setMessages([]); setNextPage(undefined); setReady(false); seen.current = null; close(); }
    catch (err) { setError(String(err)); }
  }

  if (!isTauri()) return <div className="panel-empty"><EnvelopeSimpleIcon size={28} weight="light" /><p>Email needs the desktop app.</p><small>Open wallp on your desktop to connect Gmail.</small></div>;
  if (account === undefined) return <Skeleton />;
  if (!account) return <div className="panel-empty">
    <EnvelopeSimpleIcon size={28} weight="light" /><p>Connect Gmail</p>
    <small>{connecting ? "Finish signing in in your browser…" : "Read your inbox and reply from the workspace."}</small>
    <Button onClick={() => void connect()} disabled={connecting}>{connecting ? "Waiting for Google…" : "Sign in with Google"}</Button>
    {error && <small className="email-error" role="alert">{error}</small>}
  </div>;

  return <div className="email-shell" ref={shell}><div className={`email${openId ? " has-thread" : ""}${resizing ? " email-resizing" : ""}`} style={{ "--email-list": `${listWidth}px` } as CSSProperties}>
    <div className="email-list">
      <div className="list-heading email-account">
        <span title={account.email}>{account.email}</span>
        <div>
          {syncError && messages.length > 0 && <small className="email-offline" title={syncError}>Offline · saved mail</small>}
          <Button variant="ghost" size="icon-sm" aria-label="Refresh inbox" title={syncing ? "Syncing…" : "Refresh inbox"} className={syncing ? "email-syncing" : ""} onClick={() => void sync()}><ArrowClockwiseIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Disconnect Gmail" title="Disconnect Gmail" onClick={() => void disconnect()}><SignOutIcon /></Button>
        </div>
      </div>
      {error && <p className="email-error" role="alert">{error}</p>}
      {!ready ? <Skeleton /> : <>
        {syncError && !messages.length && <p className="email-error" role="alert">{syncError}</p>}
        {conversations.map(c => <Row key={c.latest.threadId} conversation={c} selected={openId === c.latest.threadId} fresh={freshIds.has(c.latest.id)} onOpen={open} />)}
        {!messages.length && !syncError && <div className="panel-empty"><p>Inbox zero.</p></div>}
        {nextPage && <Button variant="ghost" className="email-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</Button>}
      </>}
    </div>
    <div className="email-splitter" role="separator" aria-orientation="vertical" aria-label="Resize inbox list" title="Drag to resize · double-click to reset" tabIndex={0}
      aria-valuenow={listWidth} aria-valuemin={LIST_MIN}
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, width: listWidth }; setResizing(true); }}
      onPointerMove={e => { if (drag.current) setListWidth(clampWidth(drag.current.width + e.clientX - drag.current.x)); }}
      onPointerUp={() => { if (!drag.current) return; drag.current = null; setResizing(false); saveWidth(listWidth); }}
      onLostPointerCapture={() => { if (!drag.current) return; drag.current = null; setResizing(false); saveWidth(listWidth); }}
      onDoubleClick={() => { setListWidth(LIST_DEFAULT); saveWidth(LIST_DEFAULT); }}
      onKeyDown={e => {
        const step = e.shiftKey ? 64 : 16;
        const next = e.key === "ArrowLeft" ? listWidth - step : e.key === "ArrowRight" ? listWidth + step : e.key === "Home" ? LIST_MIN : e.key === "End" ? Infinity : null;
        if (next === null) return;
        e.preventDefault(); const width = clampWidth(next); setListWidth(width); saveWidth(width);
      }} />
    {openId && (thread
      ? <Thread key={openId} thread={thread} account={account} onBack={close} onSend={send} />
      : <div className="email-reader"><Skeleton rows={3} /></div>)}
    {!openId && <div className="email-reader email-placeholder"><div className="panel-empty"><EnvelopeSimpleIcon size={28} weight="light" /><small>Select a conversation to read it.</small></div></div>}
  </div></div>;
}
