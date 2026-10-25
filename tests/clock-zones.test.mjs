import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockZones, defaultCities, loadCities, cityOptions } from '../src/clock-zones.ts';

test('old and invalid city settings fall back to three valid clocks', () => {
  for (const value of [undefined, null, [], ['Asia/Tokyo'], ['Asia/Tokyo', 'Invalid/City', 'UTC'], [1, 2, 3]]) {
    assert.deepEqual(loadCities(value), defaultCities);
  }
});

test('chosen cities survive loading and drive names, zones and distinct hand colours', () => {
  const selection = ['America/New_York', 'Asia/Kathmandu', 'Pacific/Chatham'];
  const loaded = loadCities(JSON.parse(JSON.stringify(selection)));
  assert.deepEqual(loaded, selection);
  assert.notEqual(loaded, selection);
  const zones = clockZones(loaded);
  assert.deepEqual(zones.map(city => city.zone), selection);
  assert.deepEqual(zones.map(city => city.label), ['New York', 'Kathmandu', 'Chatham']);
  assert.equal(new Set(zones.map(city => city.color)).size, 3);
  assert.ok(cityOptions.includes('America/New_York'));
});
