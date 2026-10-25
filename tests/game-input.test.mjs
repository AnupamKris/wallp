import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameInputTracker, directionalNeighbor, parseGameBindings, defaultGameBindings } from '../src/game-input.ts';

const bindings = defaultGameBindings;
const pad = (buttons = 0, extra = {}) => ({ id: 0, buttons, x: 0, y: 0, ...extra });
const state = (controller = pad(), extra = {}) => ({ homeForeground: true, shortcut: false, controllers: [controller], ...extra });
function ready() { const tracker = new GameInputTracker(); tracker.update(state(), 0, bindings); return tracker; }

test('both buttons must be held for a full second and toggle once until release', () => {
  const tracker = ready();
  assert.deepEqual(tracker.update(state(pad(0x20)), 50, bindings), []);
  assert.deepEqual(tracker.update(state(pad(0x30)), 100, bindings), []);
  assert.deepEqual(tracker.update(state(pad(0x30)), 1099, bindings), []);
  assert.deepEqual(tracker.update(state(pad(0x30)), 1100, bindings), ['toggle']);
  assert.deepEqual(tracker.update(state(pad(0x30)), 2500, bindings), []);
  tracker.update(state(), 2600, bindings);
  tracker.update(state(pad(0x30)), 2700, bindings);
  assert.deepEqual(tracker.update(state(pad(0x30)), 3700, bindings), ['toggle']);
});

test('short hold cancels and buttons on separate devices never form a chord', () => {
  const tracker = ready();
  tracker.update(state(pad(0x30)), 100, bindings);
  tracker.update(state(), 800, bindings);
  assert.equal(tracker.progress, 0);
  for (const now of [1000, 2000, 3000]) assert.deepEqual(tracker.update(state(pad(0x20), { controllers: [pad(0x20), pad(0x10, { id: 1 })] }), now, bindings), []);
});

test('foreground loss cancels holds and requires release before accepting new input', () => {
  const tracker = ready();
  tracker.update(state(pad(0x30)), 100, bindings);
  assert.deepEqual(tracker.update(state(pad(0x30), { homeForeground: false }), 900, bindings), []);
  assert.equal(tracker.progress, 0);
  assert.deepEqual(tracker.update(state(pad(0x30)), 2000, bindings), []);
  assert.deepEqual(tracker.update(state(pad(0x30)), 4000, bindings), []);
  tracker.update(state(), 4100, bindings);
  tracker.update(state(pad(0x30)), 4200, bindings);
  assert.deepEqual(tracker.update(state(pad(0x30)), 5200, bindings), ['toggle']);
});

test('disconnect/reconnect does not replay held confirm or resume an old hold', () => {
  const tracker = ready();
  tracker.update(state(pad(0x30)), 100, bindings);
  tracker.update(state(pad(), { controllers: [] }), 900, bindings);
  assert.equal(tracker.progress, 0);
  assert.deepEqual(tracker.update(state(pad(0x1000)), 1200, bindings), []);
  tracker.update(state(), 1300, bindings);
  assert.deepEqual(tracker.update(state(pad(0x1000)), 1400, bindings), ['accept']);
  assert.deepEqual(tracker.update(state(pad(0x1000)), 1500, bindings), []);
});

test('stick dead zone and repeat delay prevent drift and overshooting', () => {
  const tracker = ready();
  assert.deepEqual(tracker.update(state(pad(0, { x: .3, y: .2 })), 50, bindings), []);
  assert.deepEqual(tracker.update(state(pad(0, { x: .8 })), 100, bindings), ['right']);
  assert.deepEqual(tracker.update(state(pad(0, { x: .8 })), 449, bindings), []);
  assert.deepEqual(tracker.update(state(pad(0, { x: .8 })), 450, bindings), ['right']);
  assert.deepEqual(tracker.update(state(pad(0, { x: .8 })), 570, bindings), ['right']);
  assert.deepEqual(tracker.update(state(pad(1)), 600, bindings), ['up']);
});

test('configurable Menu-only binding and keyboard shortcut are edge triggered', () => {
  const tracker = ready(), menu = { ...bindings, controller: 'menu' };
  tracker.update(state(pad(0x10)), 100, menu);
  assert.deepEqual(tracker.update(state(pad(0x10)), 1100, menu), ['toggle']);
  assert.deepEqual(tracker.update(state(pad(), { shortcut: true }), 1200, menu), ['toggle']);
  assert.deepEqual(tracker.update(state(pad(), { shortcut: true }), 1300, menu), []);
});

test('directional navigation follows spatial layout and stays put at edges', () => {
  const rects = [{ left: 0, top: 0, width: 100, height: 80 }, { left: 120, top: 0, width: 100, height: 80 }, { left: 0, top: 100, width: 100, height: 80 }];
  assert.equal(directionalNeighbor(rects, 0, 'right'), 1);
  assert.equal(directionalNeighbor(rects, 0, 'down'), 2);
  assert.equal(directionalNeighbor(rects, 0, 'left'), 0);
  assert.equal(directionalNeighbor(rects, -1, 'up'), 0);
  assert.equal(directionalNeighbor([], -1, 'right'), -1);
});

test('vertical navigation never skips a half-key-staggered keyboard row', () => {
  // Overlay keyboard rows 2–4: T, then G H J offset by half a key, then V B directly under T.
  const key = (left, top) => ({ left, top, width: 58, height: 50 });
  const rects = [key(395, 142), key(302, 199), key(368, 199), key(435, 199), key(330, 257), key(395, 257)];
  const [t, , h, , v, b] = [0, 1, 2, 3, 4, 5];
  assert.equal(directionalNeighbor(rects, t, 'down'), h);
  assert.equal(directionalNeighbor(rects, b, 'up'), h);
  assert.equal(directionalNeighbor(rects, v, 'up'), 1);
  assert.equal(directionalNeighbor(rects, h, 'down'), b);
});

test('invalid saved shortcuts safely fall back to defaults', () => {
  for (const raw of [null, 'bad json', '{}', '{"letter":"<script>","controller":"unknown"}', '{"letter":"D"}', '{"letter":"W"}', '{"letter":"N"}']) assert.deepEqual(parseGameBindings(raw), bindings);
  assert.deepEqual(parseGameBindings('{"letter":"H","controller":"menu"}'), { letter: 'H', controller: 'menu', transition: 'classic' });
  assert.equal(parseGameBindings('{"transition":"hyper"}').transition, 'hyper');
  assert.equal(parseGameBindings('{"transition":"overdrive"}').transition, 'overdrive');
  assert.equal(parseGameBindings('{"transition":"wild"}').transition, 'classic');
});
