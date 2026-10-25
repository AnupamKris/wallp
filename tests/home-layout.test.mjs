import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultHomeLayout, overlaps, rearrange, projectLayout, parseHomeLayout, minimum, screenRows, setWidgetVisible } from '../src/home-layout.ts';

function valid(layout) {
  const tiles = layout.tiles.filter(t => !t.hidden);
  for (const tile of tiles) {
    assert.ok(tile.x >= 0 && tile.x + tile.w <= layout.columns);
    assert.ok(tile.y >= 0 && tile.h >= minimum[tile.id][1] && tile.y + tile.h <= screenRows);
    for (const other of tiles) if (tile.id !== other.id) assert.ok(!overlaps(tile, other), `${tile.id} overlaps ${other.id}`);
  }
}

test('desk buddy is optional and migrates into existing layouts without moving visible widgets', () => {
  const legacy = { ...defaultHomeLayout, tiles: defaultHomeLayout.tiles.filter(t => t.id !== 'buddy') };
  const restored = parseHomeLayout(JSON.stringify(legacy));
  assert.equal(restored.tiles.find(t => t.id === 'buddy').hidden, true);
  for (const tile of legacy.tiles) assert.deepEqual(restored.tiles.find(t => t.id === tile.id), tile);
});

test('desk buddy can be added, resized, saved, and hidden at every responsive screen size', () => {
  for (const columns of [8, 24, 48]) {
    let layout = projectLayout(defaultHomeLayout, columns);
    layout = setWidgetVisible(layout, 'buddy', true);
    assert.ok(layout);
    valid(layout);
    assert.deepEqual(parseHomeLayout(JSON.stringify(layout)), layout);
    const visible = layout.tiles.find(t => t.id === 'buddy');
    layout = rearrange(layout, { ...visible, h: visible.h + 1 }) ?? layout;
    valid(layout);
    layout = { ...layout, tiles: layout.tiles.map(t => t.id === 'buddy' ? { ...t, hidden: true } : t) };
    assert.equal(parseHomeLayout(JSON.stringify(layout)).tiles.find(t => t.id === 'buddy').hidden, true);
  }
});

test('enabling a previously saved tall buddy repacks fragmented space', () => {
  const saved = { ...defaultHomeLayout, tiles: defaultHomeLayout.tiles.map(t => t.id === 'buddy' ? { ...t, h: 7 } : t) };
  const layout = projectLayout(saved, 8);
  const attempt = { ...layout, tiles: layout.tiles.map(t => t.id === 'buddy' ? { ...t, hidden: false } : t) };
  assert.equal(rearrange(attempt), null);
  const result = setWidgetVisible(layout, 'buddy', true);
  assert.ok(result);
  valid(result);
  assert.equal(result.tiles.find(t => t.id === 'buddy').hidden, false);
  assert.equal(result.tiles.find(t => t.id === 'buddy').h, 7);
  assert.deepEqual(parseHomeLayout(JSON.stringify(result)), result);
});

test('enabling a widget can make room in a packed layout without hiding other widgets', () => {
  const layout = { columns: 48, tiles: [
    { id: 'clocks', x: 0, y: 0, w: 48, h: 12 },
    { id: 'digest', x: 0, y: 12, w: 48, h: 12 },
    { id: 'buddy', x: 4, y: 14, w: 12, h: 7, hidden: true },
  ] };
  const result = setWidgetVisible(layout, 'buddy', true);
  assert.ok(result);
  valid(result);
  assert.ok(result.tiles.every(t => !t.hidden));
  const hidden = setWidgetVisible(result, 'buddy', false);
  for (const tile of result.tiles.filter(t => t.id !== 'buddy')) assert.deepEqual(hidden.tiles.find(t => t.id === tile.id), tile);
});

test('moving into occupied space keeps the destination and automatically makes room', () => {
  const active = { ...defaultHomeLayout.tiles[0], y: 5 };
  const result = rearrange(defaultHomeLayout, active);
  assert.deepEqual(result.tiles[0], active);
  assert.equal(result.tiles.find(t => t.id === 'digest').w, 10);
  valid(result);
});
test('enlarging a widget makes room within one screen without changing other sizes', () => {
  const result = rearrange(defaultHomeLayout, { ...defaultHomeLayout.tiles[0], x: 0, w: 12, h: 10 });
  valid(result);
  for (const tile of result.tiles.slice(1)) {
    assert.equal(tile.w, defaultHomeLayout.tiles.find(t => t.id === tile.id).w);
    if (!tile.hidden) assert.ok(tile.y >= 10);
  }
});
test('auto arrange is deterministic and keeps hidden widgets hidden', () => {
  const input = { ...defaultHomeLayout, tiles: defaultHomeLayout.tiles.map(t => ({ ...t, y: t.y + 30, hidden: t.id === 'digest' })) };
  const result = rearrange(input, undefined, true);
  valid(result);
  assert.equal(result.tiles.find(t => t.id === 'digest').hidden, true);
  assert.equal(Math.min(...result.tiles.filter(t => !t.hidden).map(t => t.y)), 0);
  assert.deepEqual(rearrange(result, undefined, true), result);
});
test('responsive projection preserves the saved desktop layout', () => {
  const original = JSON.stringify(defaultHomeLayout);
  for (const columns of [2, 6, 12, 8, 24, 48]) valid(projectLayout(defaultHomeLayout, columns));
  assert.equal(JSON.stringify(defaultHomeLayout), original);
});
test('finer horizontal grid preserves existing positions and sizes exactly', () => {
  const fine = projectLayout(defaultHomeLayout, 48);
  for (const original of defaultHomeLayout.tiles) {
    const tile = fine.tiles.find(t => t.id === original.id);
    assert.equal(tile.x, original.x * 4);
    assert.equal(tile.w, original.w * 4);
    assert.equal(tile.y, original.y);
    assert.equal(tile.h, original.h);
  }
  assert.deepEqual(parseHomeLayout(JSON.stringify(fine)), fine);
});
test('fine-grid moves and narrower shortcut groups persist without rounding to the old grid', () => {
  const fine = projectLayout(defaultHomeLayout, 48);
  const dock = fine.tiles.find(t => t.id === 'dock');
  const moved = rearrange(fine, { ...dock, x: dock.x + 1, w: 2 });
  valid(moved);
  assert.equal(moved.tiles.find(t => t.id === 'dock').x, dock.x + 1);
  assert.equal(moved.tiles.find(t => t.id === 'dock').w, 2);
  assert.deepEqual(parseHomeLayout(JSON.stringify(moved)), moved);
});
test('saved layouts round-trip and malformed data falls back or is repaired', () => {
  const restored = parseHomeLayout(JSON.stringify(defaultHomeLayout));
  assert.deepEqual(restored, defaultHomeLayout);
  assert.deepEqual(parseHomeLayout(JSON.stringify(restored)), restored);
  for (const raw of [null, '{', '{"columns":0}', '{"columns":12,"tiles":null}']) assert.deepEqual(parseHomeLayout(raw), defaultHomeLayout);
  valid(parseHomeLayout(JSON.stringify({ columns: 6, tiles: [{ id: 'clocks', x: -9, y: -1, w: 90, h: 0 }] })));
});
test('repeated moves and resizes always produce collision-free layouts', () => {
  let layout = defaultHomeLayout;
  for (let i = 0; i < 150; i++) {
    const tile = layout.tiles[i % layout.tiles.length];
    layout = rearrange(layout, { ...tile, x: i % 12, y: i % 15, w: 1 + i % 12, h: 2 + i % 10 }) ?? layout;
    valid(layout);
  }
});
test('an impossible enlargement cannot create an infinite canvas', () => {
  assert.equal(rearrange(defaultHomeLayout, { ...defaultHomeLayout.tiles[0], x: 0, w: 12, h: 24 }), null);
});
test('legacy oversized scrolling layouts migrate into a bounded screen', () => {
  const legacy = { ...defaultHomeLayout, tiles: defaultHomeLayout.tiles.map((t, i) => ({ ...t, y: i * 25, h: 40 })) };
  const result = parseHomeLayout(JSON.stringify(legacy));
  valid(result);
  assert.equal(result.tiles.length, defaultHomeLayout.tiles.length);
  assert.deepEqual(parseHomeLayout(JSON.stringify(result)), result);
});
test('moving into empty space does not pull unrelated widgets upward', () => {
  const active = { ...defaultHomeLayout.tiles.find(t => t.id === 'dock'), y: 18 };
  const result = rearrange(defaultHomeLayout, active);
  for (const original of defaultHomeLayout.tiles.filter(t => t.id !== 'dock')) assert.deepEqual(result.tiles.find(t => t.id === original.id), original);
  assert.equal(result.tiles.find(t => t.id === 'dock').y,18);
  assert.deepEqual(rearrange(defaultHomeLayout, defaultHomeLayout.tiles[0]), defaultHomeLayout);
});
test('group direction and icon labels persist independently', () => {
  const layout = { ...defaultHomeLayout, tiles: defaultHomeLayout.tiles.map(t => t.id === 'controls' ? { ...t, direction: 'column', labels: false } : t.id === 'apps' ? { ...t, direction: 'row', labels: true } : t) };
  assert.deepEqual(parseHomeLayout(JSON.stringify(layout)), layout);
  assert.deepEqual(rearrange(layout).tiles.find(t => t.id === 'controls'), layout.tiles.find(t => t.id === 'controls'));
});

test('content alignment persists and invalid saved alignment is discarded', () => {
  const layout = { ...defaultHomeLayout, tiles: defaultHomeLayout.tiles.map(t => t.id === 'controls' ? { ...t, contentAlign: 'end' } : t) };
  assert.deepEqual(parseHomeLayout(JSON.stringify(layout)), layout);
  const invalid = { ...layout, tiles: layout.tiles.map(t => ({ ...t, contentAlign: 'invalid' })) };
  assert.ok(parseHomeLayout(JSON.stringify(invalid)).tiles.every(t => !t.contentAlign));
});

test('horizontal and vertical content alignment persist independently', () => {
  const input = { ...defaultHomeLayout, tiles: defaultHomeLayout.tiles.map(t => t.id === 'controls' ? { ...t, alignX: 'start', alignY: 'end' } : t) };
  assert.deepEqual(parseHomeLayout(JSON.stringify(input)), input);
  const moved = rearrange(input, { ...input.tiles.find(t => t.id === 'controls'), y: 22 });
  assert.equal(moved.tiles.find(t => t.id === 'controls').alignY, 'end');
  valid(moved);
});

test('desk buddy style is saved and unknown styles fall back to the cat', () => {
  const withVariant = variant => JSON.stringify({ ...defaultHomeLayout, tiles: defaultHomeLayout.tiles.map(t => t.id === 'buddy' ? { ...t, variant } : t) });
  assert.equal(parseHomeLayout(withVariant('simple')).tiles.find(t => t.id === 'buddy').variant, 'simple');
  assert.equal(parseHomeLayout(withVariant('dragon')).tiles.find(t => t.id === 'buddy').variant, undefined);
});
