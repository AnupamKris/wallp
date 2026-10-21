import { useEffect, useState } from "react";
import { BellIcon, CheckSquareIcon, TrashIcon } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { addItem, changeItem, loadItems, productivityChanged, productivityKey, removeItem, type Item, type Items } from "./productivity-store";

function load(): Items {
  try { return loadItems(); } catch { /* Keep the panel usable if storage is unavailable. */ }
  return { todos: [], reminders: [] };
}
export function useProductivity() {
  const [items, setItems] = useState(load);
  const [saved, setSaved] = useState(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const refresh = () => { try { setItems(loadItems()); setSaved(true); } catch { setSaved(false); } };
    const storage = (event: StorageEvent) => { if (event.key === productivityKey || event.key === null) refresh(); };
    window.addEventListener(productivityChanged, refresh);
    window.addEventListener("storage", storage);
    refresh();
    return () => { window.removeEventListener(productivityChanged, refresh); window.removeEventListener("storage", storage); };
  }, []);
  const alerts = items.reminders.filter(item => !item.done && !item.notified && item.due && Date.parse(item.due) <= now);
  function save(action: () => unknown) { try { action(); setSaved(true); } catch { setSaved(false); } }
  function change(kind: keyof Items, id: string, patch: Partial<Item>) { save(() => changeItem(kind, id, patch)); }
  return { items, saved, alerts, change,
    add: (kind: keyof Items, title: string, due?: string) => save(() => addItem(kind, title, due)),
    remove: (kind: keyof Items, id: string) => save(() => removeItem(kind, id)),
    dismiss: (id: string) => change("reminders", id, { notified: true }),
    snooze: (id: string) => change("reminders", id, { due: new Date(Date.now() + 300000).toISOString(), notified: false }),
  };
}
type Data = ReturnType<typeof useProductivity>;
export function Productivity({ kind, data }: { kind: "todos" | "reminders"; data: Data }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [filter, setFilter] = useState("active");
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDue, setEditDue] = useState("");
  const reminder = kind === "reminders"; const listKind: keyof Items = reminder ? "reminders" : "todos";
  const combined = [
    ...data.items.todos.map(item => ({ ...item, source: "todos" as const })),
    ...data.items.reminders.map(item => ({ ...item, source: "reminders" as const })),
  ];
  const items = reminder ? combined.filter(item => item.source === "reminders") : combined;
  const list = items.filter(item => filter === "all" || item.done === (filter === "completed"));
  const pending = items.filter(item => !item.done).length;
  return <div className="productivity">
    <div className="list-heading"><span>{`${pending} ${reminder ? "upcoming" : "remaining"}`}</span><select aria-label={`Filter ${kind}`} value={filter} onChange={e => setFilter(e.target.value)}><option value="active">Active</option><option value="completed">Completed</option><option value="all">All</option></select></div>
    <form className="item-form" onSubmit={e => { e.preventDefault(); if (!title.trim()) return; data.add(listKind, title.trim(), reminder ? new Date(due).toISOString() : undefined); setTitle(""); setDue(""); setFilter("active"); }}>
      <input aria-label={reminder ? "Reminder title" : "New todo"} placeholder={reminder ? "Remind me to…" : "What needs doing?"} value={title} maxLength={300} required onChange={e => setTitle(e.target.value)} />
      {reminder && <label className="due-field">When<input aria-label="Reminder date and time" type="datetime-local" required value={due} onChange={e => setDue(e.target.value)} /></label>}
      <Button type="submit" disabled={!title.trim() || (reminder && !due)}>Add {reminder ? "reminder" : "todo"}</Button>
    </form>
    <div className="item-list">{list.map(item => <div className={`todo-row${item.done ? " todo-done" : ""}`} key={`${item.source}:${item.id}`}>
      <input type="checkbox" aria-label={`Complete ${item.title}`} checked={item.done} onChange={() => data.change(item.source, item.id, { done: !item.done })} />
      {editing === `${item.source}:${item.id}` ? <form className="edit-item" onSubmit={e => { e.preventDefault(); if (editTitle.trim()) { data.change(item.source, item.id, { title: editTitle.trim(), ...(item.source === "reminders" ? { due: new Date(editDue).toISOString(), notified: false } : {}) }); setEditing(null); } }}><input autoFocus aria-label="Edit title" value={editTitle} required maxLength={300} onChange={e => setEditTitle(e.target.value)} />{item.source === "reminders" && <input aria-label="Edit reminder time" type="datetime-local" required value={editDue} onChange={e => setEditDue(e.target.value)} />}<div><Button type="submit">Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div></form>
      : <button className="todo-content" title="Click to edit" onClick={() => { setEditing(`${item.source}:${item.id}`); setEditTitle(item.title); const date = item.due ? new Date(item.due) : null; setEditDue(date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""); }}><span>{item.title}</span>{item.due && <small className={!item.done && Date.parse(item.due) <= Date.now() ? "overdue" : ""}>{new Date(item.due).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}{item.notified && !item.done ? " · Dismissed" : ""}</small>}{!reminder && item.source === "reminders" && <small>Reminder</small>}</button>}
      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${item.title}`} onClick={() => data.remove(item.source, item.id)}><TrashIcon /></Button>
    </div>)}</div>
    {!list.length && <div className="panel-empty">{reminder ? <BellIcon size={28} weight="light" /> : <CheckSquareIcon size={28} weight="light" />}<p>{filter === "completed" ? "No completed items yet." : "All clear."}</p><small>{reminder ? "Give your next reminder a time above." : "A little space for what’s next."}</small></div>}
    {!data.saved && <p role="status" className="storage-warning">Changes could not be saved on this device.</p>}
    {kind === "reminders" && <p className="reminder-note">Reminders alert while wallp is running. Missed reminders appear when you reopen it.</p>}
  </div>;
}
export function ReminderAlerts({ data }: { data: Data }) {
  return createPortal(<aside className="reminder-alerts" aria-label="Due reminders">{data.alerts.map(item => <div key={item.id} role="alert"><BellIcon size={20} /><div><small>REMINDER</small><p>{item.title}</p><Button variant="ghost" onClick={() => data.snooze(item.id)}>Snooze 5 min</Button><Button variant="ghost" onClick={() => data.dismiss(item.id)}>Dismiss</Button></div></div>)}</aside>, document.body);
}

