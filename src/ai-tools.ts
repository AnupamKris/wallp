import { addItem, changeItem, loadItems, removeItem, type ItemKind } from "./productivity-store.ts";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type AiResponse = { content: string | null; tool_calls?: ToolCall[] };
export type ToolMessage = { role: "assistant"; content: string | null; tool_calls: ToolCall[] } |
  { role: "tool"; tool_call_id: string; content: string };
export type ToolResult = { ok: boolean; summary?: string; error?: string; [key: string]: unknown };

function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 300) throw new Error("Title must contain 1 to 300 characters.");
  return value.trim();
}

function due(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Reminder time must be an ISO 8601 date with an explicit timezone offset.");
  }
  if (Date.parse(value) <= Date.now()) throw new Error("Choose a reminder time in the future.");
  return new Date(value).toISOString();
}

export function executeTool(call: ToolCall): ToolResult {
  try {
    const args = JSON.parse(call.function.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected an object of tool arguments.");
    const name = call.function.name;
    if (name === "list_items") {
      const items = loadItems();
      if (args.kind !== undefined && args.kind !== "todos" && args.kind !== "reminders") throw new Error("Invalid item kind.");
      return { ok: true, items: args.kind ? items[args.kind as ItemKind] : items };
    }
    if (!["create_reminder", "create_todo", "update_item", "delete_item"].includes(name)) throw new Error(`Unknown tool: ${name}`);
    if (name === "create_reminder" || name === "create_todo") {
      const kind = name === "create_reminder" ? "reminders" : "todos";
      const item = addItem(kind, title(args.title), kind === "reminders" ? due(args.due) : undefined);
      return { ok: true, item, summary: `Created ${kind === "reminders" ? "reminder" : "todo"}: ${item.title}${item.due ? ` — ${new Date(item.due).toLocaleString()}` : ""}.` };
    }
    if (args.kind !== "todos" && args.kind !== "reminders") throw new Error("Specify todos or reminders.");
    if (typeof args.id !== "string" || !args.id) throw new Error("List items first and use an existing item ID.");
    const kind: ItemKind = args.kind;
    if (name === "delete_item") {
      const item = loadItems()[kind].find(item => item.id === args.id);
      removeItem(kind, args.id);
      return { ok: true, summary: `Deleted ${kind === "reminders" ? "reminder" : "todo"}: ${item!.title}.` };
    }
    const patch: { title?: string; due?: string; done?: boolean; notified?: boolean } = {};
    if (args.title !== undefined) patch.title = title(args.title);
    if (args.due !== undefined) {
      if (kind !== "reminders") throw new Error("Only reminders have a scheduled time.");
      patch.due = due(args.due); patch.notified = false;
    }
    if (args.done !== undefined) {
      if (typeof args.done !== "boolean") throw new Error("done must be true or false.");
      patch.done = args.done;
    }
    if (!Object.keys(patch).length) throw new Error("Specify a title, reminder time, or completion status to update.");
    const item = changeItem(kind, args.id, patch);
    return { ok: true, item, summary: `Updated ${kind === "reminders" ? "reminder" : "todo"}: ${item.title}${item.done ? " (completed)" : ""}${item.due ? ` — ${new Date(item.due).toLocaleString()}` : ""}.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save changes on this device." };
  }
}

// Only the current turn's exchanges are replayed; saved chats never re-run actions.
export async function runAiTools(
  request: (exchanges: ToolMessage[]) => Promise<AiResponse>,
  active: () => boolean,
  onActions: (receipts: string[]) => void,
): Promise<string | null> {
  const exchanges: ToolMessage[] = [];
  const receipts: string[] = [];
  const results = new Map<string, { call: string; result: ToolResult }>();
  try {
    for (let round = 0; round < 6; round++) {
      const response = await request(exchanges);
      if (!active()) return null;
      const calls = response.tool_calls ?? [];
      if (!calls.length) {
        if (!response.content?.trim()) throw new Error("Agnes returned an empty answer. Please retry.");
        return [...receipts, response.content.trim()].join("\n\n");
      }
      if (calls.length > 12) throw new Error("AI requested too many actions at once. Ask for fewer items.");
      exchanges.push({ role: "assistant", content: response.content, tool_calls: calls });
      for (const call of calls) {
        if (!active()) return null;
        const signature = JSON.stringify(call.function);
        const previous = results.get(call.id);
        const result = previous
          ? previous.call === signature ? previous.result : { ok: false, error: "Tool call ID was reused with different arguments." }
          : executeTool(call);
        if (!previous) {
          results.set(call.id, { call: signature, result });
          if (result.summary) receipts.push(result.summary);
          else if (!result.ok) receipts.push(`Action failed: ${result.error}`);
          // Save successful side effects before any further network request or cancellation.
          if (receipts.length) onActions([...receipts]);
        }
        exchanges.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("AI reached the action limit. Review the saved changes before asking for more.");
  } catch (error) {
    // A network failure must never hide actions already saved to the app.
    if (receipts.length) return [...receipts, `AI stopped: ${error instanceof Error ? error.message : String(error)}`].join("\n\n");
    throw error;
  }
}
