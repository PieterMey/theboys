// Live flags (integrator): GET /healthz carries the server's live ctx.flags (updated in place by SIGHUP /
// dbg.reloadConfig) and the client's boot-time fetch merges them over the bundled copy (apps/client/src/core/flags.ts),
// so a kill switch reaches production clients on their next page load without a client rebuild.
// Run: node --test apps/server/src/core/flags.test.ts   (also part of npm run test:unit)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './boot.ts';
import { readFlags } from './config.ts';
import { setQuiet } from './log.ts';
import { FLAGS_PATH, changedFlags, fetchServerFlags, mergeFlags } from '../../../client/src/core/flags.ts';

const json = (body: unknown, init: { status?: number; type?: string } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'application/json; charset=utf-8' } });

test('mergeFlags: the server wins for every boolean; other values, arrays and null are ignored; inputs untouched', () => {
  const bundled = { mirrors: true, paranormal: true, gtao: false };
  const merged = mergeFlags(bundled, { mirrors: false, gtao: true, newFlag: false, junk: 'no', n: 1, nested: { a: true } });
  assert.deepEqual(merged, { mirrors: false, paranormal: true, gtao: true, newFlag: false });
  assert.deepEqual(bundled, { mirrors: true, paranormal: true, gtao: false });
  for (const bad of [null, undefined, 'x', 3, [true], [{ mirrors: false }]]) assert.deepEqual(mergeFlags(bundled, bad), bundled);
  assert.deepEqual(changedFlags(bundled, merged), ['gtao', 'mirrors', 'newFlag']);
  assert.deepEqual(changedFlags(bundled, { ...bundled }), []);
});

test('fetchServerFlags: healthz flags -> flags; an older server (no flags), 404, HTML, bad JSON, network error or timeout -> null', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const ok = await fetchServerFlags({ fetchImpl: (async (url: string, init?: RequestInit) => { seen.push({ url, init }); return json({ ok: true, flags: { mirrors: false, x: 'y' } }); }) as typeof fetch });
  assert.deepEqual(ok, { mirrors: false });
  assert.equal(seen[0]?.url, FLAGS_PATH);
  assert.equal(seen[0]?.init?.cache, 'no-store');
  const cases: [string, typeof fetch][] = [
    ['older server: healthz without flags', (async () => json({ ok: true, mode: 'production', crews: 0, uptimeSec: 5 })) as typeof fetch],
    ['flags not an object', (async () => json({ ok: true, flags: [true] })) as typeof fetch],
    ['404', (async () => json('not found', { status: 404, type: 'text/plain' })) as typeof fetch],
    ['SPA html fallback', (async () => json('<!doctype html>', { type: 'text/html' })) as typeof fetch],
    ['array', (async () => json([true])) as typeof fetch],
    ['bad json', (async () => json('{nope')) as typeof fetch],
    ['network error', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch],
  ];
  for (const [name, f] of cases) assert.equal(await fetchServerFlags({ fetchImpl: f }), null, name);
  // a server that never answers: aborted after timeoutMs
  const t0 = performance.now();
  const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
  assert.equal(await fetchServerFlags({ fetchImpl: hang, timeoutMs: 60 }), null);
  assert.ok(performance.now() - t0 < 1000, 'timeout honoured');
});

test('GET /healthz carries the LIVE flags (in-place changes and reloadConfig), no-store; the client fetch merges them', async () => {
  setQuiet(true);
  const srv = await boot({ mode: 'test', port: 0, tracks: [] });
  try {
    const url = `http://127.0.0.1:${srv.port}${FLAGS_PATH}`;
    const r0 = await fetch(url);
    assert.equal(r0.status, 200);
    assert.match(r0.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(r0.headers.get('cache-control'), 'no-store');
    const h0 = (await r0.json()) as { ok: boolean; flags: unknown };
    assert.equal(h0.ok, true, 'still the health answer');
    assert.deepEqual(h0.flags, srv.ctx.flags);

    // a kill switch flipped on the server (what SIGHUP / dbg.reloadConfig do to the same object) is served at once
    const was = srv.ctx.flags.mirrors;
    srv.ctx.flags.mirrors = false;
    srv.ctx.flags.paranormal = false;
    const live = await fetchServerFlags({ url });
    assert.equal(live?.mirrors, false);
    assert.equal(live?.paranormal, false);
    const merged = mergeFlags({ ...readFlags(), mirrors: true, paranormal: true }, live);
    assert.equal(merged.mirrors, false, 'server flag wins over the bundled copy');
    assert.equal(merged.paranormal, false);

    // reloadConfig re-reads config/flags.json into the same object: /healthz follows it
    srv.ctx.reloadConfig();
    assert.deepEqual(((await (await fetch(url)).json()) as { flags: unknown }).flags, readFlags());
    assert.equal(srv.ctx.flags.mirrors, readFlags().mirrors ?? was);
  } finally {
    await srv.close();
  }
});
