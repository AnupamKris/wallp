import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBang, searchApps, isClipboardCommand, searchPowerCommands } from '../src/launcher-search.ts';

test('power commands match typed commands and prefixes without capturing unrelated searches', () => {
  for (const query of ['power off', ' POWER   OFF ', 'shutdown', 'shut down']) {
    assert.equal(searchPowerCommands(query)[0]?.action, 'power_off');
  }
  assert.equal(searchPowerCommands('restart')[0]?.action, 'restart');
  assert.equal(searchPowerCommands('Sleep')[0]?.action, 'sleep');
  assert.equal(searchPowerCommands('pow')[0]?.action, 'power_off');
  for (const query of ['', '  ', 'sleep music', 'restart guide', 'g power off', 'powershell']) {
    assert.deepEqual(searchPowerCommands(query), []);
  }
});

test('search shortcuts require a prefix and preserve the search query', () => {
  assert.deepEqual(parseBang('g rust & windows'), { key: 'g', name: 'Google', query: 'rust & windows' });
  assert.deepEqual(parseBang(' !Y café music'), { key: 'y', name: 'YouTube', query: 'café music' });
  assert.equal(parseBang('gh tauri clipboard').key, 'gh');
  assert.equal(parseBang('g ').query, '');
  assert.equal(parseBang('google chrome'), null);
  assert.equal(parseBang('github'), null);
  assert.equal(parseBang('unknown term'), null);
});
test('file bang requires a space and accepts the optional exclamation mark', () => {
  assert.deepEqual(parseBang('f budget report'), { key: 'f', name: 'Files', query: 'budget report' });
  assert.deepEqual(parseBang('!F résumé.pdf'), { key: 'f', name: 'Files', query: 'résumé.pdf' });
  assert.equal(parseBang('f ').query, '');
  assert.equal(parseBang('f'), null);
  assert.equal(parseBang('firefox'), null);
});
test('app matching ranks exact names first, then prefixes, then word matches', () => {
  const apps = [
    { id: '1', name: 'Visual Studio Code' },
    { id: '2', name: 'Code Editor' },
    { id: '3', name: 'Code' },
    { id: '4', name: 'Calculator' },
  ];
  assert.deepEqual(searchApps(apps, 'CODE').map(app => app.id), ['3', '2', '1']);
  assert.deepEqual(searchApps(apps, 'studio visual').map(app => app.id), ['1']);
  assert.deepEqual(searchApps(apps, '   '), apps);
  assert.deepEqual(searchApps(apps, 'absent'), []);
});
test('paste and clipboard commands are explicit and case insensitive', () => {
  for (const query of ['paste', ' Paste ', 'clipboard', 'Clipboard History']) assert.equal(isClipboardCommand(query), true);
  for (const query of ['g paste', 'pastebin', 'clipboard.exe']) assert.equal(isClipboardCommand(query), false);
});

test('wallp commands reach the tray actions by name', async () => {
  const { searchWallpCommands } = await import('../src/launcher-search.ts');
  assert.equal(searchWallpCommands('taskbar')[0]?.action, 'restore_taskbar');
  assert.equal(searchWallpCommands('restore taskbar')[0]?.action, 'restore_taskbar');
  assert.equal(searchWallpCommands('reload')[0]?.action, 'reload');
  assert.equal(searchWallpCommands('Quit')[0]?.action, 'quit');
  assert.deepEqual(searchWallpCommands(''), []);
  assert.deepEqual(searchWallpCommands('quite a lot'), []);
});
