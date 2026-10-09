// Env-layout (v1.2): asset staging never touches the live .assets/dist (the :3000 server serves it) and staged
// manifests only ever add keys.
//  1. a staged run (tools/fetch-assets.mjs --dist <tmp copy of the live dist> --only fonts --no-keys-ts) leaves every
//     file of .assets/dist byte- and mtime-identical, and its manifest keeps every live key with the same urls
//  2. the shared stage (%TEMP%/dead-air-assets-stage/dist, when present) is an additive superset of the live manifest,
//     every staged url exists, every staged source is credited, and the shared key lists in assets.ts cover it
//  3. clutter DECAL_CELLS match the built decal atlas index; every newly staged KTX2 (and prop GLB image) transcodes
//     with three's Basis transcoder on the CPU (no GPU)
// Run: node --test tests/level/staging.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ASSET_KEYS, MATERIAL_IDS } from '../../packages/shared/src/assets.ts';
import type { AssetManifest } from '../../packages/shared/src/assets.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const LIVE = join(ROOT, '.assets/dist');
const STAGE = 'C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage/dist';
const haveLive = existsSync(join(LIVE, 'manifest.json'));
const fontCached = existsSync(join(ROOT, '.assets/src/fonts/reenie_beanie/ReenieBeanie.ttf'));

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(dir, p).split('\\').join('/'), `${st.size}|${st.mtimeMs}|${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return out;
}
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as AssetManifest;
function additive(live: AssetManifest, staged: AssetManifest): string[] {
  const bad: string[] = [];
  for (const [k, e] of Object.entries(live.files)) {
    const s = staged.files[k];
    if (!s) bad.push(`${k} dropped`);
    else if (s.url !== e.url || JSON.stringify(s.alt ?? null) !== JSON.stringify(e.alt ?? null)) bad.push(`${k} changed ${e.url} -> ${s.url}`);
  }
  return bad;
}

test('a staged fetch-assets run leaves .assets/dist untouched and keeps every live key', { skip: (!haveLive || !fontCached) && 'needs .assets/dist and the cached font' }, () => {
  const before = snapshot(LIVE);
  const tmp = mkdtempSync(join(tmpdir(), 'deadair-stage-test-'));
  try {
    const dist = join(tmp, 'dist');
    cpSync(LIVE, dist, { recursive: true, preserveTimestamps: true });
    const out = execFileSync(process.execPath, [join(ROOT, 'tools/fetch-assets.mjs'), '--dist', dist, '--only', 'fonts', '--no-keys-ts'], { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /\(staged\)/);
    const after = snapshot(LIVE);
    const diff = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    assert.deepEqual(diff, [], '.assets/dist changed');
    const live = manifest(LIVE), staged = manifest(dist);
    assert.deepEqual(additive(live, staged), []);
    for (const k of ['font.reenie_beanie', 'font.reenie_beanie.license']) {
      assert.ok(staged.files[k], `${k} staged`);
      assert.ok(existsSync(join(dist, staged.files[k].url)), `${k} file`);
    }
    assert.equal(staged.files['font.reenie_beanie'].type, 'ttf');
    // no temp files left behind by the atomic writes
    assert.deepEqual(readdirSync(dist).filter((n) => n.includes('.tmp-')), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the shared stage is an additive, credited superset of the live manifest', { skip: (!haveLive || !existsSync(join(STAGE, 'manifest.json'))) && 'no shared stage' }, () => {
  const live = manifest(LIVE), staged = manifest(STAGE);
  assert.deepEqual(additive(live, staged), []);
  const missing: string[] = [];
  for (const [k, e] of Object.entries(staged.files)) for (const u of [e.url, ...Object.values(e.alt ?? {})]) if (!existsSync(join(STAGE, u as string))) missing.push(`${k}: ${u}`);
  assert.deepEqual(missing, []);
  const credits = JSON.parse(readFileSync(join(STAGE, 'credits.json'), 'utf8')) as { sources: { id: string; license: string; keys: string[] }[] };
  const credited = new Set(credits.sources.flatMap((s) => s.keys));
  const uncredited = Object.keys(staged.files).filter((k) => !live.files[k] && !credited.has(k));
  assert.deepEqual(uncredited, [], 'every new staged key is credited');
  for (const s of credits.sources) assert.ok(/^(CC0|CC-BY|OFL|ElevenLabs)/.test(s.license), `${s.id}: licence ${s.license}`);
  // size budget: <= +40 MB over the live set
  assert.ok(staged.totalBytes - live.totalBytes <= 40e6, `+${((staged.totalBytes - live.totalBytes) / 1e6).toFixed(1)} MB`);
  // the shared key lists (a union) cover everything staged; every v1.2 material id has its 3 maps staged
  const keys = new Set<string>(ASSET_KEYS);
  assert.deepEqual(Object.keys(staged.files).filter((k) => !keys.has(k)), []);
  for (const id of MATERIAL_IDS) for (const m of ['albedo', 'normal', 'orm']) assert.ok(staged.files[`tex.${id}.${m}`], `tex.${id}.${m} staged`);
  for (const m of ['tiles_subway', 'terrazzo', 'wood_panel', 'carpet', 'grating', 'insulated_panel']) {
    assert.equal(staged.files[`tex.${m}.albedo`].group, 'site', `${m} loads lazily (site group)`);
    assert.equal(staged.files[`tex.${m}.albedo`].res, '1k');
  }
});

test('clutter DECAL_CELLS match the built decal atlas index (names, kinds, surfaces, widths, order)', { skip: !existsSync(join(ROOT, '.assets/build/decals/index.json')) && 'no decal build' }, async () => {
  const { DECAL_CELLS } = await import('../../packages/shared/src/procgen/clutter.ts');
  const idx = JSON.parse(readFileSync(join(ROOT, '.assets/build/decals/index.json'), 'utf8')) as { cells: { idx: number; name: string; kind: string; surface: string; size: [number, number]; uv: number[] }[] };
  assert.equal(idx.cells.length, DECAL_CELLS.length);
  for (const c of idx.cells) {
    const d = DECAL_CELLS[c.idx];
    assert.deepEqual([d.name, d.kind, d.surface, d.w], [c.name, c.kind, c.surface, c.size[0]], `cell ${c.idx}`);
    assert.ok(c.uv[0] < c.uv[2] && c.uv[1] < c.uv[3] && c.uv.every((v) => v >= 0 && v <= 1), `cell ${c.idx} uv`);
  }
  // the staged index (when staged) is the same build
  if (existsSync(join(STAGE, 'manifest.json'))) {
    const e = manifest(STAGE).files['decal.index'];
    if (e) assert.deepEqual(JSON.parse(readFileSync(join(STAGE, e.url), 'utf8')).cells, idx.cells);
  }
});

test('every newly staged KTX2 (textures, decal atlas, prop GLB images) transcodes on the CPU', { skip: (!haveLive || !existsSync(join(STAGE, 'manifest.json'))) ? 'no shared stage' : (() => { try { const live = manifest(LIVE).files; return Object.keys(manifest(STAGE).files).every((k) => live[k]) && 'the stage adds no new keys (fully promoted into .assets/dist): nothing new to transcode'; } catch { return false; } })() }, async () => {
  const { decodeKtx2 } = await import('./ktx2-decode.ts');
  const live = manifest(LIVE), staged = manifest(STAGE);
  const fresh = Object.entries(staged.files).filter(([k]) => !live.files[k]);
  const bad: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), 'deadair-ktx2-'));
  try {
    let n = 0;
    for (const [k, e] of fresh) {
      if (e.type === 'ktx2') {
        const r = await decodeKtx2(join(STAGE, e.url));
        n++;
        const pow2 = (v: number) => (v & (v - 1)) === 0;
        if (!pow2(r.width) || !pow2(r.height) || r.levels < 10) bad.push(`${k}: ${r.width}x${r.height} levels ${r.levels}`);
        if (k === 'decal.atlas' && !r.alpha) bad.push('decal.atlas has no alpha');
      } else if (e.type === 'glb') {
        const b = readFileSync(join(STAGE, e.url));
        const jl = b.readUInt32LE(12);
        const json = JSON.parse(b.subarray(20, 20 + jl).toString('utf8')) as { images?: { mimeType?: string; bufferView?: number }[]; bufferViews: { byteOffset?: number; byteLength: number }[] };
        const bin = b.subarray(20 + jl + 8);
        for (const [i, im] of (json.images ?? []).entries()) {
          if (im.mimeType !== 'image/ktx2' || im.bufferView === undefined) { bad.push(`${k}: image ${i} is ${im.mimeType}`); continue; }
          const bv = json.bufferViews[im.bufferView];
          const f = join(tmp, `${k}.${i}.ktx2`);
          writeFileSync(f, bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
          await decodeKtx2(f);
          n++;
        }
      }
    }
    console.log(JSON.stringify({ newKeys: fresh.length, ktx2Decoded: n }));
    assert.ok(n > 30, `only ${n} KTX2 images decoded`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.deepEqual(bad, []);
});
