import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileWindows } from '../src/dock-windows.ts';

test('focusing a window updates metadata without changing icon order', () => {
  const previous = [{ id: 'a', pid: 1 }, { id: 'b', pid: 2 }, { id: 'c', pid: 3 }];
  const incoming = [{ id: 'c', pid: 3, active: true }, { id: 'a', pid: 1 }, { id: 'b', pid: 2 }];
  const result = reconcileWindows(previous, incoming);
  assert.deepEqual(result.map(window => window.id), ['a', 'b', 'c']);
  assert.equal(result[2].active, true);
});

test('closed windows disappear and new windows append, including recycled handles', () => {
  const previous = [{ id: 'a', pid: 1 }, { id: 'b', pid: 2 }, { id: 'c', pid: 3 }];
  const result = reconcileWindows(previous, [{ id: 'new', pid: 4 }, { id: 'a', pid: 99 }, { id: 'c', pid: 3 }]);
  assert.deepEqual(result.map(window => [window.id, window.pid]), [['c', 3], ['new', 4], ['a', 99]]);
});
