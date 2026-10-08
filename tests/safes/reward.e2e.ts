// v1.2 (G3) safe rewards: the bonds as before, plus safeGearChance (0.35) of one implemented v1.2 item via
// IX.giveItem (deterministic per safe: the test predicts it with safeGear()), and a unit check of the gear roll.
// Run: node tests/safes/reward.e2e.ts [port]   (no port: spawns a temporary dev server; the safes flag must be on)
import { Bot } from '../interaction/bot.ts';
import { reporter, testServer } from '../interaction/v12lib.ts';
import { safeGear } from '../../apps/server/src/safes/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { ITEM_DEFS } from '../../packages/shared/src/interactables.ts';
import type { ItemState } from '../../packages/shared/src/messages/interaction.ts';

const { ok, fails } = reporter();
// ---------------- unit: the gear roll (35%, only implemented types, deterministic)
const fake = { seed: 'safe-unit', hash: 'h' } as LevelLayout;
const W = { lockpick: 3, masterkey: 2, nvg: 1, battery: 3, flashbulb: 2, soles: 2, notAnItem: 50 };
let hits = 0;
let same = true;
const kinds: Record<string, number> = {};
for (let i = 0; i < 2000; i++) {
  const g = safeGear({ ...fake, seed: `s${i}` }, { id: 'safe:0' }, W, 0.35);
  if (g) { hits++; kinds[g] = (kinds[g] ?? 0) + 1; }
  if (i < 50 && g !== safeGear({ ...fake, seed: `s${i}` }, { id: 'safe:0' }, W, 0.35)) same = false;
}
ok(same, 'deterministic per safe');
ok(Math.abs(hits / 2000 - 0.35) < 0.04, `gear in ${(100 * hits / 2000).toFixed(1)}% of safes (0.35)`);
ok(Object.keys(kinds).every((k) => !!ITEM_DEFS[k]), `only implemented gear: ${JSON.stringify(kinds)}`);

// ---------------- e2e: crack a safe, get the bonds (+ the predicted gear)
const srv = await testServer();
const url = `ws://127.0.0.1:${srv.port}/ws`;
const a = new Bot('Cracker');
try {
  await a.connect(url, `SAFE${Date.now() % 100000}`);
  let s: { id: string; x: number; z: number; face: [number, number]; combo: number[] } | undefined;
  let L: LevelLayout | null = null;
  for (let i = 0; i < 4 && !s; i++) {
    await a.dbg('level.generate', { seed: `g3-safe-${i}`, players: 2 });
    await a.settle(700);
    L = a.full!.layout as LevelLayout;
    s = (await a.dbg<{ safes: { id: string; x: number; z: number; face: [number, number]; combo: number[] }[] }>('safes.peek')).safes[0];
  }
  ok(!!s && !!L, `a safe to crack (${s?.id})`);
  if (s && L) {
    await a.dbg('monsters.freeze', { on: true }).catch(() => undefined);
    await a.dbg('interaction.pose', { x: s.x + s.face[0] * 0.9, z: s.z + s.face[1] * 0.9, yaw: Math.atan2(-s.face[0], -s.face[1]) });
    await a.settle(200);
    await a.req('interaction.use', { id: s.id });
    await a.waitEvent('safes.open', () => true, 3000).catch(() => null);
    let r: { ok: boolean; open?: boolean; value?: number; gearName?: string } = { ok: false };
    for (const n of s.combo) r = await a.req('safes.confirm', { id: s.id, pos: n });
    await a.settle(200);
    const inv = (a.ix.inventories[a.me] ?? []).filter(Boolean).map((id) => a.ix.items[id!]).filter(Boolean) as ItemState[];
    ok(r.open === true && inv.some((it) => it.name === 'Company bearer bonds' && it.value === r.value), `bonds in hand ($${r.value})`);
    const expect = safeGear(L, s, W, 0.35);
    const gear = inv.filter((it) => !it.type.startsWith('loot.'));
    ok(expect ? gear.some((it) => it.type === expect) && r.gearName === ITEM_DEFS[expect]?.name : gear.length === 0, `gear: predicted ${expect ?? 'none'}, got ${gear.map((x) => x.type).join(',') || 'none'} (${r.gearName ?? '-'})`);
  }
} catch (e) {
  ok(false, `threw: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
} finally {
  a.close();
  srv.stop();
}
console.log(fails() ? `FAILED (${fails()})` : 'ALL PASS');
process.exit(fails() ? 1 : 0);
