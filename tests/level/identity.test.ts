// Env-layout (v1.2 gate L1): the v1.2 generator with no theme / modifiers keeps every v1.1 layout identical outside
// the van (plan check #2), against the frozen golden set tests/fixtures/identity-v11 (never regenerated).
// Compared: spaces, doors, the owner grid (except the old + new van footprint) and every v1.1 item by (id, kind,
// space, x, z, y, rot, data). Expected differences: the van space rect/dist, VanInfo.z/cab.h, items in the van
// (console +1.0 m in z), v1.1's single van light (its id goes to the first v1.2 van light), the hub mirror (now in the
// van) and board (x0 + 2.55), metrics and the hash. Every v1.2 item is appended after the v1.1 items.
// Run: node --test tests/level/identity.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LayoutItem, LevelLayout } from '../../packages/shared/src/layout.ts';
import { generateFacility, generateHub, validateLayout } from '../../packages/shared/src/procgen/index.ts';
import type { LevelTuning } from '../../packages/shared/src/procgen/index.ts';
import { HUB } from '../../packages/shared/src/procgen/hub.ts';
import { VAN_CARGO_L, VAN_LEN, plannedVanStations } from '../../packages/shared/src/procgen/van.ts';

const DIR = resolve(import.meta.dirname, '../fixtures/identity-v11');
interface Entry { file: string; kind: 'facility' | 'hub'; seed: string; players?: number; risk?: number; hash: string }
const index = JSON.parse(readFileSync(resolve(DIR, 'index.json'), 'utf8')) as { tuning: LevelTuning; entries: Entry[] };
const V11_CARGO_L = 3, V11_LEN = 5;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const itemKey = (it: LayoutItem) => JSON.stringify([it.kind, it.space, it.x, it.z, it.y ?? null, it.rot ?? null, it.data ?? null]);

function compare(oldL: LevelLayout, L: LevelLayout): string[] {
  const errs: string[] = [];
  const e = (m: string) => { if (errs.length < 40) errs.push(m); };
  for (const k of ['genVersion', 'kind', 'seed', 'theme', 'W', 'H', 'entrance', 'zones', 'wallH'] as const) {
    if (!sameJson(oldL[k], L[k])) e(`${k}: ${JSON.stringify(oldL[k])} -> ${JSON.stringify(L[k])}`);
  }
  const oc = oldL.van.cab, c = L.van.cab;
  if (oc.x !== c.x || oc.y !== c.y || oc.w !== c.w || oldL.van.x !== L.van.x || oldL.van.yaw !== L.van.yaw) e(`van moved: ${JSON.stringify(oldL.van)} -> ${JSON.stringify(L.van)}`);
  if (oc.h !== V11_CARGO_L || c.h !== VAN_CARGO_L) e(`cargo length ${oc.h} -> ${c.h}`);
  if (L.van.z !== c.y + VAN_LEN / 2) e(`VanInfo.z ${L.van.z}`);
  // owner grid: identical outside the union of the old and new van footprints
  const inVan = (x: number, y: number) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + Math.max(VAN_LEN, V11_LEN);
  const vanSpace = oldL.owner[c.y * oldL.W + c.x];
  for (let y = 0; y < L.H; y++) for (let x = 0; x < L.W; x++) {
    const i = y * L.W + x;
    if (inVan(x, y)) {
      const want = y < c.y + VAN_CARGO_L ? vanSpace : -1;
      if (L.owner[i] !== want) e(`van cell ${x},${y}: ${L.owner[i]} (want ${want})`);
      continue;
    }
    if (oldL.owner[i] !== L.owner[i]) e(`owner ${x},${y}: ${oldL.owner[i]} -> ${L.owner[i]}`);
  }
  // spaces: identical except the van's rect (longer) and its dist
  if (oldL.spaces.length !== L.spaces.length) e(`spaces ${oldL.spaces.length} -> ${L.spaces.length}`);
  for (let i = 0; i < Math.min(oldL.spaces.length, L.spaces.length); i++) {
    const a = oldL.spaces[i], b = L.spaces[i];
    if (a.type === 'van') {
      const { rect: ra, dist: _da, ...restA } = a;
      const { rect: rb, dist: _db, ...restB } = b;
      if (!sameJson(restA, restB)) e(`van space ${i} changed beyond rect/dist`);
      if (!sameJson(rb, c) || ra.x !== rb.x || ra.y !== rb.y || ra.w !== rb.w) e(`van space rect ${JSON.stringify(ra)} -> ${JSON.stringify(rb)}`);
      continue;
    }
    if (!sameJson(a, b)) e(`space ${i}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  if (!sameJson(oldL.doors, L.doors)) e('doors changed');
  // items
  const byId = new Map(L.items.map((it) => [it.id, it]));
  const removed = oldL.items.filter((it) => it.kind === 'light' && it.space === vanSpace && it.data?.kind === 'van');
  if (removed.length !== 1) e(`v1.1 van lights x${removed.length}`);
  const kept = oldL.items.filter((it) => !removed.includes(it));
  // every v1.1 item keeps its index (the removed van light was the last light) and v1.2 items come after them
  for (let i = 0; i < kept.length; i++) if (L.items[i]?.id !== kept[i].id) { e(`item order: [${i}] ${kept[i].id} -> ${L.items[i]?.id}`); break; }
  const hubMirror = oldL.kind === 'hub' ? plannedVanStations(c).find((s) => s.kind === 'mirror')! : null;
  for (const it of kept) {
    const nu = byId.get(it.id);
    if (!nu) { e(`${it.id} missing`); continue; }
    if (nu.kind !== it.kind) { e(`${it.id} kind ${it.kind} -> ${nu.kind}`); continue; }
    if (it.space === vanSpace) {
      // van items: same formulas; the console sits on the front wall, 1 m further forward
      const dz = it.kind === 'console' ? 1 : 0;
      if (nu.x !== it.x || Math.abs(nu.z - (it.z + dz)) > 1e-9 || !sameJson(nu.data, it.data) || nu.rot !== it.rot || nu.y !== it.y) e(`van item ${it.id}: ${itemKey(it)} -> ${itemKey(nu)}`);
      continue;
    }
    if (hubMirror && it.kind === 'mirror') {
      if (nu.space !== vanSpace || nu.x !== hubMirror.x || nu.z !== hubMirror.z || nu.y !== hubMirror.y || nu.data?.mirror !== 'van' || nu.data?.solid !== false) e(`hub mirror not at the van mirror spot: ${itemKey(nu)}`);
      continue;
    }
    if (oldL.kind === 'hub' && it.kind === 'board') {
      const { x: _xa, ...ra } = it, { x: xb, ...rb } = nu;
      if (xb !== HUB.van.x0 + 2.55 || !sameJson(ra, rb)) e(`hub board: ${itemKey(it)} -> ${itemKey(nu)}`);
      continue;
    }
    if (itemKey(it) !== itemKey(nu)) e(`${it.id}: ${itemKey(it)} -> ${itemKey(nu)}`);
  }
  // the first v1.2 van light inherits the removed light's id
  if (removed[0]) {
    const heir = byId.get(removed[0].id);
    if (!heir || heir.kind !== 'light' || heir.space !== vanSpace) e(`${removed[0].id} is not a v1.2 van light`);
  }
  return errs;
}

for (const en of index.entries) {
  test(`identity v1.1 -> v1.2: ${en.file}`, () => {
    const oldL = JSON.parse(readFileSync(resolve(DIR, en.file), 'utf8')) as LevelLayout;
    assert.equal(oldL.hash, en.hash, 'golden file matches its index entry');
    const L = en.kind === 'hub' ? generateHub() : generateFacility({ seed: en.seed, players: en.players ?? 2, risk: en.risk ?? 1 }, index.tuning);
    assert.deepEqual(validateLayout(L).errors, [], 'v1.2 layout valid');
    assert.deepEqual(compare(oldL, L), []);
    assert.equal(L.metrics.attempt ?? 0, oldL.metrics.attempt ?? 0, 'same generation attempt');
  });
}
