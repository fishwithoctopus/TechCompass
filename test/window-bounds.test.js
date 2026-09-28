import test from 'node:test';
import assert from 'node:assert/strict';
import { cardBounds } from '../card/window-bounds.js';

test('compact card keeps bottom-right anchor and restores full dimensions', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const full = { x: 1506, y: 446, width: 400, height: 580 };
  const mini = cardBounds(full, area, true);
  assert.deepEqual(mini, { x: 1810, y: 978, width: 96, height: 48 });
  assert.deepEqual(cardBounds(mini, area, false), full);
});
test('expanding a dragged compact card stays on its display', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(cardBounds({ x: -1910, y: 10, width: 96, height: 48 }, area, false),
    { x: -1920, y: 0, width: 400, height: 580 });
});
