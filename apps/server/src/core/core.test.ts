// Core sanity tests: node --test apps/server/src/core/core.test.ts (also run by npm run test:unit)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCode, playerIdFromKey } from './crews.ts';
import { readBalance, readFlags } from './config.ts';
import { InterpBuffer, lerpAngle } from '../../../client/src/core/world.ts';
import type { SnapPlayer } from '@dead-air/shared/state.ts';

test('crew codes normalise and player ids are stable per key', () => {
  assert.equal(normCode(' bk-rt '), 'BKRT');
  assert.equal(playerIdFromKey('abcdef0123456789'), playerIdFromKey('abcdef0123456789'));
  assert.notEqual(playerIdFromKey('abcdef0123456789'), playerIdFromKey('abcdef012345678a'));
});

test('config loads flags and namespaced balance', () => {
  assert.equal(typeof readFlags().ai, 'boolean');
  assert.equal(readBalance().core.startScrip, 150);
});

test('interpolation buffer lerps position and shortest-path yaw', () => {
  const b = new InterpBuffer<SnapPlayer>();
  const s = (x: number, yaw: number): SnapPlayer => ({ id: 'a', p: [x, 0, 0], yaw, pitch: 0, stance: 0, anim: 0, light: 0 });
  b.push(1000, s(0, 3.0));
  b.push(1100, s(1, -3.0));
  const m = b.sample(1050)!;
  assert.ok(Math.abs(m.p[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(Math.abs(m.yaw) - Math.PI) < 0.2, `yaw ${m.yaw} should wrap through pi`);
  assert.equal(b.sample(2000)!.p[0], 1);
  assert.ok(Math.abs(lerpAngle(0, Math.PI / 2, 0.5) - Math.PI / 4) < 1e-9);
});
