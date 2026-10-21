import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowClockwiseIcon, ArrowUpRightIcon, EnvelopeSimpleIcon, SparkleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

type Item = { id: string; threadId: string; subject: string; sender: string; date: number; category: string; priority: "high" | "normal" | "low"; summary: string };
type Digest = { account: string; since: number; lastClosed: number; checkedThrough: number; updatedAt: number | null; sampleComplete: boolean; sampleCount: number; items: Item[] };
const categories = ["Work", "Personal", "Finance", "Orders & deliveries", "Security", "Newsletters", "Other"];
const timestamp = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function EmailDigest({ active }: { active: boolean }) {
  const [digest, setDigest] = useState<Digest | null>();
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const syncing = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (!isTauri() || syncing.current) return;
    syncing.current = true; setBusy(true);
    try {
      const next = await invoke<Digest | null>("email_digest_refresh");
      if (mounted.current) { setDigest(next); setError(""); }
    } catch (err) {
      if (mounted.current) {
        setError(String(err));
        // Successful earlier batches can still be displayed after a later failure.
        try { const saved = await invoke<Digest | null>("email_digest_cached"); if (mounted.current) setDigest(saved); } catch { /* Keep the last usable digest. */ }
      }
    } finally { syncing.current = false; if (mounted.current) setBusy(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (isTauri()) void invoke<Digest | null>("email_digest_cached").then(value => {
      if (mounted.current) setDigest(current => current === undefined ? value : current);
    }).catch(err => { if (mounted.current) setError(String(err)); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!active || !isTauri()) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const changed = () => void refresh();
    window.addEventListener("wallp:email-account", changed);
    return () => { clearInterval(timer); window.removeEventListener("wallp:email-account", changed); };
  }, [active, refresh]);
  async function connect() {
    setConnecting(true); setError("");
    try { await invoke("email_connect"); window.dispatchEvent(new Event("wallp:email-account")); await refresh(); }
    catch (err) { setError(String(err)); }
    finally { setConnecting(false); }
  }
  async function open(item: Item) {
    // The account is part of the URL so another signed-in Gmail account isn't used.
    try { await openUrl(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(digest!.account)}#all/${encodeURIComponent(item.threadId)}`); }
    catch (err) { setError(String(err)); }
  }
  const items = digest?.items ?? [];
  const important = items.filter(item => item.priority === "high");
  const ranked = [...items].sort((a, b) => ({high: 0, normal: 1, low: 2}[a.priority] - {high: 0, normal: 1, low: 2}[b.priority]) || b.date - a.date);
  const visible = filter ? ranked.filter(item => item.category === filter) : showAll ? ranked : (important.length ? ranked.filter(item => item.priority === "high") : ranked).slice(0, 3);
  return <section className="email-digest" aria-labelledby="digest-title" aria-busy={busy}>
    <header className="digest-header">
      <div><span className="digest-eyebrow"><SparkleIcon size={13} /> YOUR DAILY CATCH-UP</span><h1 id="digest-title">Inbox brief</h1></div>
      {isTauri() && digest && <Button variant="ghost" size="icon-sm" aria-label="Refresh email summary" disabled={busy} onClick={() => void refresh()}><ArrowClockwiseIcon className={busy ? "email-syncing" : ""} /></Button>}
    </header>
    {!isTauri() ? <div className="digest-empty"><EnvelopeSimpleIcon size={28} weight="light" /><p>A little clarity for your inbox.</p><small>Open wallp on your desktop to connect Gmail and see your email brief.</small></div>
    : digest === undefined ? <p className="digest-status" role="status">Loading your email brief…</p>
    : digest === null ? <div className="digest-empty"><EnvelopeSimpleIcon size={28} weight="light" /><p>A little clarity for your inbox.</p><small>Get category counts and a summary of what needs your attention. The first brief uses your latest 10 received emails.</small><Button disabled={connecting} onClick={() => void connect()}>{connecting ? "Waiting for Google…" : "Connect Gmail"}</Button></div>
    : <>
      <p className="digest-account">{digest.account}<span>{busy ? "Updating brief…" : digest.updatedAt ? `Updated ${timestamp(digest.updatedAt)}` : "Waiting for new mail"}</span></p>
      <div className="digest-content"><div className="digest-breakdown">
      <div className="digest-overview" aria-label="Email overview"><div><strong>{items.length.toLocaleString()}</strong><span>emails received</span></div><div><strong>{important.length.toLocaleString()}</strong><span>need attention</span></div></div>
      <div className="digest-categories" aria-label="Filter emails by category">{categories.map(category => {
        const count = items.filter(item => item.category === category).length;
        return <button key={category} aria-pressed={filter === category} disabled={!count} onClick={() => setFilter(current => current === category ? null : category)}><span>{category}</span><strong>{count}</strong></button>;
      })}</div>
      <p className="digest-collection">{digest.sampleComplete ? `Includes your latest ${digest.sampleCount} emails` : "Preparing your latest 10 emails…"}<br />New mail is added automatically.</p>
      </div><div className="digest-highlights">
      <div className="digest-list-heading"><h2>{filter ?? (showAll ? "All emails" : important.length ? "Needs your attention" : "Worth a look")}</h2><button onClick={() => { setFilter(null); setShowAll(!(showAll || filter)); }}>{showAll || filter ? "Show highlights" : `View all ${items.length}`}</button></div>
      <div className="digest-items" aria-live="polite">
        {visible.map(item => <article className={`digest-item priority-${item.priority}`} key={item.id}>
          <div className="digest-item-meta"><span>{item.category}{item.priority === "high" && <b>Needs attention</b>}</span><time dateTime={new Date(item.date).toISOString()}>{timestamp(item.date)}</time></div>
          <button className="digest-subject" onClick={() => void open(item)} title="Open original email in Gmail">{item.subject}<ArrowUpRightIcon size={14} /></button>
          <small className="digest-sender">{item.sender}</small><p>{item.summary}</p>
        </article>)}
        {!visible.length && <p className="digest-status">{busy ? "Reading your emails and preparing a summary…" : items.length ? "You’re all caught up. No important items in this view." : "No new emails yet. Your next brief will appear here."}</p>}
      </div>
      </div></div>
      <footer className="digest-footer"><span>Last closed {timestamp(digest.lastClosed)}</span><span title={`Mail collected since ${timestamp(digest.since)}. Checked through ${timestamp(digest.checkedThrough)}.`}>Only new emails are sent to Agnes</span></footer>
    </>}
    {error && <p className="digest-error" role="alert">{error} <button disabled={busy} onClick={() => void refresh()}>Retry</button></p>}
  </section>;
}
