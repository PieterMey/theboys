// v1.3 telemetry v2 (P5): the client buckets (GPU / browser / OS / LoAF script) and the server's 'core.diag' request
// (validation, rate limits, the log lines: player id only, never a name, never a raw renderer string) + the protocol
// ping RTT (core/ws.ts, P8) that the window line prints next to the app RTT.
//   node --test tests/core/diag.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserOf, gpuBucket, loafTop, osOf } from '../../apps/client/src/core/diag.ts';
import { createJoinLimiter, diagToken, formatDiagJoin, formatDiagWindow, parseDiagJoin, parseDiagWindow } from '../../apps/server/src/core/diag.ts';
import { boot } from '../../apps/server/src/core/boot.ts';
import { pingRttOf } from '../../apps/server/src/core/ws.ts';
import { TestClient, sleep } from './lib.ts';

test('GPU buckets: vendor + tier from renderer strings and WebGPU adapter info', () => {
  const cases: [string, string, string][] = [
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'nvidia', 'high'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB (0x00001C03) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'nvidia', 'low'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', 'nvidia', 'mid'],
    ['ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'nvidia', 'low'],
    ['nvidia blackwell', 'nvidia', 'high'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'intel', 'igpu'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'intel', 'mid'],
    ['intel gen-12lp', 'intel', 'igpu'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'amd', 'igpu'],
    ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'amd', 'high'],
    ['ANGLE (AMD, Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)', 'amd', 'low'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'google', 'software'],
    ['Microsoft Basic Render Driver', 'microsoft', 'software'],
    ['Apple M2', 'apple', 'igpu'],
    ['Adreno (TM) 740', 'qualcomm', 'igpu'],
    ['', 'unknown', 'unknown'],
    ['Some Future GPU 9000', 'other', 'unknown'],
  ];
  for (const [s, vendor, tier] of cases) assert.deepEqual(gpuBucket(s), { vendor, tier }, s);
});

test('browser + OS buckets (UA-CH brands first, then the UA string; Electron = the desktop app)', () => {
  const chromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  assert.equal(browserOf(chromeUa, [{ brand: 'Not)A;Brand', version: '99' }, { brand: 'Google Chrome', version: '141' }, { brand: 'Chromium', version: '141' }]), 'chrome 141');
  assert.equal(browserOf(`${chromeUa} Edg/140.0.0.0`, [{ brand: 'Microsoft Edge', version: '140' }, { brand: 'Chromium', version: '140' }]), 'edge 140');
  assert.equal(browserOf(`${chromeUa} Edg/140.0.0.0`, null), 'edge 140');
  assert.equal(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0'), 'firefox 143');
  assert.equal(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'safari 18');
  assert.equal(browserOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) DEADAIR/1.2 Chrome/152.0.0.0 Electron/44.5.1 Safari/537.36'), 'electron 44');
  assert.equal(browserOf('curl/8'), 'other 0');
  assert.equal(osOf(chromeUa, 'Windows'), 'windows');
  assert.equal(osOf(chromeUa), 'windows');
  assert.equal(osOf('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(osOf('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
  assert.equal(osOf('', 'macOS'), 'mac');
  assert.equal(osOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
});

test('LoAF top script: invoker + file basename + function, query strings and odd characters dropped', () => {
  const t = loafTop({ scripts: [
    { duration: 3, invokerType: 'event-listener', invoker: 'WebSocket.onmessage', sourceURL: 'https://x/app/net-abc.js?v=1', sourceFunctionName: 'onMessage' },
    { duration: 900, invokerType: 'user-callback', invoker: 'FrameRequestCallback', sourceURL: 'https://play.example/app/index-Bx12.js?token=secret#x', sourceFunctionName: 'frame' },
  ] });
  assert.equal(t, 'user-callback:FrameRequestCallback@index-Bx12.js:frame');
  // a production chunk's 8-character content hash is cut: the token reads the same across deploys
  const prod = (url: string) => loafTop({ scripts: [{ duration: 50, invokerType: 'user-callback', invoker: 'FrameRequestCallback', sourceURL: url, sourceFunctionName: 'frame' }] });
  assert.equal(prod('https://play.example/app/core-DSbxmZKD.js'), 'user-callback:FrameRequestCallback@core.js:frame');
  assert.equal(prod('https://play.example/app/three.webgpu-B-12x_Yz.js?x=1'), 'user-callback:FrameRequestCallback@three.webgpu.js:frame');
  assert.equal(prod('http://127.0.0.1:3890/src/core/loop.ts?t=17'), 'user-callback:FrameRequestCallback@loop.ts:frame', 'dev modules stay as they are');
  assert.equal(loafTop({ scripts: [] }), 'no-script');
  assert.ok(!loafTop({ scripts: [{ duration: 1, invoker: 'a b <c>', sourceURL: 'x' }] }).includes(' '));
});

test('server validation: unknown values fall back, numbers clamp, free text is a short token, no names in the lines', () => {
  const j = parseDiagJoin({ kind: 'join', gpuVendor: 'NVIDIA GeForce RTX 5090 (0x2B85)', gpuTier: 'high', backend: 'webgl2', fallback: 'no-adapter',
    browser: 'chrome 141', os: 'windows', shell: 'browser', cores: 9999, memGB: 8, parallel: true, preset: 'low', presetSource: 'auto', name: 'Sanne' });
  assert.equal(j.gpuVendor, 'unknown', 'a raw renderer string is not a vendor bucket');
  assert.equal(j.cores, 256);
  const line = formatDiagJoin('pABC', j);
  assert.equal(line, 'pABC join: gpu unknown/high webgl2 (no webgpu: no-adapter) | chrome 141 windows browser | cores 256 mem 8 GB | parallel-compile yes | preset low (auto)');
  assert.ok(!line.includes('Sanne') && !line.includes('5090'));
  const bad = parseDiagJoin({ browser: 'Mozilla/5.0 (X11)', preset: '<script>', backend: 'opengl', why: 'evil' });
  assert.equal(bad.browser, '?');
  assert.equal(bad.preset, '?');
  assert.equal(bad.backend, 'none');
  assert.equal(bad.why, 'join');
  const w = parseDiagWindow({ kind: 'window', sec: 30, frames: 412, gapMax: 1532.4, hiddenMs: -5, loaf: { n: 6, blockMs: 2210, maxMs: 1480, top: `user-callback:Frame@index.js ${'A'.repeat(40)} <b>` },
    pipes: { total: 140, created: 12, nodes: 180, nodesNew: 20 }, draws: { p50: 120, max: 180 }, rtt: 130, voiceSkipped: 3, preset: 'low', phase: 'contract',
    preload: { asked: 0, reply: 812, built: 1200, done: 9100, ok: true, early: true } });
  assert.equal(w.hiddenMs, 0);
  assert.ok(w.loaf!.top.includes('<redacted>') && !w.loaf!.top.includes('<b>'));
  const wl = formatDiagWindow('pABC', w, { p50: 45, max: 80, n: 6 });
  assert.match(wl, /^pABC 30s contract\/low: frames 412 gapMax 1532 ms \| loaf 6 blocked 2210 ms max 1480 ms top user-callback:Frame@index.js <redacted> b \| pipes \+12 \(=140\) nodes \+20 \(=180\) \| draws 120\/180 \| rtt app 130 ws 45\/80 ms \| voice skipped 3 \| preload early ask 0 reply 812 build 1200 done 9100 ms$/);
  assert.equal(diagToken('a'.repeat(200), 20), '<redacted>', 'an id-like run never passes');
  assert.ok(diagToken('ab cd '.repeat(50), 20).length <= 20);
});

test('join lines (createJoinLimiter): the first, then a new preset / backend at most every 5 s and 10 per 10 min', () => {
  const MIN = 60_000;
  const lim = createJoinLimiter();
  assert.equal(lim.allow('p1', 'webgl2/low', 0), true, 'the first join is written');
  // the review probe: 400 reports in 73 ms with cores 1..200 (backend + preset unchanged) -> no further line
  let n = 0;
  for (let i = 0; i < 400; i++) if (lim.allow('p1', 'webgl2/low', i * 0.18)) n++;
  assert.equal(n, 0, 'a flood writes nothing more');
  assert.equal(lim.allow('p1', 'webgl2/medium', 4_000), false, 'a new preset inside 5 s is dropped');
  assert.equal(lim.allow('p1', 'webgl2/medium', 5_000), true, 'a new preset after 5 s is written');
  assert.equal(lim.allow('p1', 'webgpu/medium', 9_000), false, 'the next change waits 5 s again');
  assert.equal(lim.allow('p1', 'webgpu/medium', 10_000), true, 'a new backend');
  assert.equal(lim.allow('p1', 'webgpu/medium', 10_000 + 9 * MIN), false, 'the same report: not again within 10 min');
  assert.equal(lim.allow('p1', 'webgpu/medium', 10_000 + 10 * MIN), true, 'but again after 10 min (a later reconnect)');
  // a client that flips its preset every 5 s for 10 min writes 10 lines, the first included
  const l2 = createJoinLimiter();
  let written = 0;
  for (let i = 0; i < 120; i++) if (l2.allow('p2', i % 2 ? 'webgl2/low' : 'webgl2/high', i * 5_000)) written++;
  assert.equal(written, 10);
  assert.equal(l2.allow('p2', 'webgpu/high', 10 * MIN + 1), true, 'the budget refills as old lines age out');
  // players are independent; prune drops lapsed state only
  assert.equal(l2.allow('p3', 'webgl2/low', 10 * MIN + 1), true);
  assert.equal(l2.size, 2);
  l2.prune(20 * MIN);
  assert.equal(l2.size, 2, 'both wrote within the last 10 min');
  l2.prune(20 * MIN + 1);
  assert.equal(l2.size, 0);
});

test('core.diag on a real server: join + window lines (id only), repeats dropped, ws ping RTT next to the app RTT', async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { const s = a.map(String).join(' '); if (s.includes('[diag]') || s.includes('[ws]')) lines.push(s); };
  const srv = await boot({ mode: 'test', port: 0, tracks: [] });
  const c = new TestClient('Sanne');
  try {
    const w = await c.connect(srv.port, 'DIAG');
    const join = { kind: 'join', why: 'join', gpuVendor: 'intel', gpuTier: 'igpu', backend: 'webgl2', fallback: 'no-adapter', browser: 'chrome 141', os: 'windows',
      shell: 'browser', cores: 8, memGB: 8, parallel: false, preset: 'low', presetSource: 'auto' };
    assert.deepEqual(await c.req('core.diag', join), { ok: true });
    assert.deepEqual(await c.req('core.diag', join), { ok: true }, 'a repeat is accepted');
    // the review probe: a modified client sends 200 reports with changing noise (cores 1..200) at once
    const flood = await Promise.all(Array.from({ length: 200 }, (_, i) => c.req('core.diag', { ...join, cores: i + 1 })));
    assert.ok(flood.every((r) => (r as { ok?: boolean }).ok === true));
    assert.equal(lines.filter((l) => l.includes('[diag]') && / (join|preset|backend): /.test(l)).length, 1, 'but logged once');
    await c.req('core.diag', { ...join, why: 'preset', preset: 'medium' });
    assert.equal(lines.filter((l) => l.includes('[diag]') && l.includes('preset medium')).length, 0, 'a change inside 5 s of the last line waits');
    await sleep(5_100);
    await c.req('core.diag', { ...join, why: 'preset', preset: 'medium' });
    assert.equal(lines.filter((l) => l.includes('[diag]') && l.includes('preset medium')).length, 1, 'a change after 5 s is logged');
    // wait for one protocol ping round trip (core/ws.ts pings every 5 s)
    const sock = srv.ctx.crews.get('DIAG')!.players.get(w.you)!.socket;
    for (let i = 0; i < 70 && !pingRttOf(sock); i++) await sleep(100);
    const rtt = pingRttOf(sock);
    assert.ok(rtt && rtt.n >= 1 && rtt.p50 >= 0 && rtt.p50 < 1000, `ping rtt ${JSON.stringify(rtt)}`);
    const win = { kind: 'window', sec: 30, frames: 1800, gapMax: 40, hiddenMs: 0, loaf: null, pipes: null, draws: null, rtt: 12, voiceSkipped: 0, preset: 'low', phase: 'hub' };
    assert.deepEqual(await c.req('core.diag', win), { ok: true });
    assert.deepEqual(await c.req('core.diag', win), { ok: false }, 'a second window within 20 s is dropped');
    const wl = lines.filter((l) => l.includes('30s hub/low'));
    assert.equal(wl.length, 1);
    assert.match(wl[0], new RegExp(`${w.you} 30s hub/low: frames 1800 gapMax 40 ms \\| loaf - \\| pipes - \\| draws - \\| rtt app 12 ws \\d+/\\d+ ms`));
    assert.deepEqual(await c.req('core.diag', { kind: 'nope' }), { ok: false });
    for (const l of lines) assert.ok(!l.includes('Sanne'), `no name in: ${l}`);
  } finally {
    console.log = orig;
    await c.close();
    await srv.close();
  }
});
