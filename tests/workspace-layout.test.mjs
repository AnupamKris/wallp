import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacentPanel, defaultScrollingLayout, panelWidth, parseScrollingLayout, reorderPanel, panelGeometry, panelSnapOffset, stackPanel, moveInStack, withStacks, workspaceGrid, gridGeometry, placeGridPanel, verticalGridNeighbor } from '../src/workspace-layout.ts';

test('mixed-width columns extend the strip without shrinking other columns', () => {
  const widths = [33, 66, 100, 150].map(width => panelWidth(width, 1200));
  assert.deepEqual(widths, [396, 792, 1200, 1800]);
  assert.ok(widths.reduce((sum, width) => sum + width, 0) > 1200);
  assert.equal(panelWidth(25, 600), 280);
  assert.equal(panelWidth(25, 200), 200);
});
test('navigation respects custom order and stops at the strip boundaries', () => {
  const open = ['notes', 'emails', 'todos'];
  assert.equal(adjacentPanel(open, 'emails', 1), 'todos');
  assert.equal(adjacentPanel(open, 'emails', -1), 'notes');
  assert.equal(adjacentPanel(open, 'notes', -1), 'notes');
  assert.equal(adjacentPanel(open, 'todos', 1), 'todos');
  assert.equal(adjacentPanel([], 'notes', 1), undefined);
});
test('reordering leaves panel widths intact and does not mutate the old layout', () => {
  const result = reorderPanel(defaultScrollingLayout, 'notes', -1);
  assert.deepEqual(result.open, ['emails', 'reminders', 'notes', 'todos']);
  assert.deepEqual(defaultScrollingLayout.open, ['emails', 'reminders', 'todos', 'notes']);
  assert.deepEqual(result.widths, defaultScrollingLayout.widths);
});
test('migrates old grid in reading order, preserving visibility and relative widths', () => {
  const legacy = { columns: 12, open: ['todos', 'emails', 'reminders'], cells: { emails: { row: 1, col: 1, width: 8 }, reminders: { row: 1, col: 9, width: 4 }, todos: { row: 5, col: 1, width: 6 } } };
  const result = parseScrollingLayout(null, JSON.stringify(legacy));
  assert.deepEqual(result.open, ['emails', 'reminders', 'todos']);
  assert.equal(result.widths.emails, 67);
  assert.equal(result.widths.reminders, 33);
  assert.equal(result.widths.todos, 50);
});
test('round trips empty layouts, rejects invalid widths and duplicate panels', () => {
  const empty = { ...defaultScrollingLayout, open: [], stacks: [] };
  assert.deepEqual(parseScrollingLayout(JSON.stringify(empty)), empty);
  for (const bad of [{ ...empty, widths: { ...empty.widths, notes: -1 } }, { ...empty, open: ['notes', 'notes'] }, { ...empty, open: ['unknown'] }]) {
    assert.deepEqual(parseScrollingLayout(JSON.stringify(bad)), defaultScrollingLayout);
  }
  assert.deepEqual(parseScrollingLayout('{broken'), defaultScrollingLayout);
});

test('stacked panels retain independent widths and snap each right edge separately', () => {
  let layout = { ...defaultScrollingLayout, widths: { ...defaultScrollingLayout.widths, emails: 100, reminders: 50, todos: 66 } };
  layout = stackPanel(layout, 'reminders', 'emails');
  assert.deepEqual(layout.stacks[0], ['emails', 'reminders']);
  const geometry = panelGeometry(layout, 1200);
  const wide = geometry.panels.find(panel => panel.id === 'emails');
  const narrow = geometry.panels.find(panel => panel.id === 'reminders');
  assert.equal(wide.left, narrow.left);
  assert.equal(wide.width, 1200);
  assert.equal(narrow.width, 600);
  assert.equal(wide.snap - narrow.snap, 600);
  for (const panel of geometry.panels) assert.equal(panel.left + panel.width - panel.snap, 1224 - 12);
  assert.deepEqual(geometry.stops.slice(0, 2).map(panel => panel.id), ['reminders', 'emails']);
});
test('equal-width stacked panels remain separate keyboard targets', () => {
  let layout = { ...defaultScrollingLayout, widths: { ...defaultScrollingLayout.widths, emails: 50, reminders: 50 } };
  layout = stackPanel(layout, 'reminders', 'emails');
  const stops = panelGeometry(layout, 1200).stops;
  assert.equal(stops[0].snap, stops[1].snap);
  assert.equal(adjacentPanel(stops.map(panel => panel.id), 'emails', 1), 'reminders');
});
test('stack reorder, split, persistence and closing preserve widths and unique membership', () => {
  let layout = stackPanel(defaultScrollingLayout, 'todos', 'emails');
  layout = moveInStack(layout, 'todos', -1);
  assert.deepEqual(layout.stacks[0], ['todos', 'emails']);
  assert.deepEqual(parseScrollingLayout(JSON.stringify(layout)), layout);
  layout = stackPanel(layout, 'todos', null);
  assert.deepEqual(layout.stacks.slice(0, 2), [['emails'], ['todos']]);
  layout = withStacks(layout, layout.stacks.map(stack => stack.filter(id => id !== 'emails')));
  assert.ok(!layout.open.includes('emails'));
  assert.ok(layout.stacks.every(stack => stack.length));
  assert.equal(new Set(layout.open).size, layout.open.length);
  assert.deepEqual(layout.widths, defaultScrollingLayout.widths);
});
test('old strip layouts migrate to individual columns and invalid stack membership recovers', () => {
  const strip = { open: ['notes', 'todos'], widths: defaultScrollingLayout.widths };
  assert.deepEqual(parseScrollingLayout(JSON.stringify(strip)).stacks, [['notes'], ['todos']]);
  assert.deepEqual(parseScrollingLayout(JSON.stringify({ ...strip, stacks: [['notes', 'notes']] })).stacks, [['notes'], ['todos']]);
  assert.equal(panelSnapOffset(900, 800, 1200), 512);
});

test('grid restores the original two-by-two arrangement and extends horizontally for more apps', () => {
  const grid = workspaceGrid(defaultScrollingLayout);
  assert.deepEqual(grid.cells.emails, { col: 1, row: 1, width: 6, height: 4 });
  assert.deepEqual(grid.cells.reminders, { col: 7, row: 1, width: 6, height: 4 });
  assert.deepEqual(grid.cells.todos, { col: 1, row: 5, width: 6, height: 4 });
  assert.deepEqual(grid.cells.notes, { col: 7, row: 5, width: 6, height: 4 });
  const expanded = withStacks(defaultScrollingLayout, [...defaultScrollingLayout.stacks, ['agenda']]);
  assert.equal(workspaceGrid(expanded).cells.agenda.col, 13);
  assert.ok(gridGeometry(expanded, 1200).columns > 12);
});
test('grid move swaps occupied panels and preserves unaffected panels', () => {
  const before = workspaceGrid(defaultScrollingLayout);
  const result = placeGridPanel(defaultScrollingLayout, 'emails', before.cells.reminders);
  assert.deepEqual(result.grid.cells.emails, before.cells.reminders);
  assert.deepEqual(result.grid.cells.reminders, before.cells.emails);
  assert.deepEqual(result.grid.cells.todos, before.cells.todos);
  assert.deepEqual(result.grid.cells.notes, before.cells.notes);
  assert.deepEqual(parseScrollingLayout(JSON.stringify(result)).grid, result.grid);
});
test('extended grid preserves distinct right-edge stops for vertical panels of different widths', () => {
  let layout = placeGridPanel(defaultScrollingLayout, 'emails', { col: 13, row: 1, width: 8, height: 4 });
  layout = placeGridPanel(layout, 'todos', { col: 13, row: 5, width: 4, height: 4 });
  const geometry = gridGeometry(layout, 1200);
  const wide = geometry.panels.find(panel => panel.id === 'emails');
  const narrow = geometry.panels.find(panel => panel.id === 'todos');
  assert.equal(wide.snap - narrow.snap, 400);
  assert.equal(wide.left + wide.width - wide.snap, 1212);
  assert.equal(narrow.left + narrow.width - narrow.snap, 1212);
  assert.equal(verticalGridNeighbor(layout, 'emails', 1), 'todos');
  assert.equal(verticalGridNeighbor(layout, 'todos', -1), 'emails');
});
test('grid resize makes room without overlapping panels and recovers invalid grid storage', () => {
  const layout = placeGridPanel(defaultScrollingLayout, 'emails', { col: 1, row: 1, width: 18, height: 8 });
  const cells = layout.open.map(id => layout.grid.cells[id]);
  for (const [index, a] of cells.entries()) for (const b of cells.slice(index + 1)) {
    assert.ok(!(a.col < b.col + b.width && a.col + a.width > b.col && a.row < b.row + b.height && a.row + a.height > b.row));
  }
  const invalid = { ...layout, grid: { ...layout.grid, rows: -1 } };
  assert.equal(parseScrollingLayout(JSON.stringify(invalid)).grid, undefined);
});
