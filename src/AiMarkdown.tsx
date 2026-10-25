import Markdown from "react-markdown";
import { Button } from "@/components/ui/button";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";
import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";

function CodeBlock({ children }: { children?: ReactNode }) {
  const element = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children : null;
  const code = String(element?.props.children ?? "").replace(/\n$/, "");
  const language = /language-([^\s]+)/.exec(element?.props.className ?? "")?.[1];
  const highlighted = useMemo(() => {
    if (code.length > 100_000) return null;
    if (language) return hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }) : null;
    return hljs.highlightAuto(code);
  }, [code, language]);
  const [copyStatus, setCopyStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setCopyStatus(""); clearTimeout(timer.current); }, [code]);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopyStatus("Copied"); }
    catch { setCopyStatus("Copy failed"); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyStatus(""), 2500);
  }
  return <div className="ai-code-block">
    <div className="ai-code-toolbar"><span>{language ?? highlighted?.language ?? "text"}</span><Button variant="ghost" size="xs" aria-label="Copy code" onClick={() => void copy()}>{copyStatus || "Copy code"}</Button><span className="command-ai-announcement" role="status">{copyStatus}</span></div>
    <pre tabIndex={0} aria-label={(language ?? "Plain text") + " code"}>{highlighted
      ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted.value }} />
      : <code>{code}</code>}</pre>
  </div>;
}

export function AiMarkdown({ children, onError }: { children: string; onError: (error: string) => void }) {
  return <div className="ai-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre: CodeBlock,
    img: ({ alt }) => <span>[Image: {alt || "image"}]</span>,
    a: ({ href, children }) => {
      const safe = href && /^https?:\/\//i.test(href);
      return safe ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
        if (isTauri()) {
          event.preventDefault();
          void openUrl(href).catch(() => onError("Could not open this link."));
        }
      }}>{children}</a> : <span>{children}</span>;
    },
    table: ({ children }) => <div className="ai-table-scroll"><table>{children}</table></div>,
  }}>{children}</Markdown></div>;
}
