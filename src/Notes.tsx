import { useRef, useState } from "react";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

type Note = { id: string; title: string; text: string };
type State = { tabs: Note[]; closed: Note[]; activeId: string };
const storageKey = "wallp.notes.tabs";
const newNote = (): Note => ({ id: crypto.randomUUID(), title: "Untitled", text: "" });
function emptyState(text = ""): State {
  const note = { ...newNote(), text };
  return { tabs: [note], closed: [], activeId: note.id };
}
function load(): State {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return emptyState(localStorage.getItem("wallp.notes") ?? "");
  const state = JSON.parse(raw);
  const valid = (note: Note) => note && typeof note.id === "string" && typeof note.title === "string" && typeof note.text === "string";
  if (!state || !Array.isArray(state.tabs) || !state.tabs.length || !Array.isArray(state.closed)
    || !state.tabs.every(valid) || !state.closed.every(valid)
    || !state.tabs.some((note: Note) => note.id === state.activeId)
    || new Set([...state.tabs, ...state.closed].map((note: Note) => note.id)).size !== state.tabs.length + state.closed.length) throw new Error("Invalid saved notes");
  return state;
}

export function Notes() {
  const [initial] = useState(() => {
    try { return { state: load(), error: false }; }
    catch { return { state: emptyState(), error: true }; }
  });
  const [state, setState] = useState(initial.state);
  const [saved, setSaved] = useState(!initial.error);
  const [wrap, setWrap] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const active = state.tabs.find(note => note.id === state.activeId)!;

  function save(next: State) {
    setState(next);
    // Do not overwrite unreadable saved notes with a blank draft.
    if (initial.error) { setSaved(false); return; }
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setSaved(true); }
    catch { setSaved(false); }
  }
  function update(patch: Partial<Note>) {
    save({ ...state, tabs: state.tabs.map(note => note.id === active.id ? { ...note, ...patch } : note) });
  }
  function select(id: string) { setRenaming(false); save({ ...state, activeId: id }); }
  function add() {
    const note = newNote();
    setRenaming(false);
    save({ ...state, tabs: [...state.tabs, note], activeId: note.id });
    requestAnimationFrame(() => editor.current?.focus());
  }
  function close(id: string) {
    const index = state.tabs.findIndex(note => note.id === id);
    const tabs = state.tabs.filter(note => note.id !== id);
    if (!tabs.length) tabs.push(newNote());
    setRenaming(false);
    save({ tabs, closed: [...state.closed, state.tabs[index]], activeId: state.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : state.activeId });
    requestAnimationFrame(() => editor.current?.focus());
  }
  function download() {
    const url = URL.createObjectURL(new Blob([active.text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${active.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "notes"}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="notes-app">
    <div className="notes-tabbar">
      <div className="notes-tabs" role="tablist" aria-label="Note tabs">
        {state.tabs.map(note => <div className="notes-tab" data-active={note.id === active.id} key={note.id}>
          <button role="tab" id={`note-tab-${note.id}`} aria-controls={note.id === active.id ? "note-editor" : undefined} aria-selected={note.id === active.id}
            tabIndex={note.id === active.id ? 0 : -1} title={note.title} onClick={() => select(note.id)} onDoubleClick={() => setRenaming(true)}
            onKeyDown={event => {
              const index = state.tabs.findIndex(tab => tab.id === note.id);
              const next = event.key === "ArrowRight" ? (index + 1) % state.tabs.length : event.key === "ArrowLeft" ? (index + state.tabs.length - 1) % state.tabs.length : event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault(); select(state.tabs[next].id);
              document.getElementById(`note-tab-${state.tabs[next].id}`)?.focus();
            }}>{note.title || "Untitled"}</button>
          <button aria-label={`Close ${note.title || "Untitled"}`} title="Close tab (can be reopened)" onClick={() => close(note.id)}><XIcon size={12} /></button>
        </div>)}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="New note" title="New note" onClick={add}><PlusIcon /></Button>
    </div>
    <div className="notes-toolbar">
      {renaming ? <input className="note-title-input" aria-label="Note title" autoFocus value={active.title} maxLength={100}
        onChange={event => update({ title: event.target.value })}
        onBlur={() => { if (!active.title.trim()) update({ title: "Untitled" }); setRenaming(false); }}
        onKeyDown={event => { if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur(); }} />
        : <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>Rename</Button>}
      <Button variant="ghost" size="sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Word wrap</Button>
      <Button variant="ghost" size="sm" onClick={download}>Export .txt</Button>
      {!!state.closed.length && <Button variant="ghost" size="sm" onClick={() => {
        const note = state.closed[state.closed.length - 1];
        setRenaming(false); save({ tabs: [...state.tabs, note], closed: state.closed.slice(0, -1), activeId: note.id });
      }}>Reopen closed tab</Button>}
    </div>
    <div className="notes-editor" role="tabpanel" id="note-editor" aria-labelledby={`note-tab-${active.id}`}>
      <textarea ref={editor} key={active.id} aria-label="Notes" placeholder="Start writing…" value={active.text} wrap={wrap ? "soft" : "off"} spellCheck={false}
        onChange={event => update({ text: event.target.value })}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(state); }
        }} />
    </div>
    <footer className="notes-status">
      <span role="status">{saved ? "Saved on this device" : "Could not save — export to keep a copy"}</span>
      <span>{active.text.length.toLocaleString()} characters</span>
    </footer>
  </div>;
}
