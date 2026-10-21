type WindowIdentity = { id: string; pid: number };
const key = (window: WindowIdentity) => window.id + ":" + window.pid;

// EnumWindows follows stacking order, which changes every time an app is focused.
// Keep surviving entries in their existing slots and append newly opened windows.
export function reconcileWindows<T extends WindowIdentity>(previous: T[], incoming: T[]): T[] {
  const remaining = new Map(incoming.map(window => [key(window), window]));
  const ordered: T[] = [];
  for (const window of previous) {
    const current = remaining.get(key(window));
    if (current) { ordered.push(current); remaining.delete(key(window)); }
  }
  return ordered.concat([...remaining.values()]);
}
