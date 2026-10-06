// Owner: track (a) Objectives (tests/bots/**). Two headless ws bots finish a whole contract (G2a):
// salvage run -> twin breakers within 1 s -> read the code from state -> keypad -> lift the Core together ->
// carry it to the van -> leave-now lever -> assert the result (and the crew save, once meta saves it).
// Reusable:  import { runContractBot } from '../bots/contract-bot.ts';
//            const rep = await runContractBot({ url: 'ws://127.0.0.1:3011/ws' });  // rep.ok, rep.steps, rep.result
// CLI:       node tests/bots/contract-bot.ts --url ws://127.0.0.1:3011/ws [--seed s1] [--fixture facility_s1_p2] [--realSec 180]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ObjContractResult, ObjLoot } from '@dead-air/shared/messages/objectives.ts';
import { connectBot, walkable } from './bot-client.ts';
import type { Bot } from './bot-client.ts';

export interface ContractBotOpts {
  /** ws://127.0.0.1:PORT/ws */
  url: string;
  crew?: string;
  /** procgen seed (default random per run) or a fixture name in tests/fixtures/layouts */
  seed?: string;
  fixture?: string;
  /** contract length override in real seconds (default 180) */
  realSec?: number;
  /** salvage trips per bot before the main objectives (default 1) */
  lootTrips?: number;
  /** 'dbg' = start the contract via dbg.objectives.start (default); 'existing' = someone else started it */
  start?: 'dbg' | 'existing';
  timeoutMs?: number;
  log?: (s: string) => void;
  /** repo root (for the crew save check) */
  root?: string;
}

export interface BotStep { name: string; ok: boolean; ms: number; info?: string }

export interface ContractBotReport {
  ok: boolean;
  crew: string;
  seed: string | null;
  steps: BotStep[];
  result: ObjContractResult | null;
  /** crew save (saves/crews/<code>.json) if meta wrote one */
  save: unknown;
  saveHasHaul: boolean | null;
  hauled: number;
  error?: string;
  ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomCrew(): string {
  const A = 'BCDFGHJKLMNPQRSTVWXZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/** a walkable standing point near (x, z) (wall-mounted things sit on cell edges) */
function standNear(bot: Bot, x: number, z: number, avoid?: [number, number]): [number, number] {
  const L = bot.layout!;
  const cands: [number, number][] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const cx = Math.floor(x) + dx + 0.5, cz = Math.floor(z) + dz + 0.5;
    if (walkable(L, cx, cz)) cands.push([cx, cz]);
  }
  if (!cands.length) return [x, z];
  cands.sort((a, b) => {
    const da = Math.hypot(a[0] - x, a[1] - z) + (avoid ? -0.3 * Math.hypot(a[0] - avoid[0], a[1] - avoid[1]) : 0);
    const db = Math.hypot(b[0] - x, b[1] - z) + (avoid ? -0.3 * Math.hypot(b[0] - avoid[0], b[1] - avoid[1]) : 0);
    return da - db;
  });
  // must also be in reach (2 m) of the target
  return cands.find((c) => Math.hypot(c[0] - x, c[1] - z) <= 1.6) ?? cands[0];
}

export async function runContractBot(opts: ContractBotOpts): Promise<ContractBotReport> {
  const t0 = performance.now();
  const log = opts.log ?? ((s: string) => console.log(`[bot] ${s}`));
  const crew = opts.crew ?? randomCrew();
  const steps: BotStep[] = [];
  const rep: ContractBotReport = { ok: false, crew, seed: null, steps, result: null, save: null, saveHasHaul: null, hauled: 0, ms: 0 };
  const bots: Bot[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>, info?: (v: T) => string): Promise<T> => {
    const s0 = performance.now();
    try {
      const v = await fn();
      const st: BotStep = { name, ok: true, ms: Math.round(performance.now() - s0), ...(info ? { info: info(v) } : {}) };
      steps.push(st);
      log(`PASS ${name} (${st.ms} ms)${st.info ? ` ${st.info}` : ''}`);
      return v;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      steps.push({ name, ok: false, ms: Math.round(performance.now() - s0), info: msg });
      log(`FAIL ${name}: ${msg}`);
      throw e;
    }
  };
  const deadline = performance.now() + (opts.timeoutMs ?? 175_000);
  const left = () => Math.max(1000, deadline - performance.now());
  try {
    const [A, B] = await step('connect 2 bots', async () => Promise.all([
      connectBot({ url: opts.url, crew, name: 'Bot-A', log }),
      connectBot({ url: opts.url, crew, name: 'Bot-B', log }),
    ]));
    bots.push(A, B);
    await sleep(300);

    if ((opts.start ?? 'dbg') === 'dbg') {
      const r = await step('dbg.objectives.start (monsters off, doors open)', () => A.dbg('objectives.start', {
        seed: opts.seed, fixture: opts.fixture, players: 2, realSec: opts.realSec ?? 180, monsters: false, openDoors: true,
      }, 20000), (v) => JSON.stringify(v));
      rep.seed = (r as { seed?: string }).seed ?? null;
    }
    // monsters off: (c) auto-starts its runtime ~2.5 s into a contract, so freeze (not stop) it, now and after that
    const freeze = () => A.dbg('monsters.freeze', { on: true }).catch(() => undefined);
    await freeze();
    setTimeout(() => void freeze(), 3000);
    setTimeout(() => void freeze(), 6000);
    await step('both bots in a running contract', async () => {
      await Promise.all([A, B].map((b) => b.waitFor(() => b.full?.phase === 'contract' && !!b.obj?.active && !!b.layout, 15000, 'contract phase')));
      await sleep(400);
      for (const b of [A, B]) {
        const sp = b.serverPos();
        const L = b.layout!;
        if (sp && walkable(L, sp[0], sp[1])) b.setPos(sp[0], sp[1]);
        else {
          const spawns = L.items.filter((i) => i.kind === 'spawn_player');
          const s = spawns[b === A ? 0 : 1] ?? spawns[0];
          b.setPos(s.x, s.z, s.rot ?? 0);
        }
      }
      await A.dbg('objectives.doors', { open: true }).catch(() => undefined);
      await sleep(300);
    }, () => `A at (${A.pos.map((v) => v.toFixed(1)).join(', ')}), B at (${B.pos.map((v) => v.toFixed(1)).join(', ')}), loot ${A.obj?.loot.length}, code ${A.obj?.code}`);

    const obj = () => A.obj!;
    const dep = () => obj().deposit!.p;
    const vanInside = (): [number, number] => {
      const v = obj().van!;
      return [v.x + v.w / 2, v.y + v.h / 2];
    };

    // ---------- salvage ----------
    const trips = opts.lootTrips ?? 1;
    const claimed = new Set<string>();
    const lootRun = async (bot: Bot) => {
      for (let t = 0; t < trips; t++) {
        const world = obj().loot.filter((l: ObjLoot) => l.where === 'world' && !claimed.has(l.id));
        const ranked = world
          .map((l) => ({ l, c: bot.pathCost(l.p[0], l.p[2]) }))
          .filter((x) => Number.isFinite(x.c))
          .sort((a, b) => a.c - b.c);
        const pick = ranked[0]?.l;
        if (!pick) return;
        claimed.add(pick.id);
        const ix = obj().lootMode === 'interaction';
        const pickUp = async (id: string) => (ix ? bot.req('interaction.use', { id }) : bot.req('objectives.pick', { id }));
        const [sx, sz] = standNear(bot, pick.p[0], pick.p[2]);
        await bot.goTo(sx, sz, { timeoutMs: 40000 });
        const r = await pickUp(pick.id);
        if (!r.ok) throw new Error(`${bot.name}: pick ${pick.id} failed: ${r.msg}`);
        // a second, close-by item if the hands allow
        const near = obj().loot.filter((l) => l.where === 'world' && !claimed.has(l.id) && l.cls !== 'heavy' && pick.cls !== 'heavy' && Math.hypot(l.p[0] - pick.p[0], l.p[2] - pick.p[2]) < 5)[0];
        if (near) {
          claimed.add(near.id);
          const [nx, nz] = standNear(bot, near.p[0], near.p[2]);
          await bot.goTo(nx, nz, { timeoutMs: 20000 }).catch(() => undefined);
          await pickUp(near.id).catch(() => undefined);
        }
        const [dx, dz] = standNear(bot, dep()[0], dep()[2]);
        await bot.goTo(dx, dz, { timeoutMs: 40000 });
        const d = ix ? await bot.req('interaction.use', { id: 'deposit:0' }) : await bot.req('objectives.deposit', {});
        if (!d.ok) throw new Error(`${bot.name}: deposit failed: ${d.msg}`);
      }
    };
    await step('salvage run: pick up + deposit in the van', async () => {
      await Promise.all([lootRun(A), lootRun(B)]);
      await A.waitFor(() => obj().hauled > 0, 3000, 'hauled > 0');
    }, () => `hauled ${obj().hauled} (${obj().salvage.count} items)`);

    // ---------- twin breakers ----------
    const levers = obj().levers;
    if (levers.length < 2) throw new Error('layout has < 2 levers');
    await step('walk to both breakers', async () => {
      const [ax, az] = standNear(A, levers[0].p[0], levers[0].p[2]);
      const [bx, bz] = standNear(B, levers[1].p[0], levers[1].p[2]);
      await Promise.all([A.goTo(ax, az, { timeoutMs: left() }), B.goTo(bx, bz, { timeoutMs: left() })]);
    }, () => `${levers[0].id} @${levers[0].space}, ${levers[1].id} @${levers[1].space}`);
    await step('pull both breakers within 1 s -> power', async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const powerEv = A.waitEvent('objectives.power', (d) => d.on, 4000);
        const [ra, rb] = await Promise.all([A.req('objectives.lever', { id: levers[0].id }), B.req('objectives.lever', { id: levers[1].id })]);
        if (ra.result === 'success' || rb.result === 'success') { await powerEv.catch(() => undefined); break; }
        await powerEv.catch(() => undefined);
        if (obj().power[levers[0].zone]) break;
        log(`breakers: ${ra.result}/${rb.result} (${ra.msg ?? ''} ${rb.msg ?? ''}), retrying`);
        const wait = Math.max(0, obj().leverCooldownUntil - Date.now()) + 300;
        await sleep(Math.min(wait, 21000));
      }
      await A.waitFor(() => !!obj().power[levers[0].zone] && !!obj().keypad?.enabled, 3000, 'power on');
    }, () => `zone ${levers[0].zone} powered`);

    // ---------- keypad ----------
    const code = obj().code;
    await step('read the code from state, enter it at the keypad -> vault open', async () => {
      const k = obj().keypad!;
      const [kx, kz] = standNear(A, k.p[0], k.p[2]);
      const toCore = obj().core!.p;
      const [bx, bz] = standNear(B, k.p[0], k.p[2], [kx, kz]);
      await Promise.all([A.goTo(kx, kz, { timeoutMs: left() }), B.goTo(bx, bz, { timeoutMs: left() }).catch(() => undefined)]);
      const r = await A.req('objectives.keypad', { code });
      if (!r.ok) throw new Error(`keypad: ${r.msg}`);
      await A.waitFor(() => obj().vaultOpen, 3000, 'vaultOpen');
      void toCore;
    }, () => `code ${code}`);

    // ---------- Core ----------
    const core = obj().core!;
    await step('both grab a Core handle -> lifted', async () => {
      const L = A.layout!;
      const c = core.p;
      // handle points on either side of the canister, on walkable cells
      const axes: [number, number][] = [[1, 0], [0, 1]];
      let ha: [number, number] = [c[0] - 0.9, c[2]], hb: [number, number] = [c[0] + 0.9, c[2]];
      for (const [ux, uz] of axes) {
        const a: [number, number] = [c[0] - ux * 0.9, c[2] - uz * 0.9], b: [number, number] = [c[0] + ux * 0.9, c[2] + uz * 0.9];
        if (walkable(L, a[0], a[1]) && walkable(L, b[0], b[1])) { ha = a; hb = b; break; }
      }
      await Promise.all([A.goTo(ha[0], ha[1], { timeoutMs: left() }), B.goTo(hb[0], hb[1], { timeoutMs: left() })]);
      const ra = await A.req('objectives.core', { action: 'grab' });
      const rb = await B.req('objectives.core', { action: 'grab' });
      if (!ra.ok || !rb.ok) throw new Error(`grab: ${ra.msg ?? ''} / ${rb.msg ?? ''}`);
      await A.waitFor(() => obj().coreState === 'carried', 3000, 'core carried');
    }, () => `value ${obj().core?.value}`);

    await step('carry the Core to the van together', async () => {
      // A leads along a path to the van; B trails on A's own trail ~1.3 m behind (stays inside the leash)
      const [tx, tz] = vanInside();
      const trail: [number, number][] = [[A.pos[0], A.pos[1]]];
      let done = false;
      const lead = A.goTo(tx, tz, { speed: 1.6, timeoutMs: left(), tol: 0.3 }).then(() => { done = true; });
      const lag = 1.3;
      const follow = (async () => {
        while (!done && obj().coreState === 'carried') {
          const last = trail[trail.length - 1];
          if (Math.hypot(A.pos[0] - last[0], A.pos[1] - last[1]) > 0.1) trail.push([A.pos[0], A.pos[1]]);
          // point on the trail `lag` metres behind A
          let need = lag, target = trail[0];
          for (let i = trail.length - 1; i > 0; i--) {
            const seg = Math.hypot(trail[i][0] - trail[i - 1][0], trail[i][1] - trail[i - 1][1]);
            if (seg >= need) {
              const k = need / (seg || 1);
              target = [trail[i][0] + (trail[i - 1][0] - trail[i][0]) * k, trail[i][1] + (trail[i - 1][1] - trail[i][1]) * k];
              need = 0;
              break;
            }
            need -= seg;
          }
          B.stepToward(target[0], target[1], 2.4);
          await sleep(50);
        }
      })();
      await Promise.race([
        A.waitFor(() => obj().coreState === 'van', left(), 'core in van'),
        A.waitFor(() => obj().coreState === 'dropped', left(), 'core dropped').then(() => { throw new Error('Core was dropped during the carry'); }),
      ]);
      await lead.catch(() => undefined);
      done = true;
      await follow;
    }, () => `hauled ${obj().hauled}`);

    // ---------- leave ----------
    await step('both inside the van, pull the leave-now lever -> contract ends', async () => {
      const [vx, vz] = vanInside();
      const ll = obj().leaveLever;
      await Promise.all([A.goTo(vx, vz - 0.4, { timeoutMs: left() }).catch(() => undefined), B.goTo(vx, vz + 0.4, { timeoutMs: left() }).catch(() => undefined)]);
      if (ll) await A.goTo(...standNear(A, ll.p[0], ll.p[2]), { timeoutMs: 10000 }).catch(() => undefined);
      const endEv = A.waitEvent('objectives.end', undefined, 8000);
      const r = await A.req('objectives.leave', {});
      if (!r.ok) throw new Error(`leave: ${r.msg}`);
      const ev = await endEv;
      rep.result = ev.result;
      rep.hauled = ev.result.hauled;
      if (!(ev.result.hauled > 0)) throw new Error('result.hauled is 0');
      if (!ev.result.coreExtracted) throw new Error('result.coreExtracted is false');
    }, () => `result ${JSON.stringify({ hauled: rep.result?.hauled, core: rep.result?.coreExtracted, survivors: rep.result?.survivors.length, requests: rep.result?.requestsMet })}`);

    // ---------- crew save (meta) ----------
    const root = opts.root ?? resolve(import.meta.dirname, '../..');
    const savePath = join(root, 'saves/crews', `${crew}.json`);
    const s0 = performance.now();
    while (performance.now() - s0 < 6000) {
      if (existsSync(savePath)) {
        try {
          const save = JSON.parse(readFileSync(savePath, 'utf8')) as { history?: { orderId: string; hauled: number }[]; shift?: { hauled?: number } };
          rep.save = save;
          const oid = rep.result?.orderId ?? '';
          const h = save.history?.find((x) => x.orderId === oid || x.orderId.startsWith(`${oid}|`));
          rep.saveHasHaul = !!h && h.hauled === rep.result?.hauled;
          if (rep.saveHasHaul) break;
        } catch { /* being written */ }
      }
      await sleep(250);
    }
    steps.push({ name: 'crew save contains the haul', ok: rep.saveHasHaul === true, ms: Math.round(performance.now() - s0), info: rep.save ? (rep.saveHasHaul ? `saves/crews/${crew}.json history has ${rep.result?.hauled}` : 'save exists but no matching history entry') : 'no crew save written (meta not installed?)' });
    log(`${rep.saveHasHaul ? 'PASS' : 'INFO'} crew save: ${steps[steps.length - 1].info}`);
    rep.ok = steps.filter((s) => s.name !== 'crew save contains the haul').every((s) => s.ok);
  } catch (e) {
    rep.error = e instanceof Error ? e.message : String(e);
    rep.ok = false;
  } finally {
    for (const b of bots) b.close();
    rep.ms = Math.round(performance.now() - t0);
  }
  return rep;
}

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const url = arg('url') ?? `ws://127.0.0.1:${process.env.PORT ?? 3011}/ws`;
  const rep = await runContractBot({ url, seed: arg('seed'), fixture: arg('fixture'), realSec: arg('realSec') ? Number(arg('realSec')) : undefined, crew: arg('crew') });
  console.log(JSON.stringify({ ok: rep.ok, crew: rep.crew, seed: rep.seed, hauled: rep.hauled, saveHasHaul: rep.saveHasHaul, ms: rep.ms, error: rep.error, steps: rep.steps }, null, 2));
  process.exitCode = rep.ok ? 0 : 1;
}
