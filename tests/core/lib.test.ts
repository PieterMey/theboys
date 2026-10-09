// tests/core/lib.ts guards: refuseLive (game :3000, STT :3100, any dead-air.io base) runs before a test reuses a server
// or spawns one, and startServer never starts on (or takes the /healthz of) a port another server already holds.
// Nothing here connects to the live ports: refuseLive throws before any socket is opened.
//   node --test tests/core/lib.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestClient, refuseLive, startServer } from './lib.ts';

test('refuseLive: the live ports and hosts throw, the test ports pass', () => {
  for (const [port, base] of [[3000], [3100], [3890, 'http://127.0.0.1:3000'], [3890, 'http://localhost:3100/'], [443, 'https://play.dead-air.io'],
    [80, 'http://DEAD-AIR.IO/'], [3890, 'https://x.dead-air.io/healthz']] as [number, string?][]) {
    assert.throws(() => refuseLive(port, base), /refusing the live server/, `${port} ${base ?? ''}`);
  }
  for (const [port, base] of [[3890], [3891], [3890, 'http://127.0.0.1:3890'], [30000, 'http://127.0.0.1:30000/'], [3001, 'http://127.0.0.1:3001']] as [number, string?][]) {
    assert.doesNotThrow(() => refuseLive(port, base), `${port} ${base ?? ''}`);
  }
});

test('startServer and TestClient.connect refuse the live ports before touching them', async () => {
  const scratch = join(tmpdir(), 'dead-air-core-libtest');
  await assert.rejects(startServer(3000, scratch), /refusing the live server/);
  await assert.rejects(startServer(3100, scratch), /refusing the live server/);
  await assert.rejects(startServer(3890, scratch, { BASE_URL: 'https://play.dead-air.io' }), /refusing the live server/);
  await assert.rejects(startServer(3890, scratch, { PORT: '3000' }), /refusing the live server/);
  await assert.rejects(new TestClient('Ann').connect(3000, 'NOPE'), /refusing the live server/);
});

test('startServer: a port another server already holds is refused, nothing is spawned on it', async () => {
  const other = createServer((s) => s.end());
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
  const port = (other.address() as AddressInfo).port;
  try {
    const t0 = performance.now();
    await assert.rejects(startServer(port, join(tmpdir(), 'dead-air-core-libtest')), /already in use/);
    assert.ok(performance.now() - t0 < 3000, 'refused at once (no child, no /healthz wait)');
  } finally {
    await new Promise<void>((r) => other.close(() => r()));
  }
});
