import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';
import * as search from '../src/launcher-search.ts';
import { runAiTools, executeAiTool } from '../src/ai-tools.ts';

const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Render the real launcher with a desktop bridge double and deferred AI requests.
async function launcher(t, shadcnCommand = false, deferEmails = false, pinFixtures = false) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Map();
  const requests = [], saves = [], resized = [], focus = [], emails = [];
  const resourcePins = [], clipPins = [], commands = [];
  const nodes = new Map();
  const chats = [
    { id: 'first', title: 'Flight plans', updatedAt: 10 },
    { id: 'second', title: 'Weekend plans', updatedAt: 5 },
    { id: 'third', title: 'Work notes', updatedAt: 1 },
  ];
  let closed = 0;
  const invoke = async (command, args) => {
    commands.push(command);
    if (command === 'launcher_ai') {
      const pending = deferred();
      requests.push({ args, ...pending });
      return pending.promise;
    }
    if (command === 'ai_save_chat') { saves.push(structuredClone(args)); return; }
    if (command === 'close_launcher') { closed++; return; }
    if (command === 'launcher_ready') return 'apps';
    if (command === 'launcher_preferences') return { ctrlSpace: true, clipboard: true, shadcnCommand };
    if (command === 'launcher_set_expanded') { resized.push(args.expanded); return args.expanded; }
    if (command === 'ai_list_chats') return chats;
    if (command === 'ai_load_chat') return [{ role: 'user', content: args.id }, { role: 'assistant', content: `Saved answer ${args.id}` }];
    if (command === 'launcher_apps') return [];
    if (command === 'clipboard_entries') return { entries: pinFixtures ? [{ id: 7, kind: 'text', text: 'Keep the full clipboard text', width: 0, height: 0 }] : [], total: pinFixtures ? 1 : 0, hasMore: false };
    if (command === 'search_files') return [{ name: 'Project', path: 'C:\\Project', isDir: true }];
    if (deferEmails && (command === 'email_search' || command === 'email_fetch')) {
      const pending = deferred(); emails.push({ command, ...pending }); return pending.promise;
    }
    if (command === 'email_search') return { messages: [{ id: 'abc123', subject: 'Flight booking' }] };
    throw new Error(`Unexpected command ${command}`);
  };
  const output = ts.transpileModule(readFileSync(new URL('../src/Launcher.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const passThrough = ({ children }) => children ?? null;
  const mockedRequire = name => {
    if (name === '@tauri-apps/api/core') return { invoke, isTauri: () => true };
    if (name === '@tauri-apps/api/event') return { listen: async (event, callback) => {
      listeners.set(event, callback);
      return () => listeners.delete(event);
    } };
    if (name === './home-shortcuts') return { useHomeShortcuts: () => ({ pins: [], saving: false }) };
    if (name === './launcher-search') return search;
    if (name === './AiMarkdown') return { AiMarkdown: passThrough };
    if (name === './ai-tools') return { runAiTools: (request, active, receipts, _execute, progress) => runAiTools(request, active, receipts, call => executeAiTool(call, invoke), progress) };
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => () => null });
    if (name === 'radix-ui') return { AlertDialog: new Proxy({}, { get: () => passThrough }) };
    if (name === '@/components/ui/command') return {
      Command: ({children}) => React.createElement('div', null, children),
      CommandInput: props => React.createElement('input', { ...props, onChange: event => props.onValueChange(event.target.value) }),
      CommandList: props => React.createElement('div', props),
      CommandItem: props => React.createElement('div', props),
    };
    if (name === '@/components/ui/switch') return { Switch: passThrough };
    if (name === '@/components/ui/button') return { Button: props => React.createElement('button', props) };
    if (name === '@/components/ui/input') return { Input: props => React.createElement('input', props) };
    if (name === './Theme') return { useTheme() {} };
    if (name === './platform') return { isLinux: false };
    if (name === './workspace-store') return { useSpaces: () => ({ state: { activeId: 'default', spaces: [{ id: 'default', name: 'Personal' }] }, space: { id: 'default', name: 'Personal', resources: [] }, error: '', update() {} }), pinResource: (resource, spaceId) => resourcePins.push({ resource, spaceId }) };
    if (name === './WorkspaceApps') return { pinClip: (clip, spaceId) => clipPins.push({ clip, spaceId }) };
    if (name === './WorkspaceDialogs') return { QuickCapture: passThrough };
    if (name.endsWith('.css')) return {};
    return require(name);
  };
  runInNewContext(output, {
    exports: module.exports, module, require: mockedRequire, crypto,
    document: { documentElement: { classList: { add() {}, remove() {} } } },
    window: { setTimeout, clearTimeout },
  });
  let renderer;
  await act(async () => { renderer = create(React.createElement(module.exports.Launcher), { createNodeMock: element => {
    const label = element.props['aria-label'];
    const primaryInput = element.type === 'input' && label !== 'Search saved chats';
    const node = { focus: () => focus.push(primaryInput ? 'Main input' : label), scrollTo() {}, scrollHeight: 100, querySelector: () => null, dataset: {} };
    if (primaryInput) nodes.set('Main input', node);
    if (label) nodes.set(label, node);
    return node;
  } }); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const input = () => renderer.root.findAllByType('input').find(node => node.props['aria-label'] !== 'Search saved chats');
  const button = label => renderer.root.findAllByType('button').find(node => node.props.children === label || node.props['aria-label'] === label);
  return {
    requests, saves, resized, focus, resourcePins, clipPins, commands, get closed() { return closed; },
    text: () => JSON.stringify(renderer.toJSON()),
    draft: () => input().props.value,
    type: value => act(async () => input().props.onChange({ target: { value } })),
    pinSelected: () => act(async () => input().props.onKeyDown({ key: 'Enter', ctrlKey: true, nativeEvent: {}, preventDefault() {}, stopPropagation() {} })),
    filterHistory: value => act(async () => renderer.root.findAllByType('input').find(node => node.props['aria-label'] === 'Search saved chats').props.onChange({ target: { value } })),
    key: (key, modifiers = {}, label) => act(async () => {
      const event = { key, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, nativeEvent: {},
        target: nodes.get(label ?? 'Main input'),
        preventDefault() {}, stopPropagation() { this.stopped = true; }, ...modifiers };
      const main = renderer.root.findByType('main');
      main.props.onKeyDownCapture(event);
      if (!event.stopped) main.props.onKeyDown(event);
    }),
    send: () => act(async () => {
      input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} });
      if (shadcnCommand) renderer.root.findAll(node => typeof node.type === 'string' && node.props.value === 'ai' && node.props.onSelect)[0]?.props.onSelect();
    }),
    close: () => act(async () => renderer.root.findByType('main').props.onKeyDown({ key: 'Escape', preventDefault() {} })),
    reopen: (mode = 'apps') => act(async () => listeners.get('launcher://open')({ payload: mode })),
    click: label => act(async () => button(label).props.onClick()),
    resolve: (index, response) => act(async () => requests[index].resolve(response)),
    resolveEmail: (index, response) => act(async () => emails[index].resolve(response)),
    activityOpen: () => renderer.root.findByType('details').props.open,
  };
}

for (const shadcn of [false, true]) test(`Ctrl+Enter pins file and clipboard results without opening or pasting (${shadcn ? 'shadcn' : 'original'})`, async t => {
  const ui = await launcher(t, shadcn, false, true);
  await ui.reopen('clipboard');
  await act(async () => new Promise(resolve => setTimeout(resolve, 230)));
  await ui.pinSelected();
  assert.equal(ui.clipPins.length, 1);
  assert.equal(ui.clipPins[0].clip.text, 'Keep the full clipboard text');
  assert.equal(ui.clipPins[0].spaceId, 'default');
  await ui.reopen('apps');
  await ui.type('f Project');
  await act(async () => new Promise(resolve => setTimeout(resolve, 230)));
  await ui.pinSelected();
  assert.deepEqual(ui.resourcePins.map(pin => ({ ...pin.resource, spaceId: pin.spaceId })), [{ kind: 'file', title: 'Project', value: 'C:\\Project', spaceId: 'default' }]);
  assert.ok(!ui.commands.includes('paste_clipboard'));
  assert.ok(!ui.commands.includes('open_search_file'));
});

test('closing/reopening preserves a pending tool turn, its final answer and reply draft', async t => {
  const ui = await launcher(t);
  await ui.type('ai find my flight booking');
  await ui.send();
  assert.equal(ui.requests.length, 1);
  await ui.type('And what time does it leave?');
  await ui.close();
  assert.equal(ui.closed, 1);
  await ui.reopen();
  assert.match(ui.text(), /Thinking/);
  assert.equal(ui.draft(), 'And what time does it leave?');
  await ui.close();
  await ui.resolve(0, { content: null, tool_calls: [{ id: 'search', type: 'function', function: { name: 'search_emails', arguments: '{"query":"subject:flight"}' } }] });
  assert.equal(ui.requests.length, 2, 'tool loop continues while hidden');
  assert.match(ui.requests[1].args.exchanges[1].content, /Flight booking/);
  await ui.resolve(1, { content: 'Your flight booking is confirmed.' });
  assert.equal(ui.saves.at(-1).messages.at(-1).content, 'Your flight booking is confirmed.');
  await ui.reopen();
  assert.match(ui.text(), /Your flight booking is confirmed/);
  assert.doesNotMatch(ui.text(), /Thinking/);
  assert.equal(ui.draft(), 'And what time does it leave?');
  assert.equal(ui.requests.length, 2, 'reopening never resubmits the prompt');
});

test('background completion keeps apps navigation intact; Cancel and New chat remain explicit', async t => {
  const ui = await launcher(t);
  await ui.type('ai a question');
  await ui.send();
  await ui.click('Back to apps');
  await ui.type('calculator');
  await ui.resolve(0, { content: 'Background answer' });
  assert.equal(ui.draft(), 'calculator');
  assert.doesNotMatch(ui.text(), /Background answer/);
  await ui.type('ai');
  assert.match(ui.text(), /Background answer/);
  await ui.type('ai next question');
  await ui.send();
  await ui.click('Cancel');
  await ui.resolve(1, { content: 'Cancelled answer' });
  assert.doesNotMatch(ui.text(), /Cancelled answer/);
  assert.equal(ui.saves.length, 1);
  await ui.click('New chat');
  assert.doesNotMatch(ui.text(), /Background answer/);
});

for (const shadcn of [false, true]) test(`AI keyboard workflow works with ${shadcn ? 'shadcn' : 'original'} menu`, async t => {
  const ui = await launcher(t, shadcn);
  await ui.type('ai');
  await ui.key('h', { ctrlKey: true });
  assert.equal(ui.focus.at(-1), 'Search saved chats');
  assert.match(ui.text(), /Flight plans/);
  await ui.key('ArrowDown', {}, 'Search saved chats');
  await ui.key('Enter', {}, 'Search saved chats');
  assert.match(ui.text(), /Saved answer second/);
  assert.equal(ui.focus.at(-1), 'Main input');
  await ui.key('j', { ctrlKey: true });
  assert.equal(ui.focus.at(-1), 'Conversation');
  await ui.key('l', { ctrlKey: true });
  assert.equal(ui.focus.at(-1), 'Main input');
  await ui.type('Follow-up question');
  await ui.send();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].args.history.at(-1).content, 'Saved answer second');
  // Shortcuts match disabled buttons while a turn is pending; never silently cancel it.
  await ui.key('n', { ctrlKey: true });
  await ui.key('h', { ctrlKey: true });
  assert.match(ui.text(), /Thinking/);
  await ui.key('F', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(ui.resized, [true]);
  await ui.close(); await ui.reopen();
  assert.match(ui.text(), /Compact/);
  await ui.key('F', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(ui.resized, [true, false]);
  await ui.key('X', { ctrlKey: true, shiftKey: true });
  await ui.resolve(0, { content: 'Stopped response' });
  assert.doesNotMatch(ui.text(), /Stopped response/);
  await ui.key('n', { ctrlKey: true });
  assert.doesNotMatch(ui.text(), /Saved answer second/);
});

test('history filtering, empty results and Escape preserve the reply draft', async t => {
  const ui = await launcher(t);
  await ui.type('ai');
  await ui.key('h', { ctrlKey: true });
  await ui.filterHistory('work');
  assert.doesNotMatch(ui.text(), /Flight plans/);
  await ui.key('Enter', {}, 'Search saved chats');
  assert.match(ui.text(), /Saved answer third/);
  await ui.type('Draft to preserve');
  await ui.key('h', { ctrlKey: true });
  await ui.filterHistory('no match');
  assert.match(ui.text(), /No matching chats/);
  await ui.key('ArrowDown', {}, 'Search saved chats');
  await ui.key('Enter', {}, 'Search saved chats');
  assert.equal(ui.requests.length, 0);
  await ui.key('Escape', {}, 'Search saved chats');
  assert.equal(ui.closed, 0);
  assert.equal(ui.draft(), 'Draft to preserve');
  assert.equal(ui.focus.at(-1), 'Main input');
  await ui.key('h', { ctrlKey: true });
  await ui.key('ArrowUp', {}, 'Search saved chats');
  await ui.key('Enter', {}, 'Search saved chats');
  assert.match(ui.text(), /Saved answer third/);
});

test('chat shows running tools and readable results, keeps activity on reopen, and collapses on completion', async t => {
  const ui = await launcher(t, false, true);
  await ui.type('ai find my card statement'); await ui.send();
  await ui.resolve(0, { content: null, tool_calls: [{ id: 'lookup', type: 'function', function: { name: 'search_emails', arguments: '{"query":"subject:statement"}' } }] });
  assert.match(ui.text(), /Searching emails/);
  assert.match(ui.text(), /Looking through your connected mailbox/);
  assert.equal(ui.activityOpen(), true);
  await ui.close(); await ui.reopen();
  assert.match(ui.text(), /Searching emails/);
  await ui.resolveEmail(0, { messages: [{ id: 'abc123' }], nextPageToken: 'secret-pagination-token' });
  assert.match(ui.text(), /Found 1 email/);
  assert.match(ui.text(), /More results available/);
  assert.match(ui.text(), /Reviewing results/);
  await ui.resolve(1, { content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'fetch_email', arguments: '{"message_id":"abc123"}' } }] });
  assert.match(ui.text(), /Reading an email/);
  await ui.resolveEmail(1, { subject: 'October card statement', body: 'private-message-body' });
  assert.match(ui.text(), /October card statement/);
  assert.doesNotMatch(ui.text(), /secret-pagination-token|private-message-body|abc123|search_emails|fetch_email/);
  await ui.resolve(2, { content: 'Your statement is ready.' });
  assert.equal(ui.activityOpen(), false);
  assert.match(ui.text(), /Your statement is ready/);
  await ui.click('New chat');
  assert.doesNotMatch(ui.text(), /October card statement|Searching emails/);
});

test('cancelling a tool shows Stopped and ignores its late progress', async t => {
  const ui = await launcher(t, false, true);
  await ui.type('ai find an email'); await ui.send();
  await ui.resolve(0, { content: null, tool_calls: [{ id: 'lookup', type: 'function', function: { name: 'search_emails', arguments: '{"query":""}' } }] });
  await ui.click('Cancel');
  assert.match(ui.text(), /Stopped waiting for this step/);
  assert.equal(ui.activityOpen(), false);
  await ui.resolveEmail(0, { messages: [] });
  assert.doesNotMatch(ui.text(), /No matching emails|Reviewing results/);
});
