import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, executeAiTool, runAiTools } from '../src/ai-tools.ts';
import { addItem, loadItems, productivityKey } from '../src/productivity-store.ts';

let storage;
beforeEach(() => {
  storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } });
  globalThis.window = new EventTarget();
});
const call = (name, args, id = crypto.randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const future = () => new Date(Date.now() + 3600000).toISOString();

test('email tools search, paginate, fetch and return native failures without changing items', async () => {
  const requests = [];
  const invoke = async (command, args) => {
    requests.push({ command, args });
    return command === 'email_search' ? { messages: [{ id: 'abc123' }], nextPageToken: 'next' } : { id: 'abc123', body: 'Your flight departs at 9 AM', unread: true };
  };
  const page = await executeAiTool(call('search_emails', { query: 'subject:flight after:2026/10/01', max_results: 5, page_token: 'next' }), invoke);
  assert.equal(page.ok, true);
  assert.deepEqual(requests[0], { command: 'email_search', args: { query: 'subject:flight after:2026/10/01', maxResults: 5, pageToken: 'next' } });
  const message = await executeAiTool(call('fetch_email', { message_id: page.page.messages[0].id }), invoke);
  assert.equal(message.message.unread, true);
  assert.match(message.message.body, /flight/);
  assert.deepEqual(requests[1], { command: 'email_fetch', args: { messageId: 'abc123' } });
  const failure = await executeAiTool(call('search_emails', { query: '' }), async () => { throw 'Connect a Google account first.'; });
  assert.equal(failure.ok, false);
  assert.match(failure.error, /Connect/);
  assert.deepEqual(loadItems(), { todos: [], reminders: [] });
});

test('invalid email arguments never reach native commands', async () => {
  for (const tool of [
    call('search_emails', {}), call('search_emails', { query: 'x', max_results: 21 }),
    call('search_emails', { query: 'x', max_results: 1.5 }),
    call('search_emails', { query: 'x', page_token: 12 }),
    call('fetch_email', { message_id: '../messages' }), call('fetch_email', {}),
  ]) assert.equal((await executeAiTool(tool, async () => assert.fail('Invalid native call'))).ok, false);
});

test('async email results reach the AI and duplicate IDs reuse the fetched result', async () => {
  let round = 0;
  let executions = 0;
  const tool = call('search_emails', { query: 'is:unread' }, 'search');
  const answer = await runAiTools(async exchanges => {
    if (++round <= 2) return { content: null, tool_calls: [tool] };
    assert.equal(JSON.parse(exchanges[1].content).page.messages[0].subject, 'Flight');
    return { content: 'Found your flight email.' };
  }, () => true, () => assert.fail('Reads have no action receipts'), async tool => {
    executions++;
    return executeAiTool(tool, async () => ({ messages: [{ id: 'abc123', subject: 'Flight' }] }));
  });
  assert.equal(executions, 1);
  assert.equal(answer, 'Found your flight email.');
});

test('AI items share the panel store, preserve existing items, and support edit/complete/delete', () => {
  addItem('todos', 'Existing panel todo');
  const created = executeTool(call('create_reminder', { title: ' Call home ', due: future() }));
  assert.equal(created.ok, true);
  assert.equal(loadItems().reminders[0].title, 'Call home');
  const todo = executeTool(call('create_todo', { title: 'Buy milk' })).item;
  assert.equal(loadItems().todos.length, 2);
  const updated = executeTool(call('update_item', { kind: 'todos', id: todo.id, title: 'Buy oat milk', done: true }));
  assert.equal(updated.item.done, true);
  assert.equal(updated.item.title, 'Buy oat milk');
  assert.equal(executeTool(call('list_items', { kind: 'reminders' })).items[0].id, created.item.id);
  assert.equal(executeTool(call('delete_item', { kind: 'reminders', id: created.item.id })).ok, true);
  assert.equal(loadItems().reminders.length, 0);
  assert.equal(loadItems().todos[0].title, 'Existing panel todo');
});

test('invalid dates, missing times, bad titles, unknown tools and unknown IDs do not mutate data', () => {
  for (const tool of [
    call('create_reminder', { title: 'Missing time' }),
    call('create_reminder', { title: 'Past', due: '2020-01-01T09:00:00Z' }),
    call('create_reminder', { title: 'No offset', due: '2099-01-01T09:00:00' }),
    call('create_todo', { title: ' ' }),
    call('create_todo', { title: 'a'.repeat(301) }),
    call('delete_item', { kind: 'todos', id: 'missing' }),
    call('update_item', { kind: 'todos', id: 'missing', done: 'yes' }),
    call('send_email', {}),
    { ...call('create_todo', {}), function: { name: 'create_todo', arguments: '{bad' } },
  ]) assert.equal(executeTool(tool).ok, false);
  assert.deepEqual(loadItems(), { todos: [], reminders: [] });
});

test('storage failures return tool errors and corrupted data is not overwritten', () => {
  localStorage.setItem = () => { throw new Error('Storage full'); };
  assert.equal(executeTool(call('create_todo', { title: 'Not saved' })).ok, false);
  storage.set(productivityKey, 'broken data');
  assert.equal(executeTool(call('create_todo', { title: 'Not saved' })).ok, false);
  assert.equal(storage.get(productivityKey), 'broken data');
});

test('tool results reach the model and repeated tool IDs do not create duplicates', async () => {
  const tool = call('create_todo', { title: 'A single todo' }, 'same-call');
  const progress = [];
  let round = 0;
  const answer = await runAiTools(async exchanges => {
    round++;
    if (round < 3) return { content: null, tool_calls: [tool] };
    assert.equal(exchanges[1].role, 'tool');
    assert.equal(JSON.parse(exchanges[1].content).ok, true);
    assert.equal(exchanges.length, 4);
    return { content: 'Done.' };
  }, () => true, receipts => progress.push(receipts));
  assert.equal(loadItems().todos.length, 1);
  assert.equal(progress.length, 1);
  assert.match(answer, /Created todo: A single todo/);
});

test('cancellation before the model returns prevents tool execution', async () => {
  const result = await runAiTools(async () => ({ content: null, tool_calls: [call('create_todo', { title: 'Cancelled' })] }), () => false, () => assert.fail());
  assert.equal(result, null);
  assert.equal(loadItems().todos.length, 0);
});

test('saved action receipts survive a failed follow-up request', async () => {
  let round = 0;
  let savedReceipts;
  const answer = await runAiTools(async () => {
    if (++round === 1) return { content: null, tool_calls: [call('create_reminder', { title: 'Saved reminder', due: future() })] };
    throw new Error('Network unavailable');
  }, () => true, receipts => { savedReceipts = receipts; });
  assert.equal(loadItems().reminders.length, 1);
  assert.match(savedReceipts[0], /Created reminder: Saved reminder/);
  assert.match(answer, /Network unavailable/);
});

test('tool loops stop at the limit and retain already saved actions', async () => {
  let round = 0;
  const answer = await runAiTools(async () => ({ content: null, tool_calls: [call('create_todo', { title: `Todo ${++round}` })] }), () => true, () => {});
  assert.equal(round, 6);
  assert.equal(loadItems().todos.length, 6);
  assert.match(answer, /action limit/);
});

test('progress reports readable tool stages, counts and subjects without raw output or duplicates', async () => {
  const progress = [];
  const search = call('search_emails', { query: 'private-query' }, 'search');
  const fetch = call('fetch_email', { message_id: 'abc123' }, 'read');
  let round = 0;
  await runAiTools(async () => {
    if (++round <= 2) return { content: null, tool_calls: [search] };
    if (round === 3) return { content: null, tool_calls: [fetch] };
    return { content: 'Here is the answer.' };
  }, () => true, () => {}, async tool => tool.function.name === 'search_emails'
    ? { ok: true, page: { messages: [{ id: 'abc123' }], nextPageToken: 'private-token' } }
    : { ok: true, message: { subject: 'Your card statement', body: 'private-body', bodyTruncated: true } },
  event => progress.push(event));
  assert.equal(progress[0].phase, 'thinking');
  const running = progress.find(event => event.activities[0]?.status === 'running');
  assert.equal(running.activities[0].label, 'Searching emails');
  assert.equal(running.activities[0].status, 'running', 'previous snapshots are immutable');
  const last = progress.at(-1);
  assert.equal(last.phase, 'reviewing');
  assert.equal(last.activities.length, 2);
  assert.equal(last.activities[0].detail, 'Found 1 email · More results available');
  assert.equal(last.activities[1].detail, 'Your card statement · Long message, read in part');
  assert.equal(last.activities[1].status, 'complete');
  assert.doesNotMatch(JSON.stringify(progress), /private-query|private-token|private-body|abc123/);
});

test('progress marks returned and unexpected tool errors as failed', async () => {
  for (const unexpected of [false, true]) {
    const progress = [];
    const run = runAiTools(async () => ({ content: null, tool_calls: [call('fetch_email', { message_id: 'abc123' })] }),
      () => true, () => {}, async () => {
        if (unexpected) throw new Error('Backend unavailable');
        return { ok: false, error: 'Backend unavailable' };
      }, event => progress.push(event));
    if (unexpected) await assert.rejects(run, /Backend unavailable/); else await run;
    assert.equal(progress.at(-1).activities.at(-1).status, 'error');
    assert.doesNotMatch(JSON.stringify(progress), /Backend unavailable/);
  }
});
