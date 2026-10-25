import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckIcon, CopyIcon, ShieldCheckIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { useTheme } from "./Theme";
import "./EmailCodeNotification.css";

type CodeNotification = { id: string; sender: string; email: string; subject: string; code: string; date: number };
const preview: CodeNotification = {
  id: "preview", sender: "Google", email: "no-reply@accounts.google.com",
  subject: "Your verification code", code: "082641", date: Date.now(),
};

export function EmailCodeNotification() {
  useTheme();
  const [notification, setNotification] = useState<CodeNotification | null>(() => isTauri() ? null : preview);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    document.documentElement.classList.add("email-code-surface");
    let disposed = false;
    const subscription = isTauri() ? listen<CodeNotification | null>("email-code://changed", event => {
      if (!disposed) setNotification(event.payload);
    }) : null;
    void subscription?.then(unlisten => {
      if (disposed) { unlisten(); return; }
      return invoke("email_code_ready");
    }).catch(() => { if (!disposed) setError("Couldn't connect to notifications."); });
    return () => {
      disposed = true;
      document.documentElement.classList.remove("email-code-surface");
      void subscription?.then(unlisten => unlisten()).catch(() => {});
    };
  }, []);
  useEffect(() => { setCopied(false); setError(""); }, [notification?.id]);

  async function dismiss() {
    if (!notification) return;
    try {
      if (isTauri()) await invoke("email_code_dismiss", { id: notification.id });
      else setNotification(null);
    } catch { setError("Couldn't dismiss. Please try again."); }
  }
  async function copy() {
    if (!notification) return;
    const id = notification.id;
    try {
      if (isTauri()) await invoke("email_code_copy", { id });
      else await navigator.clipboard.writeText(notification.code);
      setCopied(true); setError("");
    } catch { setError("Couldn't copy. Select the code to copy it manually."); }
  }
  if (!notification) return null;
  return <Card key={notification.id} className="code-toast relative h-full gap-2 border border-border p-4 font-mono ring-0" role="region" aria-label="Email verification code" onKeyDown={event => {
    if (event.key === "Escape") void dismiss();
  }}>
    <CardHeader className="flex flex-row items-center gap-2 p-0 text-muted-foreground">
      <ShieldCheckIcon className="size-3.5 shrink-0" />
      <span className="text-[10px] tracking-widest">VERIFICATION CODE</span>
      <span className="ml-auto text-[10px]">wallp</span>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss notification" onClick={() => void dismiss()}><XIcon /></Button>
    </CardHeader>
    <CardContent className="flex min-h-0 flex-col gap-2 p-0">
      <div className="flex min-w-0 items-baseline gap-2">
        <strong className="max-w-[50%] shrink truncate font-medium" title={notification.email}>{notification.sender}</strong>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={notification.subject}>{notification.subject}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 select-text text-[clamp(18px,6vw,26px)] leading-9 tracking-wider wrap-anywhere" aria-label={`Code ${notification.code}`}>{notification.code}</span>
        <Button size="sm" onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? "Copied" : "Copy code"}</Button>
      </div>
      <CardDescription className={`text-[10px] leading-4 ${error ? "text-destructive" : "truncate"}`} role="status">{error || (copied ? "Code copied to clipboard" : notification.email)}</CardDescription>
    </CardContent>
    <div className="code-toast-progress absolute inset-x-0 bottom-0 h-px origin-left bg-primary" aria-hidden="true" />
  </Card>;
}
