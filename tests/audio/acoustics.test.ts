// env-audio (v1.2): acoustics.ts (reverb-send mapping, IR blend, occlusion tables) + config.ts (audio.json reader).
//   node --test tests/audio/acoustics.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { SITE_THEMES } from '../../packages/shared/src/procgen/themes.ts';
import { AUDIO_DEFAULTS, readAudioCfg } from '../../apps/client/src/audio/config.ts';
import {
  irBlend, legacyLowpass, occlusionOf, reverbSend, roomAtXZ, roomInfo, roomReverb, sizeK, spaceAt, wetLevel,
} from '../../apps/client/src/audio/acoustics.ts';
import type { RoomInfo } from '../../apps/client/src/audio/acoustics.ts';
import { occlusionParams } from '../../apps/client/src/audio/occlusion.ts';

const ROOT = join(import.meta.dirname, '../..');
const C = readAudioCfg(JSON.parse(readFileSync(join(ROOT, 'config/balance/audio.json'), 'utf8')));
const R = C.reverb;
const room = (o: Partial<RoomInfo> = {}): RoomInfo => ({ space: 0, volume: 180, open: false, corridor: false, surface: 'lino', theme: 'facility', echoes: false, ...o });

test('audio.json parses into a complete config; the contract keys are there', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'config/balance/audio.json'), 'utf8'));
  assert.equal(raw.occludeMonsters, false, 'monsters stay unoccluded until gameplay signs off');
  assert.deepEqual(raw.occlusionLowpassHz, C.occlusionLowpassHz);
  assert.equal(raw.occlusionPerWallDb, C.occlusionPerWallDb);
  // every key of audio.json is a known key (typos would silently fall back to defaults)
  const known = (d: Record<string, unknown>, r: Record<string, unknown>, path: string) => {
    for (const k of Object.keys(r)) {
      if (k.startsWith('_')) continue;
      assert.ok(k in d, `unknown audio.json key ${path}${k}`);
      const dv = d[k];
      if (dv && typeof dv === 'object' && !Array.isArray(dv) && !['surface', 'theme', 'kinds'].includes(k)) known(dv as Record<string, unknown>, r[k] as Record<string, unknown>, `${path}${k}.`);
    }
  };
  known(AUDIO_DEFAULTS as unknown as Record<string, unknown>, raw, '');
  for (const t of SITE_THEMES) assert.ok(typeof R.theme[t] === 'number', `reverb.theme.${t}`);
});

test('readAudioCfg: garbage falls back to defaults, partial overrides merge', () => {
  assert.deepEqual(readAudioCfg(null), AUDIO_DEFAULTS);
  assert.deepEqual(readAudioCfg('nope'), AUDIO_DEFAULTS);
  const c = readAudioCfg({ occlusionPerWallDb: 'x', occlusionLowpassHz: [1, -2], occludeMonsters: 1, reverb: { base: 0.3, surface: { tile: 2, bad: 'x' } }, hum: { max: Number.NaN } });
  assert.equal(c.occlusionPerWallDb, AUDIO_DEFAULTS.occlusionPerWallDb);
  assert.deepEqual(c.occlusionLowpassHz, AUDIO_DEFAULTS.occlusionLowpassHz);
  assert.equal(c.occludeMonsters, false);
  assert.equal(c.reverb.base, 0.3);
  assert.equal(c.reverb.surface.tile, 2);
  assert.equal(c.reverb.surface.carpet, AUDIO_DEFAULTS.reverb.surface.carpet);
  assert.equal(c.hum.max, AUDIO_DEFAULTS.hum.max);
  assert.equal(readAudioCfg({ occlusionPerWallDb: 6 }).occlusionPerWallDb, 0, 'occlusion never amplifies');
});

test('audio code reads occlusion / reverb from audio.json only, never voice.json', () => {
  const dir = join(ROOT, 'apps/client/src/audio');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const code = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/balance\.voice|balance\[['"]voice['"]\]|voice\.json/.test(code), `${f} reads voice.json`);
  }
});

test('reverb send mapping: room size, surface, theme, corridor, outdoors, mod:echoes', () => {
  // size
  assert.ok(sizeK(20, R) < sizeK(180, R) && sizeK(180, R) < sizeK(1200, R));
  assert.ok(roomReverb(room({ volume: 27 }), R) < roomReverb(room({ volume: 1500 }), R));
  // hard floors ring, soft ones damp
  assert.ok(roomReverb(room({ surface: 'tile' }), R) > roomReverb(room({ surface: 'lino' }), R));
  assert.ok(roomReverb(room({ surface: 'lino' }), R) > roomReverb(room({ surface: 'carpet' }), R));
  assert.ok(roomReverb(room({ surface: 'metal' }), R) > roomReverb(room({ surface: 'wood' }), R));
  // themes: the waterworks rings, records paper damps
  assert.ok(roomReverb(room({ theme: 'waterworks' }), R) > roomReverb(room({ theme: 'facility' }), R));
  assert.ok(roomReverb(room({ theme: 'records' }), R) < roomReverb(room({ theme: 'facility' }), R));
  assert.ok(roomReverb(room({ corridor: true }), R) > roomReverb(room(), R));
  assert.ok(roomReverb(room({ open: true }), R) < roomReverb(room(), R) * 0.5, 'the lot has no ceiling');
  // mod:echoes raises reverb
  assert.ok(roomReverb(room({ echoes: true }), R) > roomReverb(room(), R) * 1.3);
  assert.ok(irBlend(room({ echoes: true, volume: 100 }), R) > irBlend(room({ volume: 100 }), R));
  assert.ok(wetLevel(room({ echoes: true }), R) > wetLevel(room(), R));
});

test('reverb send: through walls less, far sources wetter then fading; always finite and in [0, max]', () => {
  const r = room({ volume: 300, surface: 'tile' });
  const s0 = reverbSend(r, 3, 1, R);
  assert.ok(reverbSend(r, 3, 0.25, R) < s0, 'walls damp the send');
  assert.ok(reverbSend(r, 3, 0.25, R) > s0 * 0.25, 'but less than the direct path (the tail survives)');
  assert.ok(reverbSend(r, 8, 1, R) > reverbSend(r, 1, 1, R) * 0.9);
  assert.ok(reverbSend(r, 60, 1, R) < reverbSend(r, 8, 1, R));
  const vals = [Number.NaN, Infinity, -Infinity, -5, 0, 1e9];
  for (const v of vals) for (const w of vals) {
    const s = reverbSend(room({ volume: v }), v, w, R);
    assert.ok(Number.isFinite(s) && s >= 0 && s <= R.max, `send(${v}, ${w}) = ${s}`);
  }
  assert.ok(Number.isFinite(reverbSend(null, 5, 1, R)));
});

test('IR blend: small rooms dry, halls wet, corridors in between, unknown = the v1.1 hall', () => {
  assert.equal(irBlend(null, R), 1);
  assert.ok(irBlend(room({ volume: 27 }), R) < 0.1);
  assert.ok(irBlend(room({ volume: 2000 }), R) > 0.95);
  assert.ok(irBlend(room({ volume: 60, corridor: true }), R) >= R.irCorridor);
  assert.equal(irBlend(room({ open: true }), R), R.irOutdoor);
  for (const v of [1, 50, 100, 300, 800, 5000]) { const m = irBlend(room({ volume: v }), R); assert.ok(m >= 0 && m <= 1); }
  assert.ok(wetLevel(room({ open: true }), R) < 1);
});

test('occlusion (opts.occlude) uses the audio.json tables; the legacy lowpass is the v1.1 formula', () => {
  assert.deepEqual(occlusionOf(0, C), { freq: 20000, gain: 1 });
  assert.ok(Math.abs(occlusionOf(1, C).gain - Math.pow(10, -6 / 20)) < 1e-9);
  assert.equal(Math.round(occlusionOf(1, C).freq), 2400);
  let prev = occlusionOf(0, C);
  for (let w = 0.25; w <= 4; w += 0.25) {
    const o = occlusionOf(w, C);
    assert.ok(o.gain < prev.gain && o.freq <= prev.freq, `monotonic at ${w}`);
    prev = o;
  }
  // v1.1 (sfx.ts read voice.json's identical table): frozen behaviour for monsters / items
  const V11 = [20000, 2400, 1200, 700, 450];
  for (let w = 0; w <= 4; w += 0.25) assert.equal(legacyLowpass(w, C), occlusionParams(w, V11, -6).freq);
  for (const w of [Number.NaN, -1, 99]) assert.ok(Number.isFinite(occlusionOf(w, C).gain) && Number.isFinite(legacyLowpass(w, C)));
});

test('roomAtXZ: spaces by the owner grid; the sealed van cab (solid cells) is a tiny dry metal room', () => {
  const L = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/layouts/facility_s1_p2.json'), 'utf8')) as LevelLayout;
  const it = L.items.find((i) => i.kind === 'light')!;
  assert.equal(roomAtXZ(L, it.x, it.z)?.space, it.space);
  const c = L.van.cab;
  const cx = c.x + c.w / 2, cz = c.y + c.h / 2;
  if (spaceAt(L, cx, cz) < 0) {
    const cab = roomAtXZ(L, cx, cz)!;
    assert.ok(cab && cab.space === -1 && cab.surface === 'metal' && cab.volume < 20);
    assert.ok(irBlend(cab, R) < 0.05, 'the cab sounds dry');
  }
  assert.equal(roomAtXZ(L, -50, -50), null);
});

test('roomInfo on real layouts: every space finite, surfaces from floorSurface, themes and mods read', () => {
  const dir = join(ROOT, 'tests/fixtures/layouts');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const L = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LevelLayout;
    for (const s of L.spaces) {
      const ri = roomInfo(L, s.id)!;
      assert.ok(ri && Number.isFinite(ri.volume) && ri.volume >= 1, `${f} space ${s.id}`);
      assert.ok(typeof ri.surface === 'string' && ri.surface.length > 0);
      const send = reverbSend(ri, 4, 1, R);
      assert.ok(Number.isFinite(send) && send >= 0 && send <= R.max);
    }
    assert.equal(roomInfo(L, -1), null);
    assert.equal(roomInfo(L, 9999), null);
    // spaceAt agrees with the owner grid
    const it = L.items.find((i) => i.kind === 'light')!;
    assert.equal(spaceAt(L, it.x, it.z), L.owner[Math.floor(it.z) * L.W + Math.floor(it.x)]);
    assert.equal(spaceAt(L, -3, 2), -1);
    assert.equal(spaceAt(L, Number.NaN, 2), -1);
    const themed = { ...L, theme: 'waterworks', metrics: { ...L.metrics, 'mod:echoes': 1 } } as LevelLayout;
    const a = roomInfo(themed, it.space)!;
    assert.equal(a.theme, 'waterworks');
    assert.equal(a.echoes, true);
    assert.equal(roomInfo(L, it.space, 'carpet')!.surface, 'carpet', 'level.surfaceAt wins over floorSurface');
  }
});
