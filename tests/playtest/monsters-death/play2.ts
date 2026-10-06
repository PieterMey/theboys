// Playtest driver (report-only): MONSTERS, DEATH, SPECTATING, REVIVE with 3 real Chrome players on :3203.
//   node tests/playtest/monsters-death/play.ts [phases]   phases: comma list of hound,death,listener,mannequin (default all)
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { REPO, launchPlayer, waitForGame } from '../../lib/launch.ts';
import { decodeMsg } from '../../../packages/shared/src/envelope.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3203';
const CREW = process.env.CREW ?? 'MDTQ';
const OUT = join(REPO, 'tests/playtest/monsters-death');
const SHOTS = join(OUT, 'shots2');
mkdirSync(SHOTS, { recursive: true });
const LOG = join(OUT, 'play2.log');
const PHASES = new Set((process.argv[2] ?? 'hound,death,listener,mannequin').split(','));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a: unknown[]) => {
  const s = `[${((Date.now() - T0) / 1000).toFixed(1)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(s);
  appendFileSync(LOG, s + '\n');
};

interface Ev { t: number; e: string; d: any }
interface P { name: string; page: Page; cdp: CDPSession; ev: Ev[]; errors: string[]; id: string; close(): Promise<void> }

async function launch(name: string, wav: string): Promise<P> {
  const pl = await launchPlayer({ name, wav, baseUrl: BASE, crew: CREW, query: { autojoin: '1', nobright: '1' }, viewport: { width: 1600, height: 900 } });
  const page = pl.page;
  await page.routeWebSocket(/token=/, () => {});
  // a player who calibrated in the van (talk ~-21 dBFS) and uses push-to-talk (V) from the settings
  await page.addInitScript(() => {
    try {
      localStorage.setItem('deadair.voice.ptt', '1');
      localStorage.setItem('deadair.meta.settings', JSON.stringify({ ptt: true, brightnessDone: true, hints: true }));
      localStorage.setItem('deadair.voice.base', '-21');
      localStorage.setItem('deadair.voice.cal', JSON.stringify({ noiseDb: -75, talkDb: -21, whisperDb: -35, shoutDb: -8, at: Date.now() }));
    } catch { /* ignore */ }
  });
  const ev: Ev[] = [];
  page.on('websocket', (ws) => {
    if (!/\/ws(\?|$)/.test(ws.url())) return;
    ws.on('framereceived', (f) => {
      const b = f.payload as unknown;
      if (typeof b === 'string') return;
      const u = new Uint8Array(b as Buffer);
      if (u[0] !== 0) return;
      try {
        const m = decodeMsg(u) as { op: string; e?: string; d?: unknown };
        if (m.op === 'ev' && m.e && /^(monsters|interaction|players|objectives\.(alarm|horn))/.test(m.e) && m.e !== 'interaction.patch') ev.push({ t: Date.now(), e: m.e, d: m.d });
      } catch { /* ignore */ }
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const cdp = await page.context().newCDPSession(page);
  return { name, page, cdp, ev, errors: pl.errors, id: '', close: pl.close };
}

async function shot(p: P, name: string): Promise<string> {
  try {
    const r = (await p.cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    const f = join(SHOTS, `${name}.png`);
    writeFileSync(f, Buffer.from(r.data, 'base64'));
    log(`shot ${name}.png (${p.name})`);
    return f;
  } catch (e) {
    log(`shot ${name} FAILED: ${e}`);
    return '';
  }
}
const ev = <T>(p: P, fn: string, ...args: unknown[]): Promise<T> =>
  p.page.evaluate(([f, a]) => (window.__game as unknown as Record<string, (...x: unknown[]) => unknown>)[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const dbg = <T = any>(p: P, r: string, a: unknown = {}): Promise<T> => p.page.evaluate(([r2, a2]) => window.__game!.dbg(r2 as string, a2), [r, a] as const) as Promise<T>;
const req = <T = any>(p: P, r: string, a: unknown = {}): Promise<T> => p.page.evaluate(([r2, a2]) => window.__game!.req!(r2 as string, a2), [r, a] as const) as Promise<T>;
const ms = (p: P) => dbg<any>(p, 'monsters.state');
const agent = async (p: P, id: string) => { const m = await ms(p); if (!m.agents) { log('monsters runtime OFF (mode ' + m.mode + ')'); return { id, state: 'OFF', x: 0, z: 0 }; } return (m.agents as any[]).find((a) => a.id === id); };
const hold = async (p: P, key: string, msec: number) => { await p.page.keyboard.down(key); await sleep(msec); await p.page.keyboard.up(key); };
const evalJs = <T = any>(p: P, body: string): Promise<T> => p.page.evaluate((b) => (new Function(b))(), body) as Promise<T>;
const hud = (p: P) => evalJs<string>(p, `return [...document.querySelectorAll('[data-testid], .hud-chip, .ix-prompt, .ix-spec, .ix-death')].filter(e => e.offsetParent !== null || getComputedStyle(e).position==='fixed').map(e => (e.getAttribute('data-testid')||e.className)+': '+e.innerText.replace(/\\s+/g,' ').slice(0,160)).join(' | ')`);
const band = (p: P) => evalJs<number>(p, 'return window.__voiceDebug ? window.__voiceDebug.band() : -1');
const tp = (p: P, x: number, z: number, yaw = 0) => ev(p, 'teleport', x, z, yaw);
const look = (p: P, yaw: number, pitch = 0) => ev(p, 'look', yaw, pitch);
const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);
const alive = async (p: P, id: string) => { const s = await ev<any>(p, 'state'); return s.crew?.players?.find((q: any) => q.id === id)?.alive; };

/** poll a monster's state for ms, logging transitions */
async function watch(p: P, id: string, msec: number, label: string): Promise<string[]> {
  const seq: string[] = [];
  const t = Date.now();
  let last = '';
  while (Date.now() - t < msec) {
    const a = await agent(p, id).catch(() => null);
    if (a && a.state !== last) { last = a.state; seq.push(`${((Date.now() - t) / 1000).toFixed(1)}s:${a.state}@${a.x},${a.z}`); }
    await sleep(120);
  }
  log(`${label} ${id} states: ${seq.join(' -> ')}`);
  return seq;
}
const evSince = (p: P, t: number, re: RegExp) => p.ev.filter((e) => e.t >= t && re.test(e.e));
const brief = (e: Ev) => `${e.e}:${JSON.stringify(e.d).slice(0, 220)}`;

async function waitSmooth(p: P, msec = 40_000): Promise<number> {
  const t = Date.now();
  let worst = 999;
  while (Date.now() - t < msec) {
    worst = await evalJs<number>(p, 'return new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 12) requestAnimationFrame(f); else { let m = 0; for (let i = 1; i < ts.length; i++) m = Math.max(m, ts[i] - ts[i - 1]); res(m); } }; requestAnimationFrame(f); })');
    if (worst < 60) break;
  }
  return worst;
}
// ---------------------------------------------------------------- follow-up run (report-only)
const players: P[] = [];
const lmb = (p: P) => ev(p, 'setInput', { use: true }); // LMB equivalent: headless Chrome cannot pointer-lock
const ixAim = (p: P, x: number, y: number, z: number) => evalJs(p, `return window.__ix.aim(${x}, ${y}, ${z})`);
const ixTarget = (p: P) => evalJs<any>(p, 'return window.__ix ? window.__ix.target() : null');
const peers = (p: P) => evalJs<any>(p, 'return window.__voiceDebug ? window.__voiceDebug.peers() : null');
const pos = (p: P) => evalJs<number[]>(p, 'return window.__players.local().p');
try {
  const ann = await launch('Ann', 'shout.wav');
  const bob = await launch('Bob', 'talk_en.wav');
  const cat = await launch('Cat', 'callsign_boiler.wav');
  players.push(ann, bob, cat);
  for (const p of players) {
    await waitForGame(p.page, 90_000);
    await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 30_000 });
    p.id = (await ev<string>(p, 'me'))!;
  }
  log('joined', players.map((p) => `${p.name}=${p.id}`).join(' '));
  await ann.page.mouse.click(800, 450).catch(() => null);
  await sleep(500);
  log('pointer locked after click?', await evalJs(ann, 'return !!document.pointerLockElement'));
  const meta = await dbg<any>(ann, 'meta.state');
  const order = meta.orders.find((o: any) => o.available && o.risk === 1) ?? meta.orders[0];
  await req(ann, 'meta.pick', { orderId: order.id });
  for (const p of players) await req(p, 'meta.ready', { ready: true });
  await sleep(800);
  await dbg(ann, 'meta.skipDrive').catch(() => null);
  for (const p of players) await p.page.waitForFunction(() => (window.__game?.state() as { phase?: string }).phase === 'contract', undefined, { timeout: 40_000 });
  log('contract; worst frame', await waitSmooth(ann));
  const L = await evalJs<any>(ann, 'return window.__monstersLayout()');
  const sp = (id: number) => L.spaces[id];
  log('callsigns', L.spaces.filter((s: any) => s.callsign).map((s: any) => `${s.id}:${s.callsign}:${s.kind}:${s.rect.w}x${s.rect.h}`).join(' '));
  const rooms = L.spaces.filter((s: any) => (s.kind === 'room' || s.kind === 'hall') && s.callsign && s.callsign !== 'VAN');
  rooms.sort((a: any, b: any) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h));
  const R = rooms[0];
  const r = R.rect;
  const horiz = r.w >= r.h;
  const at = (f: number, g = 0.5): [number, number] => (horiz ? [r.x + 0.6 + (r.w - 1.2) * f, r.y + 0.6 + (r.h - 1.2) * g] : [r.x + 0.6 + (r.w - 1.2) * g, r.y + 0.6 + (r.h - 1.2) * f]);
  await dbg(ann, 'interaction.power', { zone: R.powerZone, on: true }).catch(() => null);
  await dbg(ann, 'interaction.setLights', { space: R.id, on: true }).catch(() => null);
  log(`test room ${R.id} ${R.callsign} ${R.kind} rect ${JSON.stringify(r)}`);
  await dbg(ann, 'monsters.place', { id: 'hound0', x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 });

  // ============ A. BOTTLE LURE
  log('================ A. BOTTLE');
  try {
    const hc = at(0.75);
    const [bx, bz] = at(0.1, 0.5);
    await tp(bob, bx, bz, yawTo(bx, bz, hc[0], hc[1]));
    await tp(ann, at(0.05, 0.1)[0], at(0.05, 0.1)[1], 0);
    await tp(cat, at(0.05, 0.9)[0], at(0.05, 0.9)[1], 0);
    await sleep(600);
    await dbg(ann, 'monsters.place', { id: 'hound0', x: hc[0], z: hc[1], state: 'idle', active: true });
    await dbg(bob, 'interaction.give', { type: 'bottle', count: 3 });
    await sleep(500);
    const inv = await evalJs<any>(bob, 'return window.__ix.inventory()');
    await bob.page.keyboard.press(`Digit${inv.findIndex((x: string | null) => x === 'bottle') + 1}`);
    await sleep(300);
    const tgt = at(0.95, 0.05);
    await look(bob, yawTo(bx, bz, tgt[0], tgt[1]), 0.15);
    await sleep(300);
    const t = Date.now();
    const w = watch(ann, 'hound0', 9000, 'A bottle thrown (Bob LMB)');
    await lmb(bob);
    await sleep(1200);
    await shot(bob, 'A1-bottle-lure-bob');
    await w;
    const thr = await dbg<any>(ann, 'interaction.state');
    log('A thrown', JSON.stringify(thr.thrown ?? null).slice(0, 300), 'cues', evSince(bob, t, /monsters\.cue|interaction\.fx/).map(brief).join(' ; '));
    log('A bob inventory after', await evalJs(bob, 'return window.__ix.inventory()'));
  } catch (e) { log('A ERROR', String(e)); }

  // ============ F. LISTENER: STT + wake + intercept
  log('================ F. LISTENER STT/WAKE');
  try {
    await dbg(ann, 'monsters.place', { id: 'hound0', x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 });
    const [cx, cz] = at(0.5);
    await tp(cat, cx, cz, 0);
    await tp(ann, at(0.3)[0], at(0.3)[1], 0);
    await tp(bob, at(0.7)[0], at(0.7)[1], 0);
    await dbg(ann, 'monsters.place', { id: 'listener0', x: at(0.5, 0.95)[0], z: at(0.5, 0.95)[1] });
    await sleep(500);
    log('F stt before', JSON.stringify(await dbg(ann, 'ai.sttState').catch((e) => String(e))).slice(0, 400));
    let t = Date.now();
    await cat.page.keyboard.down('KeyV');
    await sleep(1500);
    log('F stt during', JSON.stringify(await dbg(ann, 'ai.sttState').catch((e) => String(e))).slice(0, 500));
    await sleep(2600);
    await cat.page.keyboard.up('KeyV');
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const u = await dbg<any>(ann, 'ai.utterances').catch(() => null);
      if (u?.utterances?.length) { log(`F utterances after ${i + 1}s`, JSON.stringify(u.utterances).slice(0, 900)); break; }
      if (i === 7) log('F NO utterances after 8 s', JSON.stringify(u).slice(0, 200));
    }
    let M = await ms(ann);
    const L1 = M.agents.find((a: any) => a.kind === 'listener');
    log('F listener memory', JSON.stringify(L1.memory), 'state', L1.state, 'dormant', L1.dormant);
    t = Date.now();
    await dbg(ann, 'monsters.wake');
    await sleep(250);
    await shot(ann, 'F1-wake-flicker-ann');
    await sleep(2500);
    M = await ms(ann);
    const L2 = M.agents.find((a: any) => a.kind === 'listener');
    log('F after wake', JSON.stringify({ state: L2.state, intent: L2.intent, targetSpace: L2.targetSpace, ts: L2.targetSpace >= 0 ? sp(L2.targetSpace)?.callsign : null }), 'log', JSON.stringify(M.log?.slice(-3)));
    log('F events', evSince(ann, t, /monsters\.(wake|telegraph|led|lure|intercept)/).map(brief).join(' ; '));
    const ic = await evalJs(ann, `return [...document.querySelectorAll('body *')].filter(e => e.children.length===0 && /INTERCEPT/i.test(e.textContent||'')).map(e=>e.textContent.slice(0,140)).slice(0,5)`);
    log('F INTERCEPT text visible on Ann page', ic);
    log('F decision log (req)', JSON.stringify(await req(ann, 'monsters.log').catch((e) => String(e))).slice(0, 500));
  } catch (e) { log('F ERROR', String(e)); }

  // ============ G. GRAB + RESCUE (lone Bob, Ann ~10 m away)
  log('================ G. GRAB');
  try {
    const [gx, gz] = [r.x + r.w - 0.8, r.y + r.h - 0.8];
    const [hx, hz] = [r.x + 0.8, r.y + 0.8];
    log('G distance Ann-Bob', Math.hypot(gx - hx, gz - hz).toFixed(1));
    await tp(bob, gx, gz, 0);
    await tp(ann, hx, hz, yawTo(hx, hz, gx, gz));
    await tp(cat, L.van.cab.x + 1, L.van.cab.y + 1.5, 0);
    await look(ann, yawTo(hx, hz, gx, gz), 0);
    await sleep(800);
    const t = Date.now();
    await dbg(ann, 'monsters.place', { id: 'listener0', x: gx - (horiz ? 0.9 : 0.5), z: gz - (horiz ? 0.5 : 0.9), state: 'patrol', active: true });
    let started = false;
    for (let i = 0; i < 20 && !started; i++) { await sleep(100); started = evSince(bob, t, /monsters\.grab/).some((e) => e.d.state === 'start'); }
    const tg = Date.now();
    log(`G grab started=${started} after ${tg - t} ms`, evSince(bob, t, /monsters\.(grab|cue)/).map(brief).join(' ; '));
    await shot(bob, 'G1-grab-victim-bob');
    log('G1 bob HUD', await hud(bob));
    await sleep(400);
    await ann.page.keyboard.down('ShiftLeft');
    await ann.page.keyboard.down('KeyW');
    let outcome = '';
    let promptSeenAt = -1;
    for (let i = 0; i < 45 && !outcome; i++) {
      await sleep(70);
      const p = await pos(ann).catch(() => null);
      if (p) await look(ann, yawTo(p[0], p[2], gx, gz), 0).catch(() => null);
      const h = await hud(ann);
      if (promptSeenAt < 0 && /SHOVE/.test(h)) { promptSeenAt = Date.now() - tg; void shot(ann, 'G2-shove-prompt-ann'); }
      if (promptSeenAt >= 0) await ann.page.keyboard.press('KeyE');
      const g = evSince(bob, t, /monsters\.grab/).find((e) => e.d.state !== 'start');
      if (g) outcome = `${g.d.state} at +${Date.now() - tg} ms`;
    }
    await ann.page.keyboard.up('KeyW');
    await ann.page.keyboard.up('ShiftLeft');
    const pa = await pos(ann).catch(() => null);
    log(`G outcome: ${outcome || 'none'}; shove prompt first seen at +${promptSeenAt} ms; ann now at ${pa?.map((v) => v.toFixed(1))} (bob ${gx},${gz}); bob alive=${await alive(ann, bob.id)}`);
    log('G kill/death events', evSince(bob, t, /monsters\.kill|interaction\.death/).map(brief).join(' ; '));
    await sleep(500);
    await shot(bob, 'G3-after-grab-bob');
    log('G3 bob HUD', await hud(bob));
    await watch(ann, 'listener0', 4000, 'G4 listener after the grab');
  } catch (e) { log('G ERROR', String(e)); }

  // ============ E/C/D. DEATH, BADGE, SPECTATE CYCLE, DEAD VOICE
  log('================ E. BADGE / SPECTATE / DEAD VOICE');
  try {
    for (const p of players) if (!(await alive(ann, p.id))) await dbg(ann, 'interaction.revive', { pid: p.id });
    await dbg(ann, 'monsters.place', { id: 'listener0', x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 });
    await sleep(500);
    const [cx, cz] = at(0.4);
    await tp(cat, cx, cz, 0);
    await tp(ann, at(0.6)[0], at(0.6)[1], 0);
    await tp(bob, at(0.2)[0], at(0.2)[1], yawTo(at(0.2)[0], at(0.2)[1], cx, cz));
    await sleep(800);
    let t = Date.now();
    await dbg(cat, 'interaction.kill', { killer: 'HOUND', reason: 'heard your SPRINT', detail: '9 m' });
    await sleep(700);
    await shot(cat, 'E0-death-card-cat');
    log('E0 cat HUD', await hud(cat));
    await sleep(4000);
    log('C0 cat spectating', await evalJs(cat, 'return window.__players.spectating()'), 'plates', JSON.stringify(await evalJs(cat, 'return window.__players.avatars().map(a => a.id + ":" + a.plate.toFixed(2))')));
    await shot(cat, 'C0-spectate-cat');
    await cat.page.mouse.click(800, 450);
    await sleep(600);
    log('C1 after a real click', await evalJs(cat, 'return window.__players.spectating()'), 'locked', await evalJs(cat, 'return !!document.pointerLockElement'));
    await lmb(cat);
    await sleep(800);
    log('C2 after LMB-equivalent', await evalJs(cat, 'return window.__players.spectating()'));
    await shot(cat, 'C2-spectate-after-cycle-cat');
    await lmb(cat);
    await sleep(800);
    log('C3 after 2nd LMB', await evalJs(cat, 'return window.__players.spectating()'));
    await dbg(ann, 'interaction.kill', { killer: 'HOUND', reason: 'heard your SHOUT', detail: '5 m' });
    await sleep(1500);
    await ann.page.keyboard.down('KeyV');
    const ds: string[] = [];
    for (let i = 0; i < 6; i++) {
      await sleep(400);
      const pc = await peers(cat), pb = await peers(bob);
      ds.push(`cat<-ann g=${pc?.[ann.id]?.gain} rms=${pc?.[ann.id]?.rmsL} band=${pc?.[ann.id]?.band} | bob<-ann g=${pb?.[ann.id]?.gain} rms=${pb?.[ann.id]?.rmsL} band=${pb?.[ann.id]?.band}`);
    }
    await ann.page.keyboard.up('KeyV');
    log('D dead voice samples:\n  ' + ds.join('\n  '));
    // control: living Bob talks next to living ... (Ann dead) -> does dead Cat hear Bob at proximity?
    await bob.page.keyboard.down('KeyV');
    const ds2: string[] = [];
    for (let i = 0; i < 4; i++) { await sleep(400); const pc = await peers(cat), pa = await peers(ann); ds2.push(`cat<-bob g=${pc?.[bob.id]?.gain} rms=${pc?.[bob.id]?.rmsL} | ann<-bob g=${pa?.[bob.id]?.gain} rms=${pa?.[bob.id]?.rmsL}`); }
    await bob.page.keyboard.up('KeyV');
    log('D control (living Bob talking, heard by the dead):\n  ' + ds2.join('\n  '));
    await dbg(ann, 'interaction.revive', { pid: ann.id });
    const st = await dbg<any>(ann, 'interaction.state');
    const badge = Object.values(st.items as Record<string, any>).find((it) => it.type === 'badge' && it.owner === cat.id);
    log('E badge', JSON.stringify(badge));
    if (badge?.p) {
      const [gx, gy, gz] = badge.p;
      const sx = gx - 1.0, sz = gz;
      await tp(bob, sx, sz, yawTo(sx, sz, gx, gz));
      await sleep(500);
      log('E aim', await ixAim(bob, gx, gy + 0.02, gz));
      await sleep(300);
      log('E target when aiming at the badge', JSON.stringify(await ixTarget(bob)).slice(0, 300));
      await shot(bob, 'E1-aim-at-badge-bob');
      await bob.page.keyboard.press('KeyE');
      await sleep(700);
      let inv = await evalJs<any>(bob, 'return window.__ix.inventory()');
      log('E bob inventory after E', inv);
      if (!inv.includes('badge')) {
        for (const [ox, oz] of [[0, 1], [1, 0], [0, -1]]) {
          await tp(bob, gx + ox, gz + oz, yawTo(gx + ox, gz + oz, gx, gz));
          await sleep(400);
          await ixAim(bob, gx, gy + 0.02, gz);
          await sleep(250);
          const tg2 = await ixTarget(bob);
          log(`E retry from offset ${ox},${oz}: target`, tg2?.id, tg2?.kind, tg2?.view?.text);
          if (tg2?.id === badge.id) { await bob.page.keyboard.press('KeyE'); await sleep(600); break; }
        }
        inv = await evalJs<any>(bob, 'return window.__ix.inventory()');
        log('E bob inventory after retries', inv);
      }
      if (inv.includes('badge')) {
        const cab = L.van.cab;
        await tp(bob, cab.x + cab.w / 2, cab.y + cab.h / 2, 0);
        await sleep(1500);
        log('E in van target', JSON.stringify(await ixTarget(bob)).slice(0, 200), 'HUD', await hud(bob));
        await shot(bob, 'E2-bob-in-van-with-badge');
        t = Date.now();
        await bob.page.keyboard.press('KeyE');
        await sleep(1500);
        log('E deposit events', evSince(cat, t, /interaction\.(revive|deposit|fx|respawn)/).map(brief).join(' ; '), 'cat HUD', await hud(cat));
        await shot(cat, 'E3-cat-badge-filed');
        await sleep(20500);
        log(`E cat alive after 22 s: ${await alive(ann, cat.id)}`, 'HUD', await hud(cat));
        await shot(cat, 'E4-cat-respawned');
      }
    }
  } catch (e) { log('E ERROR', String(e)); }

  // ============ H. MANNEQUIN (fresh runtime at risk 2)
  log('================ H. MANNEQUIN');
  try {
    for (const p of players) if (!(await alive(ann, p.id))) await dbg(ann, 'interaction.revive', { pid: p.id });
    await dbg(ann, 'monsters.stop');
    log('start risk 2', JSON.stringify((await dbg<any>(ann, 'monsters.start', { risk: 2 })).agents.map((a: any) => a.id)));
    await dbg(ann, 'monsters.place', { id: 'hound0', x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 });
    await dbg(ann, 'monsters.place', { id: 'listener0', x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 });
    const [mx, mz] = at(0.92);
    const [ax, az] = at(0.05, 0.2), [bx, bz] = at(0.05, 0.8);
    await tp(ann, ax, az, yawTo(ax, az, mx, mz));
    await tp(bob, bx, bz, yawTo(bx, bz, mx, mz));
    await tp(cat, L.van.cab.x + 1, L.van.cab.y + 1.5, 0);
    await look(ann, yawTo(ax, az, mx, mz), 0);
    await look(bob, yawTo(bx, bz, mx, mz), 0);
    await sleep(700);
    log('spawn', JSON.stringify(await dbg(ann, 'monsters.spawnMannequin', { x: mx, z: mz, blinkIn: 5 })).slice(0, 300));
    await sleep(2500);
    await shot(ann, 'H1-mannequin-watched-lit-ann');
    await watch(ann, 'mannequin0', 7000, 'H2 two watchers (blinks due ~5 s)');
    let m = await agent(ann, 'mannequin0');
    log('H2 mannequin', JSON.stringify({ state: m.state, x: m.x, z: m.z, observed: m.observed, lit: m.lit }), 'blinks', evSince(ann, Date.now() - 10000, /monsters\.blink/).map(brief).join(' ; '));
    await dbg(ann, 'monsters.blink', { id: ann.id, inSec: 0.7 });
    await sleep(760);
    await shot(ann, 'H3-visor-blink-ann');
    await sleep(600);
    await look(ann, yawTo(ax, az, mx, mz) + Math.PI, 0);
    await watch(ann, 'mannequin0', 2500, 'H4 only Bob watching');
    const t = Date.now();
    await look(bob, yawTo(bx, bz, mx, mz) + Math.PI, 0);
    await watch(ann, 'mannequin0', 3000, 'H5 nobody watching');
    m = await agent(ann, 'mannequin0');
    log('H5 mannequin', JSON.stringify({ state: m.state, x: m.x, z: m.z }), 'kills', evSince(ann, t, /monsters\.kill/).map(brief).join(' ; '));
    await look(bob, yawTo(bx, bz, m.x, m.z), 0);
    await sleep(400);
    await shot(bob, 'H5-mannequin-after-lookaway-bob');
    for (const p of players) if (!(await alive(ann, p.id))) await dbg(ann, 'interaction.revive', { pid: p.id });
    await sleep(600);
    await tp(ann, ax, az, yawTo(ax, az, mx, mz));
    await tp(bob, bx, bz, yawTo(bx, bz, mx, mz));
    await look(ann, yawTo(ax, az, mx, mz), 0);
    await look(bob, yawTo(bx, bz, mx, mz), 0);
    await dbg(ann, 'monsters.spawnMannequin', { x: mx, z: mz, blinkIn: 40 });
    await dbg(ann, 'interaction.setLights', { space: R.id, on: false });
    await sleep(2600);
    m = await agent(ann, 'mannequin0');
    log('H6 dark + watched', JSON.stringify({ state: m.state, x: m.x, z: m.z, lit: m.lit }), 'ann light', await evalJs(ann, 'return window.__players.local().light'));
    await shot(ann, 'H6-mannequin-dark-ann');
    await ann.page.keyboard.press('KeyF');
    await sleep(1200);
    m = await agent(ann, 'mannequin0');
    log('H7 dark + after F', JSON.stringify({ state: m.state, x: m.x, z: m.z, lit: m.lit }), 'ann light', await evalJs(ann, 'return window.__players.local().light'));
    await shot(ann, 'H7-mannequin-dark-F-ann');
  } catch (e) { log('H ERROR', String(e)); }
} catch (e) {
  log(`RUN ERROR ${e instanceof Error ? e.stack : e}`);
} finally {
  for (const p of players) {
    try {
      const errs = await ev<string[]>(p, 'errors');
      log(`${p.name} client errors (${errs.length + p.errors.length}):`, [...p.errors, ...errs].slice(0, 15));
    } catch { /* ignore */ }
  }
  for (const p of players) await p.close().catch(() => null);
  setTimeout(() => process.exit(0), 300).unref();
}
