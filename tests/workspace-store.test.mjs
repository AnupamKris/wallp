import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addSpace, loadSpaces, mutateSpaces, noteKey, pinResource, workspaceKey } from '../src/workspace-store.ts';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
globalThis.window = new EventTarget();
beforeEach(() => storage.clear());

test('first workspace migrates the existing layout and preserves the original note key', () => {
  localStorage.setItem('wallp.scrolling-layout.v1', JSON.stringify({ open: ['notes', 'todos'], widths: { emails: 66, reminders: 50, todos: 33, notes: 100 } }));
  const state = loadSpaces();
  assert.deepEqual(state.spaces[0].layout.open, ['notes', 'todos']);
  assert.equal(state.spaces[0].layout.widths.todos, 33);
  assert.equal(state.spaces[0].layout.widths.files, 50);
  assert.equal(noteKey('default'), 'wallp.notes.tabs');
});

test('spaces keep independent pins, notes keys, and layouts across reloads', () => {
  pinResource({ kind: 'file', title: 'Project', value: 'C:\\Project' });
  const id = addSpace('Coding');
  pinResource({ kind: 'link', title: 'Docs', value: 'https://example.com', tags: 'reference' }, id);
  mutateSpaces(state => ({ ...state, spaces: state.spaces.map(s => s.id !== id ? s : { ...s, layout: { ...s.layout, open: ['files'], stacks: [['files']] } }) }));
  const state = loadSpaces();
  assert.equal(state.activeId, id);
  assert.equal(state.spaces[0].resources[0].kind, 'file');
  assert.equal(state.spaces[1].resources.length, 1);
  assert.equal(state.spaces[1].resources[0].tags, 'reference');
  assert.deepEqual(state.spaces[1].layout.open, ['files']);
  assert.notEqual(noteKey(id), noteKey('default'));
});

test('pinning the same resource replaces only that workspace pin', () => {
  pinResource({ kind: 'text', title: 'First', value: 'Copied text', clipId: 4 });
  pinResource({ kind: 'text', title: 'Renamed', value: 'Copied text', clipId: 4 });
  assert.equal(loadSpaces().spaces[0].resources.length, 1);
  assert.equal(loadSpaces().spaces[0].resources[0].title, 'Renamed');
});

test('corrupt workspace data is reported and never overwritten by a mutation', () => {
  localStorage.setItem(workspaceKey, '{broken');
  assert.throws(() => pinResource({ kind: 'link', title: 'Docs', value: 'https://example.com' }));
  assert.equal(localStorage.getItem(workspaceKey), '{broken');
});
