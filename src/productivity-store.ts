export type Item = { id: string; title: string; done: boolean; due?: string; notified?: boolean };
export type Items = { todos: Item[]; reminders: Item[] };
export type ItemKind = keyof Items;
export const productivityKey = "wallp.productivity";
export const productivityChanged = "wallp:productivity-changed";

export function loadItems(): Items {
  const raw = localStorage.getItem(productivityKey);
  if (!raw) return { todos: [], reminders: [] };
  const value = JSON.parse(raw);
  if (!value || ![value.todos, value.reminders].every(list => Array.isArray(list) && list.every(item =>
    item && typeof item.id === "string" && typeof item.title === "string" && typeof item.done === "boolean" &&
    (item.due === undefined || (typeof item.due === "string" && Number.isFinite(Date.parse(item.due))))))) {
    throw new Error("Saved reminders and todos could not be read.");
  }
  return value;
}

// Read at mutation time so the launcher and workspace never write stale React state.
export function mutateItems(change: (items: Items) => Items): Items {
  const items = change(loadItems());
  localStorage.setItem(productivityKey, JSON.stringify(items));
  window.dispatchEvent(new Event(productivityChanged));
  return items;
}

export function addItem(kind: ItemKind, title: string, due?: string): Item {
  const item: Item = { id: crypto.randomUUID(), title, done: false, ...(due ? { due } : {}) };
  mutateItems(items => ({ ...items, [kind]: [...items[kind], item] }));
  return item;
}

export function changeItem(kind: ItemKind, id: string, patch: Partial<Omit<Item, "id">>): Item {
  let updated: Item | undefined;
  mutateItems(items => {
    if (!items[kind].some(item => item.id === id)) throw new Error("Item not found. List items again to get its current ID.");
    return { ...items, [kind]: items[kind].map(item => item.id === id ? (updated = { ...item, ...patch }) : item) };
  });
  return updated!;
}

export function removeItem(kind: ItemKind, id: string): void {
  mutateItems(items => {
    if (!items[kind].some(item => item.id === id)) throw new Error("Item not found. List items again to get its current ID.");
    return { ...items, [kind]: items[kind].filter(item => item.id !== id) };
  });
}
