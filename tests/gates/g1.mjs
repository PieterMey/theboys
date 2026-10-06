#!/usr/bin/env node
// Gate G1 (owner: track ① Net) "walk together": build, server on a free port serving the production build
// (NODE_ENV=test: crews auto-create, dbg.net.teleport available; G1_MODE=dev uses `--dev` for all dbg.*),
// optionally ONE cloudflared quick tunnel for that port (never retried in a loop; killed at the end),
// 3 Chrome players (separate processes; fake mics talk_en / tone440 / silence) through the tunnel URL
// (fallback: localhost) join one crew, then:
//   movement  : each moves >= 5 m by __game.setInput with server-accepted poses (seen in others' snapshots)
//   errors    : 0 console / page / WebGPU errors
//   render    : backend webgpu (+ a ?webgl=1 client), centre luminance > threshold with the flashlight on
//   aud       : snapshots carry per-speaker path distance
//   voice     : __voiceDebug: bytesReceived > 0 and RMS > 0.01 for an audible pair; a peer on the left gives
//               rmsL - rmsR >= 6 dB; a peer beyond its radius (sealed van cab or far away) < 0.001 RMS
//   relay     : relay-only TURN test if CF_TURN_KEY_ID is set (else SKIP)
// Missing features print 'SKIP (feature missing: ...)' instead of failing. Exit 0 only if all non-skipped pass.
// Env: G1_BASE (use an already running server, skip build/start), G1_PORT, G1_MODE=test|dev, G1_TUNNEL=0|1 (default 1),
//      G1_WEBGL=0|1 (default 1), G1_HEADFUL=1.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { launchPlayer, screenshot } from '../lib/launch.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ART = join(ROOT, 'tests/artifacts/g1');
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (name, status, info = '') => {
  results.push({ name, status, info });
  console.log(`${status.padEnd(4)}  ${name}${info ? `  (${info})` : ''}`);
};
const ok = (name, pass, info = '') => { rec(name, pass ? 'PASS' : 'FAIL', info); return !!pass; };
const skip = (name, why, raw = false) => rec(name, 'SKIP', raw || why.startsWith('feature missing') ? why : `feature missing: ${why}`);
const env = process.env;
const MODE = env.G1_MODE === 'dev' ? 'dev' : 'test';
const children = [];
const G1_METRICS = '127.0.0.1:20243';

function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function getJson(url, ms = 1500) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}
function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

// ---------------------------------------------------------------- build + server
let BASE = env.G1_BASE ?? '';
let LOCAL = BASE;
let serverLog = '';
if (!BASE) {
  const t0 = Date.now();
  const b = spawnSync('npm run build', { cwd: ROOT, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!ok('npm run build', b.status === 0, `${Date.now() - t0} ms`)) {
    console.log(`${b.stdout}${b.stderr}`.split('\n').slice(-25).join('\n'));
    await abort();
  }
  const PORT = Number(env.G1_PORT ?? (await freePort()));
  const args = MODE === 'dev' ? ['apps/server/src/index.ts', '--dev'] : ['apps/server/src/index.ts'];
  const srv = spawn(process.execPath, args, {
    cwd: ROOT,
    // CF_METRICS: the server's /api/invite reads the gate's own tunnel (never the host's on :20241)
    env: { ...env, PORT: String(PORT), NODE_ENV: MODE === 'dev' ? 'development' : 'test', AI_MODE: 'mock', NET_SESSION: '0', CF_METRICS: G1_METRICS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(srv.pid);
  srv.stdout.on('data', (d) => (serverLog += d));
  srv.stderr.on('data', (d) => (serverLog += d));
  LOCAL = `http://127.0.0.1:${PORT}`;
  let up = false;
  const t1 = Date.now();
  while (!up && Date.now() - t1 < 30_000) { up = (await getJson(`${LOCAL}/healthz`))?.ok === true; if (!up) await sleep(200); }
  if (!ok(`server up (${MODE} mode, built client) on :${PORT}`, up, `${Date.now() - t1} ms`)) { console.log(serverLog.slice(-3000)); await abort(); }
  BASE = LOCAL;

  // ---- one quick tunnel for this port (never retried) ----
  const exe = join(ROOT, 'tools/bin/cloudflared.exe');
  if (env.G1_TUNNEL === '0') skip('tunnel', 'disabled by G1_TUNNEL=0: players use localhost', true);
  else if (!existsSync(exe)) skip('tunnel', 'tools/bin/cloudflared.exe missing: players use localhost');
  else {
    const metrics = G1_METRICS;
    const pidFile = join(ART, 'tunnel.pid');
    if (existsSync(pidFile)) killTree(Number(readFileSync(pidFile, 'utf8'))); // leftover from a crashed run
    const fd = openSync(join(ART, 'cloudflared.log'), 'w');
    const cf = spawn(exe, ['tunnel', '--url', LOCAL, '--metrics', metrics, '--no-autoupdate'], { cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true });
    children.push(cf.pid);
    writeFileSync(pidFile, String(cf.pid));
    let host = null;
    const t2 = Date.now();
    while (!host && Date.now() - t2 < 45_000) {
      const j = await getJson(`http://${metrics}/quicktunnel`, 1000);
      host = j?.hostname || null;
      if (!host) await sleep(500);
    }
    if (host) {
      // the edge needs a moment before the hostname resolves everywhere
      let reach = false;
      const t3 = Date.now();
      while (!reach && Date.now() - t3 < 60_000) { reach = (await getJson(`https://${host}/healthz`, 4000))?.ok === true; if (!reach) await sleep(1000); }
      if (reach) { ok('quick tunnel reachable', true, `https://${host} (${((Date.now() - t2) / 1000).toFixed(0)} s)`); BASE = `https://${host}`; }
      else if (env.G1_REQUIRE_TUNNEL === '1') ok('quick tunnel reachable', false, `https://${host} not reachable in 60 s`);
      else skip('quick tunnel reachable', `edge did not answer https://${host} within 60 s (Cloudflare DNS); players use localhost (G1_REQUIRE_TUNNEL=1 makes this a FAIL)`, true);
      const inv = await getJson(`${LOCAL}/api/invite?code=GONE`);
      inv ? ok('/api/invite returns the tunnel link', typeof inv.url === 'string' && inv.url.startsWith('https://'), inv.url ?? 'null') : skip('/api/invite', 'route missing');
    } else ok('quick tunnel hostname', false, 'no hostname after 45 s; using localhost');
  }
}

// ---------------------------------------------------------------- players
const CREW = `G${'BCDFGHJKLMNPQRSTVWXZ'[Date.now() % 20]}${'BCDFGHJKLMNPQRSTVWXZ'[Math.floor(Date.now() / 20) % 20]}N`;
const WAVS = ['talk_en.wav', 'tone440.wav', 'silence.wav'];
const NAMES = ['Ann', 'Bob', 'Cy'];
const players = [];
try {
  for (let i = 0; i < 3; i++) {
    players.push(await launchPlayer({ name: NAMES[i], wav: WAVS[i], baseUrl: BASE, crew: CREW, query: { autojoin: '1' }, headless: env.G1_HEADFUL !== '1' }));
  }
  const joined = await Promise.all(players.map((p) => p.page.waitForFunction(() => window.__game?.me() != null && window.__game.state().net === 'joined', undefined, { timeout: 60_000 }).then(() => true, () => false)));
  ok(`3 Chrome players joined crew ${CREW} via ${BASE.startsWith('https') ? 'tunnel' : 'localhost'}`, joined.every(Boolean), joined.join(','));
  if (!joined.every(Boolean)) {
    for (let i = 0; i < players.length; i++) {
      const g = await players[i].page.evaluate(() => ({ has: !!window.__game, errs: window.__game?.errors() ?? [], net: window.__game?.state()?.net ?? null })).catch((e) => ({ has: false, errs: [String(e)], net: null }));
      console.log(`      ${NAMES[i]}: __game=${g.has} net=${g.net} errors=${JSON.stringify([...players[i].errors, ...g.errs].slice(0, 4)).slice(0, 600)}`);
      await screenshot(players[i].page, join(ART, `join-fail-${i + 1}.png`)).catch(() => {});
    }
    throw new Error('join failed');
  }
  const ids = await Promise.all(players.map((p) => p.page.evaluate(() => window.__game.me())));
  const crewSize = await players[0].page.evaluate(() => window.__game.state().crew?.players?.length ?? 0);
  ok('one crew with 3 players', crewSize === 3, String(crewSize));
  const ready = await Promise.all(players.map((p) => p.page.waitForFunction(() => window.__game.ready(), undefined, { timeout: 30_000 }).then(() => true, () => false)));
  if (!ready.every(Boolean)) {
    const pend = await players[0].page.evaluate(() => window.__game.state().pending);
    rec('__game.ready() on all clients', 'FAIL', `pending: ${JSON.stringify(pend)}`);
  } else ok('__game.ready() on all clients', true);
  // one-time setup screens (e.g. meta's brightness check) freeze input in fresh browser profiles: confirm them
  for (const p of players) await dismissScreens(p.page);
  const svc = await players[0].page.evaluate(() => window.__netDebug?.services() ?? null);
  console.log('      services:', JSON.stringify(svc));

  // ---- facility (optional) ----
  const gen = await players[0].page.evaluate(async () => {
    try { return { ok: true, r: await window.__game.dbg('level.generate', { seed: 'g1', players: 3, risk: 1 }) }; } catch (e) { return { ok: false, err: String(e?.message ?? e) }; }
  });
  if (gen.ok) {
    const phased = await Promise.all(players.map((p) => p.page.waitForFunction(() => window.__game.state().layout != null, undefined, { timeout: 20_000 }).then(() => true, () => false)));
    ok('dbg.level.generate -> facility on all clients', phased.every(Boolean), JSON.stringify(gen.r).slice(0, 80));
    await Promise.all(players.map((p) => p.page.waitForFunction(() => window.__game.ready(), undefined, { timeout: 30_000 }).catch(() => {})));
    for (const p of players) await dismissScreens(p.page);
  } else skip('dbg.level.generate', gen.err.includes('unknown request') ? `dbg.level.generate not registered (${MODE} mode)` : gen.err);
  const layout = await players[0].page.evaluate(() => { const L = window.__netDebug?.layout(); return L ? { W: L.W, H: L.H, kind: L.kind } : null; });
  console.log('      layout:', JSON.stringify(layout));

  // ---- movement: >= 5 m each, server-accepted (as seen by another client) ----
  if (!svc?.input) skip('movement >= 5 m (setInput)', 'services.input (players track) not provided');
  else {
    const watch = async (obsIdx, id) => players[obsIdx].page.evaluate((pid) => window.__game.state().players.find((q) => q.id === pid)?.p ?? null, id);
    const paths = [0, 0, 0];
    const last = await Promise.all(ids.map((id, i) => watch((i + 1) % 3, id)));
    await Promise.all(players.map((p, i) => p.page.evaluate((yaw) => { window.__game.look(yaw, 0); window.__game.setInput({ forward: 1 }); }, (i * 2 * Math.PI) / 3)));
    for (let k = 0; k < 24; k++) {
      await sleep(250);
      if (k % 6 === 5) await Promise.all(players.map((p, i) => p.page.evaluate((yaw) => window.__game.look(yaw, 0), ((i * 2 * Math.PI) / 3) + (k / 6) * 1.6)));
      const now = await Promise.all(ids.map((id, i) => watch((i + 1) % 3, id)));
      now.forEach((p, i) => { if (p && last[i]) paths[i] += Math.hypot(p[0] - last[i][0], p[2] - last[i][2]); last[i] = p ?? last[i]; });
    }
    await Promise.all(players.map((p) => p.page.evaluate(() => window.__game.setInput({ forward: 0 }))));
    const corr = await Promise.all(players.map((p) => p.page.evaluate(() => window.__netDebug?.stat().corrections ?? 0)));
    paths.forEach((d, i) => ok(`${NAMES[i]} moved >= 5 m (server-accepted, seen by ${NAMES[(i + 1) % 3]})`, d >= 5, `${d.toFixed(1)} m, corrections ${corr[i]}`));
  }

  // ---- aud in snapshots ----
  const aud = await players[2].page.evaluate(() => window.__netDebug?.aud() ?? null);
  ok('snapshot aud has a path distance for both other players', !!aud && ids.slice(0, 2).every((id) => typeof aud[id] === 'number'), JSON.stringify(aud));

  // ---- render: backend, luminance (flashlight), screenshots ----
  for (let i = 0; i < 3; i++) await screenshot(players[i].page, join(ART, `player${i + 1}.png`));
  const backend = await players[0].page.evaluate(() => window.__game.backend());
  backend === 'none' ? skip('backend webgpu', 'no renderer') : ok('backend webgpu', backend === 'webgpu', backend);
  const lum = centreLuminance(join(ART, 'player1.png'));
  const hasRender = svc?.render || svc?.three;
  hasRender ? ok('centre luminance (flashlight cone) > 0.03', lum > 0.03, lum.toFixed(3)) : skip('centre luminance', 'no render service');
  const perf = await players[0].page.evaluate(() => window.__game.perf());
  console.log('      perf:', JSON.stringify(perf));
  const nst = await Promise.all(players.map((p) => p.page.evaluate(() => window.__netDebug?.stat() ?? null)));
  console.log('      net:', nst.map((n) => (n ? `rtt ${n.rtt.toFixed(0)} ms, jitter ${n.jitterMs.toFixed(0)} ms, interp ${n.interpDelayMs.toFixed(0)} ms, ${n.snapHz.toFixed(1)} Hz` : '-')).join(' | '));

  // ---- voice ----
  const hasVoice = await players[2].page.evaluate(() => !!window.__voiceDebug);
  if (!hasVoice) skip('voice checks', 'window.__voiceDebug (voice track) not present');
  else if (!svc?.input) skip('voice placement', 'services.input missing: cannot place peers');
  else {
    // listener = Cy (silence) facing +Z; Ann (talk) 2 m to the left (+X when facing +Z); Bob (tone) far / sealed
    const L = await players[2].page.evaluate(() => window.__netDebug.self()?.p ?? null);
    const lay = await players[2].page.evaluate(() => { const l = window.__netDebug.layout(); return l ? { W: l.W, H: l.H, owner: l.owner, cab: l.van?.cab ?? null } : null; });
    const walkable = (x, z) => !lay || (x >= 0 && z >= 0 && x < lay.W && z < lay.H && lay.owner[Math.floor(z) * lay.W + Math.floor(x)] >= 0);
    let side = 1;
    if (L && !walkable(L[0] + 2, L[2])) side = -1;
    const S1 = L ? [L[0] + 2 * side, L[2]] : [2, 0];
    let S2 = null;
    if (lay?.cab) S2 = [lay.cab.x + lay.cab.w / 2, lay.cab.y + lay.cab.h / 2];
    else if (lay) {
      let best = -1;
      for (let z = 0; z < lay.H; z++) for (let x = 0; x < lay.W; x++) {
        if (lay.owner[z * lay.W + x] < 0) continue;
        const d = Math.hypot(x + 0.5 - L[0], z + 0.5 - L[2]);
        if (d > best) { best = d; S2 = [x + 0.5, z + 0.5]; }
      }
    } else S2 = [L[0] + 60, L[2]];
    await players[2].page.evaluate(([x, z]) => { window.__game.teleport(x, z, 0); window.__game.look(0, 0); }, [L[0], L[2]]);
    await players[0].page.evaluate(([x, z]) => window.__game.teleport(x, z, Math.PI), S1);
    await players[1].page.evaluate(([x, z]) => window.__game.teleport(x, z, 0), S2);
    await sleep(6000);
    const audL = await players[2].page.evaluate(() => window.__netDebug.aud());
    console.log(`      placement: listener ${L?.map((v) => v.toFixed(1))} talk@${S1.map((v) => v.toFixed(1))} (${side > 0 ? 'left' : 'right'}) far@${S2.map((v) => v.toFixed(1))} aud=${JSON.stringify(audL)}`);
    // RMS is instantaneous and speech has pauses: sample 4 s at 10 Hz and judge the window
    const samples = [];
    for (let k = 0; k < 40; k++) {
      samples.push(await players[2].page.evaluate(() => window.__voiceDebug.peers()));
      await sleep(100);
    }
    const peers = samples[samples.length - 1];
    writeFileSync(join(ART, 'voice-peers.json'), JSON.stringify({ last: peers, samples: samples.map((x) => ({ a: x[ids[0]], b: x[ids[1]] })) }, null, 1));
    const a = peers[ids[0]], b = peers[ids[1]];
    if (!a) ok('voice: listener has a peer link to the talker', false, Object.keys(peers).join(','));
    else {
      ok('voice: bytesReceived > 0 from the talker', a.bytesReceived > 0, String(a.bytesReceived));
      const sa = samples.map((x) => x[ids[0]]).filter(Boolean);
      const maxRms = Math.max(...sa.map((q) => Math.max(q.rmsL, q.rmsR)));
      ok('voice: audible pair RMS > 0.01 (max over 4 s)', maxRms > 0.01, maxRms.toFixed(4));
      const loud = sa.filter((q) => Math.max(q.rmsL, q.rmsR) > 0.002);
      const sl = loud.reduce((t, q) => t + q.rmsL, 0), sr = loud.reduce((t, q) => t + q.rmsR, 0);
      const db = loud.length ? 20 * Math.log10((side > 0 ? sl : sr) / Math.max(1e-9, side > 0 ? sr : sl)) : -Infinity;
      ok(`voice: peer on the ${side > 0 ? 'left' : 'right'} -> ${side > 0 ? 'rmsL - rmsR' : 'rmsR - rmsL'} >= 6 dB`, db >= 6, `${db.toFixed(1)} dB over ${loud.length} voiced samples`);
    }
    if (!b) ok('voice: listener has a peer link to the far peer', false, Object.keys(peers).join(','));
    else {
      const sb = samples.map((x) => x[ids[1]]).filter(Boolean);
      const maxB = Math.max(...sb.map((q) => Math.max(q.rmsL, q.rmsR)));
      ok('voice: peer beyond radius < 0.001 RMS (max over 4 s)', maxB < 0.001, `rms ${maxB.toFixed(5)}, aud ${audL[ids[1]]}`);
    }
  }

  // ---- relay-only TURN ----
  if (!env.CF_TURN_KEY_ID) skip('relay-only TURN test', 'CF_TURN_KEY_ID not configured');
  else {
    const r = [];
    try {
      for (let i = 0; i < 2; i++) r.push(await launchPlayer({ name: `Relay${i}`, wav: i ? 'silence.wav' : 'talk_en.wav', baseUrl: BASE, crew: `${CREW}R`, query: { autojoin: '1', relay: '1' } }));
      await Promise.all(r.map((p) => p.page.waitForFunction(() => window.__game?.me() != null, undefined, { timeout: 60_000 })));
      const rid = await r[0].page.evaluate(() => window.__game.me());
      await r[1].page.waitForFunction((id) => (window.__voiceDebug?.peers()[id]?.bytesReceived ?? 0) > 0, rid, { timeout: 30_000 }).catch(() => {});
      await sleep(3000);
      const pr = await r[1].page.evaluate((id) => window.__voiceDebug?.peers()[id] ?? null, rid);
      ok('relay-only: selected candidate is relay', pr?.candidate === 'relay', pr?.candidate ?? 'no peer');
      ok('relay-only: RMS > 0.01', !!pr && Math.max(pr.rmsL, pr.rmsR) > 0.01, pr ? Math.max(pr.rmsL, pr.rmsR).toFixed(4) : '-');
    } catch (e) {
      ok('relay-only TURN test', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
    } finally {
      for (const p of r) await p.close();
    }
  }

  // ---- errors ----
  const errs = [];
  for (let i = 0; i < 3; i++) {
    errs.push(...players[i].errors.map((e) => `${NAMES[i]}: ${e}`));
    errs.push(...(await players[i].page.evaluate(() => window.__game.errors())).map((e) => `${NAMES[i]}: ${e}`));
  }
  writeFileSync(join(ART, 'errors.json'), JSON.stringify(errs, null, 1));
  ok('0 console / page / WebGPU errors (3 clients)', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 400));
} catch (e) {
  ok('G1 run', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
} finally {
  for (const p of players) await p.close().catch(() => {});
}

// ---- WebGL2 client (localhost) ----
if (env.G1_WEBGL !== '0') {
  let p = null;
  try {
    p = await launchPlayer({ name: 'Gl', baseUrl: LOCAL || BASE, webgl: true, crew: `${CREW}W`, query: { autojoin: '1' } });
    await p.page.waitForFunction(() => window.__game?.ready(), undefined, { timeout: 45_000 });
    await dismissScreens(p.page);
    await sleep(800);
    const be = await p.page.evaluate(() => window.__game.backend());
    ok('?webgl=1 backend webgl2', be === 'webgl2', be);
    await screenshot(p.page, join(ART, 'webgl.png'));
    const lum = centreLuminance(join(ART, 'webgl.png'));
    ok('?webgl=1 centre luminance > 0.03', lum > 0.03, lum.toFixed(3));
    const e2 = [...p.errors, ...(await p.page.evaluate(() => window.__game.errors()))];
    ok('?webgl=1 0 errors', e2.length === 0, e2.slice(0, 3).join(' | ').slice(0, 300));
  } catch (e) {
    ok('?webgl=1 client ready', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  } finally {
    await p?.close().catch(() => {});
  }
}
finish();

/** Click the primary button of any blocking screen (one-time setup / brightness check) until the game screen is 'none'. */
async function dismissScreens(page) {
  for (let i = 0; i < 5; i++) {
    const screen = await page.evaluate(() => window.__game?.state()?.screen ?? 'none').catch(() => 'none');
    if (!screen || screen === 'none') return;
    const btn = (await page.$('.screen .btn.primary')) ?? (await page.$('.screen button.primary')) ?? (await page.$('.screen .primary'));
    if (!btn) { console.log(`      screen '${screen}' has no primary button; leaving it`); return; }
    console.log(`      dismissing screen '${screen}'`);
    await btn.click().catch(() => {});
    await sleep(400);
  }
}

async function abort() {
  finish();
  await new Promise(() => {}); // finish() exits shortly
}

function centreLuminance(file) {
  try {
    const png = PNG.sync.read(readFileSync(file));
    const { width: w, height: h, data } = png;
    let sum = 0, n = 0;
    for (let y = Math.floor(h * 0.35); y < h * 0.65; y += 2) for (let x = Math.floor(w * 0.35); x < w * 0.65; x += 2) {
      const i = (y * w + x) * 4;
      sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      n++;
    }
    return n ? sum / n : 0;
  } catch {
    return 0;
  }
}

function finish() {
  for (const pid of children) killTree(pid);
  const pidFile = join(ART, 'tunnel.pid');
  if (existsSync(pidFile)) writeFileSync(pidFile, '');
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const sk = results.filter((r) => r.status === 'SKIP');
  console.log('\n+------+------------------------------------------------------------------');
  for (const r of results) console.log(`| ${r.status.padEnd(4)} | ${r.name}${r.info ? `  [${String(r.info).slice(0, 120)}]` : ''}`);
  console.log('+------+------------------------------------------------------------------');
  console.log(`G1 ${fail.length ? 'FAILED' : 'PASSED'}: ${pass.length} pass, ${fail.length} fail, ${sk.length} skip   artifacts: tests/artifacts/g1/`);
  process.exitCode = fail.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 1000).unref();
}
