import { addItem, changeItem, loadItems, removeItem, type ItemKind } from "./productivity-store.ts";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type AiResponse = { content: string | null; tool_calls?: ToolCall[] };
export type ToolMessage = { role: "assistant"; content: string | null; tool_calls: ToolCall[] } |
  { role: "tool"; tool_call_id: string; content: string };
export type ToolResult = { ok: boolean; summary?: string; error?: string; [key: string]: unknown };
export type ToolActivity = { id: string; label: string; detail: string; status: "running" | "complete" | "error" | "stopped" };
export type AiProgress = { phase: "thinking" | "tools" | "reviewing"; activities: ToolActivity[] };

const activityLabels: Record<string, [string, string]> = {
  search_emails: ["Searching emails", "Looking through your connected mailbox"],
  fetch_email: ["Reading an email", "Opening the message to read its contents"],
  list_items: ["Checking your lists", "Looking up saved todos and reminders"],
  create_todo: ["Adding a todo", "Saving it to your Todos panel"],
  create_reminder: ["Setting a reminder", "Saving the reminder and its scheduled time"],
  update_item: ["Updating an item", "Saving changes to your list"],
  delete_item: ["Deleting an item", "Removing the requested item from your list"],
};

function activityDetail(name: string, result: ToolResult): string {
  if (!result.ok) return "This step failed. See the error in the conversation.";
  if (name === "search_emails") {
    const page = result.page as { messages?: unknown[]; nextPageToken?: string } | undefined;
    const count = page?.messages?.length ?? 0;
    return `${count === 0 ? "No matching emails" : `Found ${count} email${count === 1 ? "" : "s"}`}${page?.nextPageToken ? " · More results available" : ""}`;
  }
  if (name === "fetch_email") {
    const message = result.message as { subject?: string; bodyTruncated?: boolean } | undefined;
    const subject = typeof message?.subject === "string" ? message.subject.replace(/\s+/g, " ").trim().slice(0, 160) : "Message read";
    return `${subject || "Message read"}${message?.bodyTruncated ? " · Long message, read in part" : ""}`;
  }
  if (name === "list_items") {
    const items = result.items as { todos?: unknown[]; reminders?: unknown[] } | unknown[] | undefined;
    const count = Array.isArray(items) ? items.length : (items?.todos?.length ?? 0) + (items?.reminders?.length ?? 0);
    return `Found ${count} saved item${count === 1 ? "" : "s"}`;
  }
  return "Changes saved";
}

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

type NativeInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export async function executeAiTool(call: ToolCall, invoke: NativeInvoke = nativeInvoke): Promise<ToolResult> {
  const name = call.function.name;
  if (name !== "search_emails" && name !== "fetch_email") return executeTool(call);
  try {
    const args = JSON.parse(call.function.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected an object of tool arguments.");
    if (name === "search_emails") {
      if (typeof args.query !== "string" || args.query.length > 2000) throw new Error("Provide a Gmail search query of at most 2000 characters (empty for recent mail).");
      if (args.page_token !== undefined && (typeof args.page_token !== "string" || args.page_token.length > 2000)) throw new Error("Invalid search page token.");
      if (args.max_results !== undefined && (!Number.isInteger(args.max_results) || args.max_results < 1 || args.max_results > 20)) throw new Error("max_results must be an integer from 1 to 20.");
      const page = await invoke("email_search", { query: args.query, pageToken: args.page_token ?? null, maxResults: args.max_results ?? 10 });
      return { ok: true, page };
    }
    if (typeof args.message_id !== "string" || !/^[a-fA-F0-9]{1,128}$/.test(args.message_id)) throw new Error("Use a message ID returned by search_emails.");
    const message = await invoke("email_fetch", { messageId: args.message_id });
    return { ok: true, message };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Only the current turn's exchanges are replayed; saved chats never re-run actions.
export async function runAiTools(
  request: (exchanges: ToolMessage[]) => Promise<AiResponse>,
  active: () => boolean,
  onActions: (receipts: string[]) => void,
  execute: (call: ToolCall) => ToolResult | Promise<ToolResult> = executeAiTool,
  onProgress: (progress: AiProgress) => void = () => {},
): Promise<string | null> {
  const exchanges: ToolMessage[] = [];
  const receipts: string[] = [];
  const results = new Map<string, { call: string; result: ToolResult }>();
  const activities: ToolActivity[] = [];
  const progress = (phase: AiProgress["phase"]) => {
    if (active()) onProgress({ phase, activities: activities.map(activity => ({ ...activity })) });
  };
  try {
    for (let round = 0; round < 6; round++) {
      progress(exchanges.length ? "reviewing" : "thinking");
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
        let activity: ToolActivity | undefined;
        if (!previous) {
          const [label, detail] = activityLabels[call.function.name] ?? ["Running a requested action", "Checking the requested operation"];
          activity = { id: call.id, label, detail, status: "running" };
          activities.push(activity);
          progress("tools");
        }
        const result = previous
          ? previous.call === signature ? previous.result : { ok: false, error: "Tool call ID was reused with different arguments." }
          : await execute(call);
        if (activity) {
          activity.status = result.ok ? "complete" : "error";
          activity.detail = activityDetail(call.function.name, result);
          progress("tools");
        }
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
    activities.filter(activity => activity.status === "running").forEach(activity => {
      activity.status = "error"; activity.detail = "This step could not finish.";
    });
    progress("reviewing");
    // A network failure must never hide actions already saved to the app.
    if (receipts.length) return [...receipts, `AI stopped: ${error instanceof Error ? error.message : String(error)}`].join("\n\n");
    throw error;
  }
}
