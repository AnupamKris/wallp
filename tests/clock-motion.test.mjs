import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClockSweep, startClockTicker } from '../src/clock-motion.ts';

test('hands sweep between seconds, cross twelve forwards, and cancel all animation work', t => {
  let currentTime = 0, nextId = 0;
  const frames = new Map();
  t.mock.method(Date, 'now', () => currentTime);
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => {
    if (originalRaf) globalThis.requestAnimationFrame = originalRaf;
    else delete globalThis.requestAnimationFrame;
    if (originalCancel) globalThis.cancelAnimationFrame = originalCancel;
    else delete globalThis.cancelAnimationFrame;
  });
  const hand = (angle, period) => ({
    angle, period, transform: '',
    getAttribute(name) { return name === 'data-angle' ? String(angle) : String(period); },
    setAttribute(name, value) { assert.equal(name, 'transform'); this.transform = value; },
  });
  const second = hand(359.4, 60), minute = hand(359.99, 3600), hour = hand(359.999, 43200);
  const railwayDot = hand(359.4, 60);
  const hands = [second, minute, hour, railwayDot];
  const face = { querySelectorAll: () => hands };
  const stop = startClockSweep(face, 0);
  const nextFrame = milliseconds => {
    currentTime = milliseconds;
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback();
  };
  const angleOf = element => Number(element.transform.match(/rotate\(([^ ]+)/)[1]);
  nextFrame(50);
  assert.ok(Math.abs(angleOf(second) - 359.7) < 0.00001);
  nextFrame(500);
  assert.ok(angleOf(second) > 360);
  assert.ok(angleOf(minute) > 360);
  assert.ok(angleOf(hour) > 360);
  assert.equal(railwayDot.transform, second.transform);
  assert.equal(frames.size, 1);
  stop();
  assert.equal(frames.size, 0, 'pause leaves no animation callback queued');

  // Resume after a long fullscreen session at the correct current time.
  currentTime = 600000;
  const resumeStop = startClockSweep(face, 0);
  assert.ok(Math.abs(angleOf(second) - 3959.4) < 0.00001);
  resumeStop();
  assert.equal(frames.size, 0);
});

test('clock ticker stops completely during pause and resyncs immediately on resume', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const updates = [];
  const update = date => updates.push(date.getTime());
  const stop = startClockTicker(update);
  assert.deepEqual(updates, [0]);
  t.mock.timers.tick(1000);
  assert.deepEqual(updates, [0, 1000]);
  stop();
  t.mock.timers.tick(60000);
  assert.deepEqual(updates, [0, 1000]);
  const stopAgain = startClockTicker(update);
  assert.deepEqual(updates, [0, 1000, 61000]);
  stopAgain();
  t.mock.timers.tick(60000);
  assert.equal(updates.length, 3);
});
