import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, runAiTools } from '../src/ai-tools.ts';
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
