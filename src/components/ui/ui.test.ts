import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeClassName, buttonClassName, cardClassName } from './index';
import { cn } from './utils';

test('shared UI variants use theme tokens and className overrides win', () => {
  assert.match(buttonClassName('primary'), /bg-primary/);
  assert.match(buttonClassName('danger'), /bg-danger/);
  assert.match(buttonClassName('secondary'), /border-border-color/);
  assert.match(buttonClassName('ghost'), /bg-transparent/);
  assert.match(badgeClassName('success'), /bg-success\/10/);
  assert.match(cardClassName('lg'), /lg:p-8/);
  assert.equal(cn('px-4 text-sm', 'px-8'), 'text-sm px-8');
});
