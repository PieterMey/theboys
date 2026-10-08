// v1.2 (G3) crafting materials + the salvage pouch, ws bots against a full dev server: pickup (no slot), death drop
// and merge, the van deposit (stash fx), take-and-clear (dbg twin of takeVanMaterials), the buzzer (the leave lever
// deposits for everyone in the van) and the timeout path (a living player's pouch inside the van counts).
// Run: node tests/gear/pouch.e2e.ts [port]   (no port: spawns a temporary dev server)
import { Bot } from '../interaction/bot.ts';
import { place, reporter, sleep, testServer } from '../interaction/v12lib.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ItemState } from '../../packages/shared/src/messages/interaction.ts';

const srv = await testServer();
const { ok, fails } = reporter();
const url = `ws://127.0.0.1:${srv.port}/ws`;
const crew = `PCH${Date.now() % 100000}`;
const a = new Bot('Picker');
const b = new Bot('Carrier');
type Peek = { vanMats: Record<string, number> };
try {
  await a.connect(url, crew);
  await b.connect(url, crew);
  await a.dbg('level.generate', { seed: 'g3-pouch-e2e', players: 2 });
  await a.settle(800);
  await a.dbg('monsters.freeze', { on: true }).catch(() => undefined);
  const L = a.full!.layout as LevelLayout;
  const mats = Object.values(a.ix.items).filter((it) => it.where === 'world' && it.type.startsWith('mat.') && it.type !== 'mat.pouch');
  ok(mats.length >= 8, `${mats.length} material pickups on a 2-player site`);
  // ---------------- pickup: into the pouch, no slot
  const m = mats[0]!;
  await place(a, m.p![0], m.p![2] - 0.45);
  await a.settle(150);
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: m.id });
  await a.settle();
  ok(r.ok && !a.ix.items[m.id], `picked up ${m.type} x${m.count} (${r.msg})`);
  ok((a.ix.inventories[a.me] ?? []).every((id) => !id), 'no inventory slot used');
  ok(a.ix.pouches?.[a.me]?.[m.type] === m.count, 'pouch patched for everyone');
  ok(b.ix.pouches?.[a.me]?.[m.type] === m.count, 'teammates see the pouch too (HUD chips are local)');
  // ---------------- death drop + merge
  await a.dbg('interaction.kill', { pid: a.me, killer: 'HOUND', reason: 'heard your FOOTSTEPS (5 m)' });
  await a.settle(200);
  const pouch = Object.values(b.ix.items).find((it) => it.type === 'mat.pouch' && it.where === 'world');
  ok(!!pouch && pouch.mats?.[m.type] === m.count, `the pouch dropped at the body (${JSON.stringify(pouch?.mats)})`);
  ok(!b.ix.pouches?.[a.me], 'the dead player has no pouch');
  await b.dbg('interaction.give', { type: 'mat.scrap', count: 2 });
  await place(b, pouch!.p![0], pouch!.p![2] - 0.4);
  await b.settle(150);
  r = await b.req('interaction.use', { id: pouch!.id });
  await b.settle();
  const want: Record<string, number> = { 'mat.scrap': 2 };
  want[m.type] = (want[m.type] ?? 0) + m.count!;
  ok(r.ok && JSON.stringify(b.ix.pouches?.[b.me]) === JSON.stringify(Object.fromEntries(Object.entries(want).sort())) || JSON.stringify(Object.entries(b.ix.pouches?.[b.me] ?? {}).sort()) === JSON.stringify(Object.entries(want).sort()), `merged on pickup: ${JSON.stringify(b.ix.pouches?.[b.me])}`);
  // ---------------- deposit at the van: pouch -> stash
  await a.dbg('interaction.revive', { pid: a.me });
  const dep = Object.values(b.ix.ints).find((i) => i.kind === 'deposit')!;
  await place(b, dep.p[0], dep.p[2] + 0.4);
  await b.settle(150);
  r = await b.req('interaction.use', { id: dep.id });
  await b.settle();
  let peek = await b.dbg<Peek>('interaction.peek');
  ok(r.ok && !b.ix.pouches?.[b.me], `deposited (${r.msg})`);
  ok(JSON.stringify(Object.entries(peek.vanMats).sort()) === JSON.stringify(Object.entries(want).sort()), `van stash ${JSON.stringify(peek.vanMats)}`);
  ok(b.events.some((ev) => ev.e === 'interaction.fx' && (ev.d as { kind: string }).kind === 'stash'), 'fx stash');
  // ---------------- timeout path: a material on the van floor + a living player's pouch inside the van
  const van = L.van.cab;
  await b.dbg('interaction.spawn', { type: 'mat.optics', x: van.x + 0.5, z: van.y + 0.6, count: 2 });
  await b.dbg('interaction.give', { type: 'mat.chem', count: 1 });
  await place(b, van.x + van.w / 2, van.y + van.h / 2);
  await b.settle(150);
  const peekAll = await b.dbg<Record<string, number>>('interaction.vanMaterials');
  const total = { ...want, 'mat.optics': 2 + (want['mat.optics'] ?? 0), 'mat.chem': 1 + (want['mat.chem'] ?? 0) };
  ok(JSON.stringify(Object.entries(peekAll).sort()) === JSON.stringify(Object.entries(total).sort()), `vanMaterials = stash + van floor + pouches in the van: ${JSON.stringify(peekAll)}`);
  const took = await b.dbg<Record<string, number>>('interaction.vanMaterials', { take: true });
  const again = await b.dbg<Record<string, number>>('interaction.vanMaterials');
  await b.settle();
  ok(JSON.stringify(Object.entries(took).sort()) === JSON.stringify(Object.entries(total).sort()) && Object.keys(again).length === 0, 'take returns them and clears');
  ok(!Object.values(b.ix.items).some((it) => it.type === 'mat.optics' && it.p && it.p[0] >= van.x - 0.6 && it.p[0] <= van.x + van.w + 0.6 && it.p[2] >= van.y - 0.6 && it.p[2] <= van.y + van.h + 0.6), 'the van floor material was taken');
  ok(!b.ix.pouches?.[b.me], 'the pouch of the player in the van was taken');
  // ---------------- the buzzer: leaving deposits the pouches of everyone in the van
  await b.dbg('interaction.give', { type: 'mat.wiring', count: 2 });
  await place(a, van.x + 0.5, van.y + 0.5);
  await a.dbg('interaction.give', { type: 'mat.cells', count: 1 });
  await b.settle(200);
  const stashBefore = (b.full?.meta as { stash?: Record<string, number> } | undefined)?.stash ?? {};
  const pre = await b.dbg<Record<string, number>>('interaction.vanMaterials');
  ok(pre['mat.wiring'] === 2 && pre['mat.cells'] === 1, `before the buzzer: ${JSON.stringify(pre)}`);
  await b.dbg('objectives.end', { reason: 'leave' }).catch((e) => console.log('objectives.end:', String(e)));
  await sleep(1500);
  ok(!b.ix.pouches?.[b.me] && !b.ix.pouches?.[a.me], 'the buzzer emptied both pouches');
  const st2 = await b.dbg<{ meta?: { stash?: Record<string, number> } }>('meta.state').catch(() => null);
  const stash = st2?.meta?.stash ?? (b.full?.meta as { stash?: Record<string, number> } | undefined)?.stash ?? {};
  const gained = (stash['mat.wiring'] ?? 0) - (stashBefore['mat.wiring'] ?? 0);
  const after = await b.dbg<Record<string, number>>('interaction.vanMaterials').catch(() => ({} as Record<string, number>));
  console.log(`  crew stash after the contract: ${JSON.stringify(stash)} (wiring +${gained}); van materials left: ${JSON.stringify(after)}`);
  ok(gained >= 2 || (after['mat.wiring'] ?? 0) === 2, 'the buzzer deposit reached the van stash (taken by the workshop at contract end, or still in the van)');
} catch (e) {
  ok(false, `threw: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
} finally {
  a.close();
  b.close();
  srv.stop();
}
console.log(fails() ? `FAILED (${fails()})` : 'ALL PASS');
process.exit(fails() ? 1 : 0);
