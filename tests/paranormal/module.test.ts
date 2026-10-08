// Owner: env-paranormal (v1.2). The server module behind a minimal fake ServerContext: system order 77, the flag
// paranormal=false and balance enabled=false switch it off (no events, empty sync, refused fires), phase changes reset
// it, api.ts is bound (onPhenomenon gets the witnesses, paranormalQuietUntil, setLoreTargets, triggerPhenomenon).
//   node --test tests/paranormal/module.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { STANCE } from '../../packages/shared/src/state.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { Crew, ServerContext, ServerPlayer, ServerSystem } from '../../apps/server/src/core/types.ts';
import { install, PARANORMAL_ORDER } from '../../apps/server/src/paranormal/index.ts';
import { onPhenomenon, paranormalQuietUntil, phenomena, setLoreTargets, triggerPhenomenon } from '../../apps/server/src/paranormal/api.ts';
import type { PhenomenonRecord } from '../../apps/server/src/paranormal/api.ts';
import { resolveBalance } from '../../apps/server/src/paranormal/balance.ts';

interface Fake {
  ctx: ServerContext;
  sys: ServerSystem;
  reqs: Map<string, (crew: Crew, p: ServerPlayer, a: unknown) => unknown>;
  emits: { e: string; d: unknown; to?: string[] }[];
  now: { t: number };
  flags: Record<string, boolean>;
  balance: Record<string, Record<string, unknown>> & { core: Record<string, unknown> };
}

function fakeCtx(flags: Record<string, boolean>, para: Record<string, unknown> = {}): Fake {
  const reqs = new Map<string, (crew: Crew, p: ServerPlayer, a: unknown) => unknown>();
  const emits: Fake['emits'] = [];
  const now = { t: 5_000_000 };
  let sys: ServerSystem | null = null;
  const balance = { core: { contractRealSec: 900 }, paranormal: para } as Fake['balance'];
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const ctx = {
    cfg: {} as never, flags, balance, env: { dev: true } as never,
    log: () => logger,
    crews: {} as never,
    registerSystem: (s: ServerSystem) => { sys = s; },
    registerReq: (n: string, h: (crew: Crew, p: ServerPlayer, a: unknown) => unknown) => { reqs.set(n, h); },
    registerDbg: (n: string, h: (crew: Crew, p: ServerPlayer, a: unknown) => unknown) => { reqs.set(n.startsWith('dbg.') ? n : `dbg.${n}`, h); },
    onVoiceChunk: noop,
    emit: (_crew: Crew, e: string, d: unknown, opts?: { to?: string[] }) => { emits.push({ e, d, to: opts?.to }); },
    send: noop, sendSig: noop, notice: noop,
    hooks: { join: [], leave: [], phase: [], pose: [], loud: [], crewSnapshot: [], snapshot: [], fullState: [], welcome: [], config: [] },
    setPhase: noop, buildFullState: noop as never,
    now: () => now.t,
    reloadConfig: noop,
  } as unknown as ServerContext;
  install(ctx);
  return { ctx, sys: sys!, reqs, emits, now, flags, balance };
}

function crewWith(L: LevelLayout): Crew {
  const players = new Map<string, ServerPlayer>();
  // two players inside the building, far from the van
  const cells: [number, number][] = [];
  for (let c = 0; c < L.owner.length && cells.length < 2; c += 37) {
    const s = L.owner[c];
    if (s >= 0 && L.spaces[s].kind !== 'outside' && L.spaces[s].type !== 'van') cells.push([(c % L.W) + 0.5, Math.floor(c / L.W) + 0.5]);
  }
  cells.forEach(([x, z], i) => {
    const id = `p${i}`;
    players.set(id, {
      id, key: `k${i}`, name: ['Ann', 'Bob'][i], profile: {} as never, connected: true, ready: true, alive: true, consent: { transcribe: true, mimic: false },
      level: 1, pose: { seq: 1, p: [x, 0, z], yaw: 0, pitch: 0, stance: STANCE.stand, anim: 0, light: 1 } as never, poseAt: 0, band: 0, radio: 0, socket: null,
      resume: '', joinedAt: 0, isLeader: i === 0, disconnectedAt: 0, slices: {},
    });
  });
  return { code: 'FAKE', phase: 'contract', players, layout: L, slices: {}, createdAt: 0, tick: 0, emptySince: 0 };
}

const L = generateFacility({ seed: 'module-1', players: 2, risk: 1 });

test('system order 77 (after the director, 75)', () => {
  const f = fakeCtx({ paranormal: true });
  assert.equal(f.sys.order, 77);
  assert.equal(PARANORMAL_ORDER, 77);
});

test('paranormal=false disables the module: no events, empty sync, refused fires', () => {
  const f = fakeCtx({ paranormal: false });
  const crew = crewWith(L);
  for (let i = 0; i < 30 * 200; i++) { f.now.t += 1000 / 30; f.sys.tick(1 / 30, crew, f.ctx); }
  assert.equal(f.emits.filter((e) => e.e.startsWith('paranormal.')).length, 0, 'nothing emitted in 200 s');
  const p0 = crew.players.get('p0')!;
  const sync = f.reqs.get('paranormal.sync')!(crew, p0, {}) as { residue: unknown[]; active: unknown[] };
  assert.deepEqual([sync.residue.length, sync.active.length], [0, 0]);
  const fire = f.reqs.get('dbg.paranormal.fire')!(crew, p0, { kind: 'knock' }) as { ok: boolean; reason?: string };
  assert.equal(fire.ok, false);
  assert.equal(fire.reason, 'disabled');
  assert.equal(triggerPhenomenon(crew, 'knock', { force: true }), false);
  assert.deepEqual(f.reqs.get('paranormal.seen')!(crew, p0, { id: 1 }), { ok: false });
});

test('balance enabled=false disables it too; flipping the flag back on resumes', () => {
  const f = fakeCtx({ paranormal: true }, { enabled: false });
  const crew = crewWith(L);
  const p0 = crew.players.get('p0')!;
  assert.equal((f.reqs.get('dbg.paranormal.fire')!(crew, p0, { kind: 'knock' }) as { ok: boolean }).ok, false);
  f.balance.paranormal = { enabled: true };
  for (const h of f.ctx.hooks.config) h();
  f.sys.tick(1 / 30, crew, f.ctx);
  const r = f.reqs.get('dbg.paranormal.fire')!(crew, p0, { kind: 'knock', force: true }) as { ok: boolean; ev?: { at: number } };
  assert.equal(r.ok, true, 'fires once enabled');
  assert.ok(r.ev!.at >= f.now.t + 250);
  assert.ok(f.emits.some((e) => e.e === 'paranormal.event'));
});

test('api: onPhenomenon gets the witnesses at the end, quiet window, lore targets, phase reset', () => {
  const f = fakeCtx({ paranormal: true });
  const crew = crewWith(L);
  const recs: PhenomenonRecord[] = [];
  const off = onPhenomenon((c, r) => { if (c === crew) recs.push(r); });
  f.sys.tick(1 / 30, crew, f.ctx);
  setLoreTargets(crew, ['lore:a', 'lore:b']);
  const st = f.reqs.get('dbg.paranormal.state')!(crew, crew.players.get('p0')!, {}) as { lore: string[] };
  assert.deepEqual(st.lore, ['lore:a', 'lore:b']);
  const ok = triggerPhenomenon(crew, 'knock', { force: true });
  assert.equal(ok, true);
  assert.ok(paranormalQuietUntil(crew) > f.now.t, 'quiet window around the effect');
  // run past its end
  for (let i = 0; i < 30 * 5; i++) { f.now.t += 1000 / 30; f.sys.tick(1 / 30, crew, f.ctx); }
  assert.equal(recs.length, 1, 'one record when it ended');
  assert.ok(f.emits.some((e) => e.e === 'paranormal.end'));
  assert.equal(phenomena(crew).length, 1);
  // a phase change ends everything (interrupted) and stops the haunt
  triggerPhenomenon(crew, 'cold_spot', { force: true });
  crew.phase = 'results';
  for (const h of f.ctx.hooks.phase) h(crew, 'contract', 'results');
  assert.ok(f.emits.some((e) => e.e === 'paranormal.end' && (e.d as { reason: string }).reason === 'interrupted'));
  const sync = f.reqs.get('paranormal.sync')!(crew, crew.players.get('p0')!, {}) as { active: unknown[] };
  assert.equal(sync.active.length, 0);
  off();
  // after the quiet window passes it is free again
  f.now.t += 60_000;
  assert.equal(paranormalQuietUntil(crew), 0);
});

test('balance file: config/balance/paranormal.json resolves every key with the documented signed-off tells', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('../../config/balance/paranormal.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const b = resolveBalance(raw);
  assert.deepEqual(b.tells, { stalk: true, intercept: true, ambushCold: false });
  assert.equal(b.leadMs, 350);
  assert.deepEqual(b.tierAt, [0, 0.25, 0.4]);
  assert.equal(b.guarantees.t1ClockMin, 120);
  assert.equal(b.guarantees.t2ClockMin, 240);
  assert.deepEqual(b.budgets, { dark_walk: 3, mirror_writing: 2, mirror_figure: 2, presence: 4, knock: 6, poltergeist: 4, object_fall: 5, footprints: 3, cold_spot: 3, brownout_breath: 2 });
  assert.equal(raw.noiseToMonsters, false);
});
