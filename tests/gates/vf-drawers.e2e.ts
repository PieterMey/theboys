// Final verify (v1.2): searched containers SHOW their loot. Gate R found loot invisible in an opened counter (E3's
// solid carcass); E3's fix round hollowed the procedural hosts and reported that env-layout's slot heights for the GLB
// hosts are off (tool chest 15 cm inside the body). One plain-facility contract (software lane, one Chrome + one ws
// bot), joined directly (no loading flow, no stance step): for each host kind one container in a room is opened
// through the real interaction path (cont:<id> use -> server reveal -> G3 item visuals), with real loot or a stocked
// 'Pocket watch'; a standing-player shot and a close-up per kind, plus the item vs slot heights and G3's drawStats.
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/gates/vf-drawers.e2e.ts [--kinds counter,tool_chest,...]
// Needs a dev backend behind tests/gates/v12r-proxy.mjs (BASE_URL). Shots: tests/artifacts/gate-r/<tag>/.
import type { V3 } from './v12r-lib.ts';
import { BASE, camera, errorTally, ev, frames, launch, mkRun, shot, sleep, until } from './v12r-lib.ts';
import { Bot } from '../monsters/bot.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const run = mkRun(arg('tag', 'final-drawers'), Number(arg('budget', '112')));
const CREW = arg('crew', `VF${(Date.now() % 9000 + 1000).toString(36).toUpperCase()}`.replace(/[^A-Z0-9]/g, 'K').slice(0, 6));
const SEED = arg('seed', 'gate-r-b1');
const KINDS = arg('kinds', 'counter,tool_chest,cabinet,filing,morgue_drawers,desk').split(',').filter(Boolean);

type Rect = { x: number; y: number; w: number; h: number };
type Space = { id: number; kind: string; type?: string; rect: Rect };
type Cont = { id: string; prop: string; space: number; p: V3; front: [number, number]; main: number; rot?: number; parts?: { idx: number; slot: V3 }[] };
type Item = { id: string; type: string; name?: string; p?: number[] };

const bob = new Bot('Bob');
await bob.connect(BASE.replace(/^http/, 'ws') + '/ws', CREW);
const gen = await bob.dbg<Record<string, unknown>>('level.generate', { seed: SEED, players: 2, risk: 2, theme: 'facility' });
run.notes.generated = { seed: gen.seed, theme: gen.theme, hash: gen.hash };
await bob.dbg('monsters.freeze', { on: true }).catch((e) => { run.notes.freeze = String(e); });
await bob.dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => null);
run.log(`crew ${CREW} facility ${String(gen.hash)} (${SEED})`);

const p = await launch({ name: 'Ann', crew: CREW, query: { levelLight: '1' } });
const page = p.page;
const tp = (x: number, z: number, yaw: number, pitch = -0.05) => ev(page, (w, a: [number, number, number, number]) => { w.__game.teleport(a[0], a[1], a[2]); w.__game.look(a[2], a[3]); }, [x, z, yaw, pitch] as [number, number, number, number]);
const results: Record<string, unknown>[] = [];
run.notes.results = results;

try {
  const booted = await until(page, (w) => w.__game?.ready?.() === true, null, 60_000);
  run.check('client booted', booted);
  run.notes.bootAt = +run.el().toFixed(1);
  await ev(page, (w, c: string) => w.__game.join(c), CREW);
  const inFac = await until(page, (w) => w.__game.state().phase === 'contract' && w.__levelDebug?.info?.()?.kind === 'facility', null, 45_000);
  run.check('joined the contract facility', inFac, await ev(page, (w) => ({ phase: w.__game.state().phase, level: w.__levelDebug?.info?.()?.kind })));
  run.notes.joinAt = +run.el().toFixed(1);
  // GLB hosts (tool chest, cabinet, desk) must be in before the shots: wait for the level's props/textures (bounded)
  const ready = await until(page, (w) => w.__levelDebug?.texturesReady?.() === true, null, Math.max(3000, Math.min(25_000, (run.left() - 60) * 1000)));
  run.notes.texturesReady = ready;
  run.notes.readyAt = +run.el().toFixed(1);
  const L = await ev<{ spaces: Space[]; van: { cab: Rect } }>(page, (w) => w.__netDebug.layout());
  const cab = L.van.cab;
  await bob.dbg('monsters.tp', { id: bob.id, x: cab.x + 1, z: cab.y + 1.5, light: 0 }).catch(() => null);
  const conts = await ev<Cont[]>(page, (w) => JSON.parse(JSON.stringify(w.__levelDebug.level().containers())));
  const peek = await bob.dbg<{ contents: Record<string, { type: string; name?: string }[]> }>('interaction.peek').catch(() => ({ contents: {} as Record<string, { type: string; name?: string }[]> }));
  const inRoom = (c: Cont) => { const s = L.spaces[c.space]; return !!s && s.kind !== 'corridor' && s.rect.w >= 4 && s.rect.h >= 4; };
  const loot = (c: Cont) => (peek.contents[c.id] ?? []).some((x) => x.type.startsWith('loot.'));
  run.notes.kinds = Object.fromEntries(KINDS.map((k) => [k, conts.filter((c) => c.prop === k).length]));

  for (const kind of KINDS) {
    if (run.left() < 13) { run.notes[`skipped:${kind}`] = 'budget'; run.log(`skip ${kind} (budget)`); continue; }
    const pick = conts.find((c) => c.prop === kind && inRoom(c) && loot(c)) ?? conts.find((c) => c.prop === kind && inRoom(c)) ?? conts.find((c) => c.prop === kind);
    if (!pick) { run.notes[`none:${kind}`] = true; continue; }
    const rec: Record<string, unknown> = { kind, id: pick.id, contents: peek.contents[pick.id] ?? [] };
    results.push(rec);
    try {
      if (!loot(pick)) { await bob.dbg('interaction.stock', { id: pick.id, type: 'loot.small', name: 'Pocket watch', value: 40 }).catch(() => null); rec.stocked = 'Pocket watch'; }
      await bob.dbg('interaction.setLights', { space: pick.space, on: true }).catch(() => null);
      const sx = pick.front[0] + 0.5, sz = pick.front[1] + 0.5;
      await tp(sx, sz, Math.atan2(pick.p[0] - sx, pick.p[2] - sz), -0.3);
      await frames(page, 2);
      await ev(page, (w, q: V3) => w.__ix.aim(q[0], q[1], q[2]), pick.p);
      rec.prompt = await until(page, (w, id: string) => w.__ix.target()?.id === `cont:${id}`, pick.id, 3000);
      await ev(page, (w, id: string) => w.__ix.use(`cont:${id}`), pick.id);
      rec.open = await until(page, (w, id: string) => (w.__ix.state().containers?.[id]?.open ?? 0) > 0, pick.id, 4000);
      const items = await ev<Item[]>(page, (w) => Object.entries(w.__ix.state().items ?? {}).map(([id, it]: [string, any]) => ({ id, type: it.type, name: it.name, p: it.p ?? it.pos })));
      const near = items.filter((it) => it.p && Math.hypot(it.p[0]! - pick.p[0], it.p[2]! - pick.p[2]) < 1.2);
      const part = (pick.parts ?? []).find((q) => q.idx === pick.main) ?? (pick.parts ?? [])[0];
      const slot: V3 = part ? part.slot : [pick.p[0], pick.p[1], pick.p[2]];
      rec.slot = slot.map((v) => +v.toFixed(3));
      rec.items = near.map((it) => ({ id: it.id, type: it.type, name: it.name, y: it.p ? +it.p[1]!.toFixed(3) : null }));
      run.check(`${kind} ${pick.id}: opens and reveals its loot`, rec.open && near.length > 0, { prompt: rec.prompt, items: rec.items, slot: rec.slot });
      // the standing player's own view, looking at the slot
      await ev(page, (w, q: V3) => w.__ix.aim(q[0], q[1], q[2]), slot);
      await sleep(400);
      await frames(page, 2);
      await shot(run, page, `d-${kind}-player`, { id: pick.id, items: rec.items, slot: rec.slot });
      // close-up from above the front edge (debug camera), then back to the player camera
      await camera(page, [sx + (sx - pick.p[0]) * 0.1, Math.max(1.25, slot[1] + 0.75), sz + (sz - pick.p[2]) * 0.1], slot);
      await frames(page, 3);
      await shot(run, page, `d-${kind}-close`, { slot: rec.slot });
      await camera(page, null);
    } catch (e) {
      rec.error = String(e).split('\n')[0];
      run.check(`${kind} ran`, false, rec.error);
    }
    run.write();
  }
  run.notes.drawStats = await ev(page, (w) => w.__ix.drawStats?.() ?? null).catch(() => null);
  const errs = await errorTally(page, p);
  run.notes.errors = errs;
  run.check('zero client errors (__game.errors)', errs.game.length === 0, errs.game.slice(0, 3));
  run.check('zero page errors', errs.page.length === 0, errs.page.slice(0, 3));
} catch (e) {
  run.check('run', false, String(e).split('\n')[0]);
} finally {
  run.write();
  bob.close?.();
  await p.close().catch(() => {});
  const failed = run.checks.filter((c) => !c.ok).length;
  run.log(`${failed ? 'FAIL' : 'PASS'} ${run.checks.length - failed}/${run.checks.length} -> ${run.out}`);
  process.exit(failed ? 1 : 0);
}
