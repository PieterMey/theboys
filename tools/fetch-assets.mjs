#!/usr/bin/env node
// DEAD AIR asset pipeline (assets track). Re-runnable and idempotent: downloads are skipped when present,
// optimized outputs are skipped when present (use --force to rebuild them), ElevenLabs audio is generated once and cached.
//
//   node tools/fetch-assets.mjs                         # fetch + build + emit everything
//   node tools/fetch-assets.mjs --only chars,anims,hound,tex,props,audio,el,emit
//   node tools/fetch-assets.mjs --force                 # rebuild optimized outputs (never re-downloads)
//   node --env-file=.env tools/fetch-assets.mjs --only el,emit --generate   # ElevenLabs build-time generation (costs credits)
//   node tools/fetch-assets.mjs --dist <dir> --only tex,fonts               # v1.2 staging: hashed files + manifest + credits
//                                                                           # go to <dir> (a copy of .assets/dist); src/build stay shared
//   --no-prune   keep stale hashed files in a --dist stage (writing .assets/dist never prunes: the live server serves it;
//                --prune forces it there, only with the game server stopped)
//   --no-keys-ts do not rewrite packages/shared/src/assets.ts (its key lists are a union: keys are only ever added)
//   v1.2 item models: props.items entries with "item": true build as one-mesh / one-material world items
//   (prop.item_*, see buildItem below); stage them with --dist <stage> --only props,emit --no-prune
//
// Layout: .assets/src   raw downloads (untrusted data; never executed)
//         .assets/build optimized outputs with stable names
//         .assets/dist  content-hashed copies + manifest.json + credits.json (served by the game server at /assets/)
// Tools:  gltfpack 1.3 native binary (tools/bin/gltfpack.exe, else .assets/bin, else downloaded from GitHub).
//         The npm gltfpack has no BasisU/WebP support, so it is never used.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, basename, extname, resolve, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const A = join(ROOT, '.assets');
const SRC = join(A, 'src');
const BUILD = join(A, 'build');
const LIVE_DIST = join(A, 'dist');
const M = JSON.parse(readFileSync(join(ROOT, 'tools/assets.manifest.json'), 'utf8'));
const UA = M.userAgent || 'DeadAir-build/1.0';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n) => {
  const i = argv.indexOf('--' + n);
  if (i >= 0) return argv[i + 1];
  const a = argv.find((x) => x.startsWith('--' + n + '='));
  return a ? a.slice(n.length + 3) : undefined;
};
const ONLY = opt('only')?.split(',');
// v1.2: --dist <dir> stages the hashed outputs + manifest + credits elsewhere (never the live .assets/dist)
const DIST = opt('dist') ? resolve(opt('dist')) : LIVE_DIST;
const STAGED = DIST !== LIVE_DIST;
const PRUNE = STAGED ? !argv.includes('--no-prune') : argv.includes('--prune');
const FORCE = flag('force');
const want = (s) => !ONLY || ONLY.includes(s);
const log = (...a) => console.log('[assets]', ...a);
const warn = (...a) => console.warn('[assets] WARN', ...a);
const rel = (p) => relative(ROOT, p).replaceAll('\\', '/');
const mkdirp = (d) => mkdirSync(d, { recursive: true });
/** write via a temp file + rename, so a reader (the live server, a browser) never sees a half-written file */
function writeAtomic(file, data) {
  mkdirp(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------------------
// registry -> manifest
// ---------------------------------------------------------------------------------------------------------------
const REG = new Map(); // key -> { file, out, group, credit, extra, alt }
const CREDITS = new Map(); // id -> { title, author, license, url, note }
function credit(id, info) {
  if (!CREDITS.has(id)) CREDITS.set(id, { ...info, keys: [] });
  return id;
}
/** Register a built file under a logical key. `out` is the dist path without hash, e.g. "characters/mannequin_m.glb". */
function reg(key, file, out, { group = 'site', credit: c, extra, alt } = {}) {
  if (!existsSync(file)) return warn('missing build output for', key, rel(file));
  REG.set(key, { file, out, group, credit: c, extra, alt });
  if (c && CREDITS.has(c)) CREDITS.get(c).keys.push(key);
}

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

async function download(url, dest, { headers = {}, minBytes = 1, expectZip = false } = {}) {
  if (existsSync(dest) && statSync(dest).size >= minBytes) return false;
  mkdirp(dirname(dest));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < minBytes) throw new Error(`GET ${url}: only ${buf.length} bytes`);
      if (expectZip && buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`GET ${url}: not a zip`);
      writeFileSync(dest + '.part', buf);
      renameSync(dest + '.part', dest);
      return true;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

function extractZip(zip, dir) {
  if (existsSync(dir) && readdirSync(dir).length) return false;
  mkdirp(dir);
  if (process.platform === 'win32') {
    // Windows ships bsdtar, which reads zip and refuses absolute / ".." paths by default.
    execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir]);
  } else execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
  return true;
}

function run(cmd, args, { quiet = true } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', rej);
    p.on('close', (code) => {
      if (code === 0) {
        if (!quiet && out.trim()) log(out.trim());
        res(out);
      } else rej(new Error(`${basename(cmd)} ${args.join(' ')} -> exit ${code}\n${out.slice(-2000)}`));
    });
  });
}

let GLTFPACK = null;
async function gltfpackBin() {
  if (GLTFPACK) return GLTFPACK;
  const exe = process.platform === 'win32' ? 'gltfpack.exe' : 'gltfpack';
  for (const p of [join(ROOT, 'tools/bin', exe), join(A, 'bin', exe)]) if (existsSync(p)) return (GLTFPACK = p);
  if (process.platform !== 'win32') throw new Error('gltfpack native binary not found (put it in tools/bin/)');
  const zip = join(A, 'bin/gltfpack-windows.zip');
  await download('https://github.com/zeux/meshoptimizer/releases/download/v1.3/gltfpack-windows.zip', zip, { expectZip: true });
  extractZip(zip, join(A, 'bin/gltfpack-x'));
  copyFileSync(join(A, 'bin/gltfpack-x', exe), join(A, 'bin', exe));
  return (GLTFPACK = join(A, 'bin', exe));
}
async function gltfpack(args) {
  const o = args.indexOf('-o');
  if (o >= 0) mkdirp(dirname(args[o + 1])); // gltfpack does not create directories
  return run(await gltfpackBin(), args);
}

// --- minimal glTF/GLB IO (no deps) ---
function readGltf(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) return { json: JSON.parse(buf.toString('utf8')), bin: null };
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = Buffer.from(chunk);
    off += 8 + len;
  }
  return { json, bin };
}
function writeGlb(file, json, bin) {
  mkdirp(dirname(file));
  const j = Buffer.from(JSON.stringify(json));
  const jp = Buffer.alloc((4 - (j.length % 4)) % 4, 0x20);
  const b = bin || Buffer.alloc(0);
  const bp = Buffer.alloc((4 - (b.length % 4)) % 4, 0);
  const total = 12 + 8 + j.length + jp.length + (b.length ? 8 + b.length + bp.length : 0);
  const h = Buffer.alloc(12);
  h.writeUInt32LE(0x46546c67, 0);
  h.writeUInt32LE(2, 4);
  h.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length + jp.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const parts = [h, jh, j, jp];
  if (b.length) {
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(b.length + bp.length, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    parts.push(bh, b, bp);
  }
  writeFileSync(file, Buffer.concat(parts));
}
function accessorFloats(json, bin, i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  if (a.componentType !== 5126) throw new Error('accessorFloats: float only');
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || n * 4;
  const out = new Float32Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = bin.readFloatLE(start + k * stride + c * 4);
  return out;
}
/** Summary of a built GLB for verification: counts, clip names, extensions, bytes. */
function summarizeGlb(file) {
  const { json } = readGltf(file);
  return {
    bytes: statSync(file).size,
    meshes: json.meshes?.length || 0,
    skins: json.skins?.length || 0,
    joints: json.skins?.[0]?.joints.length || 0,
    materials: (json.materials || []).map((m) => m.name || ''),
    textures: json.textures?.length || 0,
    clips: (json.animations || []).map((a) => a.name),
    ext: json.extensionsRequired || [],
  };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const fresh = (out) => !FORCE && existsSync(out) && statSync(out).size > 0;

// ---------------------------------------------------------------------------------------------------------------
// sources: archives (zip) incl. the itch.io free-download flow
// ---------------------------------------------------------------------------------------------------------------
async function itchDownload(game, upload, dest) {
  if (existsSync(dest)) return false;
  // Verified flow (docs/research/verify-answers.md): GET page (cookies + csrf meta), POST /file/<upload> as XHR, GET signed URL within 60 s.
  const r1 = await fetch(game, { headers: { 'User-Agent': UA } });
  const html = await r1.text();
  const csrf = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('itch: csrf_token not found');
  const cookie = r1.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const r2 = await fetch(`${game}/file/${upload}?source=game_download`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ csrf_token: csrf }).toString(),
  });
  const j = await r2.json();
  if (!j.url) throw new Error('itch: no download url: ' + JSON.stringify(j).slice(0, 200));
  await download(j.url, dest, { expectZip: true });
  return true;
}
async function ensureArchive(id) {
  const spec = M.archives[id];
  const zip = join(SRC, '_dl', spec.file);
  if (!existsSync(zip)) {
    log('download', id);
    if (spec.itch) await itchDownload(spec.itch.game, spec.itch.upload, zip);
    else await download(spec.url, zip, { expectZip: true });
  }
  if (extractZip(zip, join(SRC, id))) log('extracted', id);
  credit('quaternius_' + id, { title: spec.title, author: spec.author, license: spec.license, url: spec.page });
  return join(SRC, id);
}

// ---------------------------------------------------------------------------------------------------------------
// characters + animations (Quaternius UAL, 65-joint UE-style rig)
// ---------------------------------------------------------------------------------------------------------------
async function stepCharacters() {
  for (const [key, spec] of Object.entries(M.characters)) {
    const dir = await ensureArchive(spec.archive);
    const out = join(BUILD, spec.out);
    if (!fresh(out)) {
      const { json, bin } = readGltf(join(dir, spec.path));
      delete json.animations; // meshes only; clips come from anims/*.glb
      const tmp = join(BUILD, '_tmp', basename(spec.out));
      writeGlb(tmp, json, bin);
      // -kn/-km keep the node + material names (M_Main = suit primary, M_Joints = suit secondary); no simplify/flatten.
      await gltfpack(['-i', tmp, '-o', out, '-cc', '-kn', '-km']);
      log('built', key, JSON.stringify(summarizeGlb(out)));
    }
    reg(key, out, spec.out, { group: 'boot', credit: 'quaternius_' + spec.archive });
  }
}

const KEEP_TRANSLATION = new Set(['root', 'pelvis']);
function stripTracks(json) {
  // UAL clips carry translation+rotation+scale on all 65 joints. Scale is always 1 and translations (except root/pelvis)
  // equal the rest pose (measured: max deviation 1e-6), so dropping them is lossless for the male mesh and REQUIRED for
  // other bodies (Mannequin_F has shorter arms). Rotation tracks are kept on every joint (gltfpack -ac) so clips fully
  // specify the pose on any body (no pops when cross-fading).
  let removed = 0;
  for (const an of json.animations || []) {
    const before = an.channels.length;
    an.channels = an.channels.filter((ch) => {
      const name = json.nodes[ch.target.node]?.name;
      if (ch.target.path === 'scale') return false;
      if (ch.target.path === 'translation' && !KEEP_TRANSLATION.has(name)) return false;
      return true;
    });
    removed += before - an.channels.length;
    const used = [...new Set(an.channels.map((c) => c.sampler))];
    const remap = new Map(used.map((s, i) => [s, i]));
    an.samplers = used.map((s) => an.samplers[s]);
    for (const ch of an.channels) ch.sampler = remap.get(ch.sampler);
  }
  return removed;
}

async function stepAnimations() {
  const clips = {};
  for (const [key, spec] of Object.entries(M.animations)) {
    const dir = await ensureArchive(spec.archive);
    const out = join(BUILD, spec.out);
    if (!fresh(out)) {
      const { json, bin } = readGltf(join(dir, spec.path));
      for (const n of json.nodes) {
        delete n.mesh;
        delete n.skin;
      }
      for (const k of ['meshes', 'skins', 'materials', 'textures', 'images', 'samplers']) delete json[k];
      const removed = stripTracks(json);
      const tmp = join(BUILD, '_tmp', basename(spec.out));
      writeGlb(tmp, json, bin);
      await gltfpack(['-i', tmp, '-o', out, '-cc', '-ac', '-kn']);
      log('built', key, `stripped ${removed} tracks`, JSON.stringify({ ...summarizeGlb(out), clips: undefined }));
    }
    clips[key] = summarizeGlb(out).clips;
    reg(key, out, spec.out, { group: 'boot', credit: 'quaternius_' + spec.archive });
  }
  // natural (root-motion) speeds from the UAL1 _RM file, so the players track can sync timeScale = speed / natural
  const natural = {};
  try {
    const rm = join(SRC, 'ual1', 'Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard_RM.glb');
    if (existsSync(rm)) {
      const { json, bin } = readGltf(rm);
      const rootIdx = json.nodes.findIndex((n) => n.name === 'root');
      for (const an of json.animations) {
        const ch = an.channels.find((c) => c.target.node === rootIdx && c.target.path === 'translation');
        if (!ch) continue;
        const s = an.samplers[ch.sampler];
        const t = accessorFloats(json, bin, s.input);
        const v = accessorFloats(json, bin, s.output);
        const dur = t[t.length - 1] - t[0];
        const n = v.length / 3;
        // root.translation is expressed in the parent (Armature, glTF Y-up) frame: ground plane = X/Z.
        const d = Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 2] - v[2]);
        if (dur > 0 && d > 0.05) natural[an.name] = +(d / dur).toFixed(3);
      }
    }
  } catch (e) {
    warn('root-motion speeds:', e.message);
  }
  writeClipmap(clips, natural);
}

function writeClipmap(clips, natural) {
  const has = (file, clip) => clips[`anim.${file}`]?.includes(clip);
  const c = (file, clip, loop, extra = {}) => {
    if (!has(file, clip)) warn('clipmap: missing clip', file, clip);
    return { file: `anim.${file}`, clip, loop, ...(natural[clip] ? { naturalSpeed: natural[clip] } : {}), ...extra };
  };
  const clipmap = {
    note: 'ANIM id name (packages/shared/src/anim.ts) -> clip. Bind by bone name with AnimationMixer on char.mannequin_m/_f (same 65-joint UAL rig). Build already stripped scale tracks and translation tracks except root/pelvis. naturalSpeed (m/s, measured from the UAL1 _RM root track: walk 0.98, jog 5.36, sprint 8.25, crouch 0.75) lets you set timeScale = moveSpeed / naturalSpeed; the jog/sprint values look fast, so check foot sliding visually. The SkinnedMesh is an unnamed child of node "Mannequin": find it with traverse(o => o.isSkinnedMesh).',
    rig: { joints: 65, hand_r: 'hand_r', hand_l: 'hand_l', head: 'Head', spine: 'spine_03', materials: { primary: 'M_Main', secondary: 'M_Joints' } },
    files: { 'anim.ual1': clips['anim.ual1'] || [], 'anim.ual2': clips['anim.ual2'] || [] },
    players: {
      idle: c('ual1', 'Idle_Loop', true, { alt: [c('ual1', 'Idle_Torch_Loop', true, { note: 'holding flashlight up' }), c('ual2', 'Idle_Lantern_Loop', true, { note: 'holding light forward' })] }),
      walk: c('ual1', 'Walk_Loop', true),
      jog: c('ual1', 'Jog_Fwd_Loop', true),
      sprint: c('ual1', 'Sprint_Loop', true),
      crouchIdle: c('ual1', 'Crouch_Idle_Loop', true),
      crouchWalk: c('ual1', 'Crouch_Fwd_Loop', true),
      interact: c('ual1', 'Interact', false, { alt: [c('ual1', 'Fixing_Kneeling', true, { note: 'long repair/breaker work' }), c('ual2', 'Chest_Open', false, { note: 'locker / crate' }), c('ual1', 'Push_Loop', true, { note: 'push / lever' })] }),
      pickup: c('ual1', 'PickUp_Table', false),
      carry: c('ual2', 'Walk_Carry_Loop', true, { note: 'no carry-idle clip: play at timeScale 0 when standing still' }),
      carryWalk: c('ual2', 'Walk_Carry_Loop', true),
      throw: c('ual2', 'OverhandThrow', false),
      swing: c('ual2', 'Sword_Regular_A', false, { note: 'crowbar swing', alt: [c('ual2', 'Melee_Hook', false), c('ual1', 'Sword_Attack', false)] }),
      death: c('ual1', 'Death01', false, { clampWhenFinished: true }),
      hidden: null,
      // emotes checked visually in .assets/dist/_viewer.html (no real wave/beckon clip exists in the free UAL sets)
      emoteWave: c('ual1', 'Spell_Simple_Idle_Loop', true, { approx: true, note: 'palm raised at shoulder height (static hello)' }),
      emotePoint: c('ual1', 'Spell_Simple_Shoot', false, { approx: true, note: 'one arm thrust forward, palm out; Spell_Simple_Enter is similar', alt: [c('ual1', 'Pistol_Aim_Neutral', false, { note: 'two-handed aim' })] }),
      emoteBeckon: c('ual1', 'Idle_Talking_Loop', true, { approx: true, note: 'talking hand gestures' }),
      emoteThumbs: c('ual2', 'Yes', false, { note: 'thumbs up' }),
      grabbed: c('ual2', 'Hit_Knockback', false, { alt: [c('ual1', 'Hit_Chest', false)] }),
      extra: {
        revive: c('ual2', 'LayToIdle', false),
        hitHead: c('ual1', 'Hit_Head', false),
        noShake: c('ual2', 'Idle_No_Loop', true),
        phone: c('ual2', 'Idle_TalkingPhone_Loop', true, { note: 'hand at the ear: talking on the walkie' }),
        leanRail: c('ual2', 'Idle_Rail_Call', true, { note: 'leaning forward on a rail' }),
        sit: c('ual1', 'Sitting_Idle_Loop', true, { note: 'van seats' }),
        drive: c('ual1', 'Driving_Loop', true),
        climb: c('ual2', 'ClimbUp_1m_RM', false),
        foldArms: c('ual2', 'Idle_FoldArms_Loop', true),
        dance: c('ual1', 'Dance_Loop', true),
      },
    },
    listener: {
      note: 'UAL mannequin with elongated bones; zombie clips',
      mIdle: c('ual2', 'Zombie_Idle_Loop', true),
      mWalk: c('ual2', 'Zombie_Walk_Fwd_Loop', true),
      mRun: c('ual2', 'Zombie_Walk_Fwd_Loop', true, { timeScale: 2.2 }),
      mAttack: c('ual2', 'Zombie_Scratch', false),
      mAlert: c('ual2', 'Idle_No_Loop', false, { note: 'head sweep' }),
      mEat: c('ual1', 'Fixing_Kneeling', true, { note: 'kneels over the body' }),
      mFrozen: c('ual2', 'Zombie_Idle_Loop', true, { timeScale: 0 }),
    },
    mannequin: {
      note: 'porcelain UAL mannequin; frozen = any clip paused (timeScale 0) at a random time',
      mIdle: c('ual1', 'A_TPose', true, { timeScale: 0 }),
      mFrozen: c('ual1', 'Walk_Formal_Loop', true, { timeScale: 0, note: 'pose snapshot; vary the time per freeze' }),
      mWalk: c('ual1', 'Walk_Formal_Loop', true),
      mRun: c('ual1', 'Sprint_Loop', true),
      mAttack: c('ual1', 'Punch_Cross', false),
      mAlert: c('ual1', 'Idle_Loop', true),
    },
    hound: {
      file: 'mon.hound',
      note: 'Zombie Apocalypse Kit German Shepherd (50 joints); clip names as in the file',
      mIdle: { file: 'mon.hound', clip: 'Idle_2_HeadLow', loop: true, note: 'head low, sniffing (blind)' },
      mWalk: { file: 'mon.hound', clip: 'Walk', loop: true },
      mRun: { file: 'mon.hound', clip: 'Run', loop: true },
      mAttack: { file: 'mon.hound', clip: 'Attack', loop: false, alt: [{ file: 'mon.hound', clip: 'Run_Jump', loop: false, note: 'lunge' }] },
      mAlert: { file: 'mon.hound', clip: 'Idle_2', loop: false, note: 'head up / tilt; play with the growl' },
      mEat: { file: 'mon.hound', clip: 'Eating', loop: true },
      mFrozen: { file: 'mon.hound', clip: 'Idle', loop: true, timeScale: 0 },
      extra: { idleCalm: { file: 'mon.hound', clip: 'Idle', loop: true }, death: { file: 'mon.hound', clip: 'Death', loop: false }, hitLeft: { file: 'mon.hound', clip: 'HitReact_Left', loop: false }, hitRight: { file: 'mon.hound', clip: 'HitReact_Right', loop: false } },
    },
    naturalSpeeds: natural,
  };
  const out = join(BUILD, 'anims/clipmap.json');
  mkdirp(dirname(out));
  writeFileSync(out, JSON.stringify(clipmap, null, 2));
  reg('anim.clipmap', out, 'anims/clipmap.json', { group: 'boot' });
  return clipmap;
}

// ---------------------------------------------------------------------------------------------------------------
// hound (Quaternius Zombie Apocalypse Kit, Google Drive direct file)
// ---------------------------------------------------------------------------------------------------------------
async function stepHound() {
  for (const [key, spec] of Object.entries(M.monsters)) {
    const src = join(SRC, spec.file);
    if (await download(spec.url, src, { minBytes: 100000 })) log('downloaded', key);
    credit('quaternius_zak', { title: 'Zombie Apocalypse Kit', author: spec.author, license: spec.license, url: spec.page });
    const out = join(BUILD, spec.out);
    if (!fresh(out)) {
      let input = src;
      if (spec.cleanup) {
        input = join(BUILD, '_tmp', 'hound_clean.glb');
        await cleanHound(src, input, spec.cleanup);
      }
      // keep the flat-colour PNG atlas as is (small, and block compression smears atlas cells); keep all tracks/joints
      await gltfpack(['-i', input, '-o', out, '-cc', '-kn', '-km', '-ac']);
      log('built', key, JSON.stringify(summarizeGlb(out)));
    }
    reg(key, out, spec.out, { group: 'site', credit: 'quaternius_zak' });
  }
}

/**
 * Horror restyle of the ZAK German Shepherd (a companion dog with a saddlebag): split the mesh into welded connected
 * components; drop every non-body component that sits on the back (saddlebag, bedroll, straps, buckles); remap UVs so
 * the eyeballs sample a pale atlas cell (blind, milky eyes) and the bandana samples the fur colour.
 */
async function cleanHound(src, dest, opt) {
  const sharp = (await import('sharp')).default;
  const { json } = readGltf(src);
  const buf = Buffer.from(json.buffers[0].uri.split(',')[1], 'base64');
  const im = json.images[0];
  const ibv = json.bufferViews[im.bufferView];
  const png = buf.subarray(ibv.byteOffset || 0, (ibv.byteOffset || 0) + ibv.byteLength);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const prim = json.meshes[0].primitives[0];
  const acc = (i) => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    return { a, off: (bv.byteOffset || 0) + (a.byteOffset || 0) };
  };
  const pos = acc(prim.attributes.POSITION);
  const uv = acc(prim.attributes.TEXCOORD_0);
  const ind = acc(prim.indices);
  const i16 = ind.a.componentType === 5123;
  const P = (k) => [0, 1, 2].map((c) => buf.readFloatLE(pos.off + k * 12 + c * 4));
  const getI = (k) => (i16 ? buf.readUInt16LE(ind.off + k * 2) : buf.readUInt32LE(ind.off + k * 4));
  const nv = pos.a.count;
  const nt = ind.a.count / 3;
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const uni = (x, y) => {
    x = find(x);
    y = find(y);
    if (x !== y) parent[x] = y;
  };
  const weld = new Map();
  for (let v = 0; v < nv; v++) {
    const q = P(v).map((x) => Math.round(x * 1e4)).join(',');
    if (weld.has(q)) uni(v, weld.get(q));
    else weld.set(q, v);
  }
  for (let t = 0; t < nt; t++) {
    uni(getI(t * 3), getI(t * 3 + 1));
    uni(getI(t * 3), getI(t * 3 + 2));
  }
  const colorAt = (u, v) => {
    const px = Math.min(info.width - 1, Math.max(0, Math.floor(u * info.width)));
    const py = Math.min(info.height - 1, Math.max(0, Math.floor(v * info.height)));
    const o = (py * info.width + px) * 4;
    return [data[o], data[o + 1], data[o + 2]].map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  const UV = (k) => [buf.readFloatLE(uv.off + k * 8), buf.readFloatLE(uv.off + k * 8 + 4)];
  const comps = new Map();
  const triColor = [];
  for (let t = 0; t < nt; t++) {
    const r = find(getI(t * 3));
    if (!comps.has(r)) comps.set(r, { tris: [], min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] });
    const c = comps.get(r);
    c.tris.push(t);
    let su = 0;
    let sv = 0;
    for (let k = 0; k < 3; k++) {
      const vtx = getI(t * 3 + k);
      const q = P(vtx);
      for (let d = 0; d < 3; d++) {
        c.min[d] = Math.min(c.min[d], q[d]);
        c.max[d] = Math.max(c.max[d], q[d]);
      }
      const w = UV(vtx);
      su += w[0] / 3;
      sv += w[1] / 3;
    }
    triColor[t] = colorAt(su, sv);
  }
  const body = [...comps.values()].sort((a, b) => b.tris.length - a.tris.length)[0];
  const drop = new Set();
  for (const c of comps.values()) if (c !== body && c.min[1] >= opt.backMinY && c.max[2] <= opt.backMaxZ) for (const t of c.tris) drop.add(t);
  // a UV that samples a given atlas colour (centre of a matching triangle)
  const uvOf = (hex) => {
    for (let t = 0; t < nt; t++)
      if (triColor[t] === hex) {
        let su = 0;
        let sv = 0;
        for (let k = 0; k < 3; k++) {
          const w = UV(getI(t * 3 + k));
          su += w[0] / 3;
          sv += w[1] / 3;
        }
        return [su, sv];
      }
    return null;
  };
  const setUV = (tris, target) => {
    if (!target) return 0;
    for (const t of tris)
      for (let k = 0; k < 3; k++) {
        const vtx = getI(t * 3 + k);
        buf.writeFloatLE(target[0], uv.off + vtx * 8);
        buf.writeFloatLE(target[1], uv.off + vtx * 8 + 4);
      }
    return tris.length;
  };
  let eyes = 0;
  let recol = 0;
  if (opt.eyes) {
    const target = uvOf(opt.eyes.to);
    for (const c of comps.values()) if (c !== body && c.min[2] >= opt.eyes.minZ && c.tris.every((t) => triColor[t] === opt.eyes.from)) eyes += setUV(c.tris, target);
  }
  const centroidZ = (t) => (P(getI(t * 3))[2] + P(getI(t * 3 + 1))[2] + P(getI(t * 3 + 2))[2]) / 3;
  for (const r of opt.recolor || []) {
    const target = uvOf(r.to);
    recol += setUV(body.tris.filter((t) => triColor[t] === r.from && (r.maxZ == null || centroidZ(t) <= r.maxZ)), target);
  }
  // rewrite the index buffer without the dropped triangles (in place; gltfpack drops the unused vertices)
  let w = 0;
  for (let t = 0; t < nt; t++) {
    if (drop.has(t)) continue;
    for (let k = 0; k < 3; k++) {
      const v = getI(t * 3 + k);
      if (i16) buf.writeUInt16LE(v, ind.off + w * 2);
      else buf.writeUInt32LE(v, ind.off + w * 4);
      w++;
    }
  }
  ind.a.count = w;
  delete ind.a.min;
  delete ind.a.max;
  delete json.buffers[0].uri;
  json.buffers[0].byteLength = buf.length;
  writeGlb(dest, json, buf);
  log(`hound cleanup: removed ${drop.size} back-gear tris, ${eyes} eye tris -> ${opt.eyes?.to}, ${recol} recoloured tris, ${w / 3} tris left`);
}

// ---------------------------------------------------------------------------------------------------------------
// surfaces (Poly Haven CC0 PBR): albedo (sRGB), normal (GL), ORM (=Poly Haven "arm": R=AO, G=rough, B=metal)
// KTX2 via gltfpack's built-in BasisU on a one-triangle wrapper glTF, extracted back out; WebP alt the same way.
// ---------------------------------------------------------------------------------------------------------------
const PH_MAP = { albedo: ['Diffuse', 'diff'], normal: ['nor_gl'], orm: ['arm'] };
const RES_PX = { '512': 512, '1k': 1024, '2k': 2048, '4k': 4096 };
function wrapperGltf(imageUri, slot) {
  const f = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const bin = Buffer.from(f.buffer);
  const material =
    slot === 'albedo'
      ? { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }
      : slot === 'normal'
        ? { normalTexture: { index: 0 } }
        : slot === 'decal'
          ? { alphaMode: 'MASK', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }
          : { pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } }, occlusionTexture: { index: 0 } };
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }],
    materials: [material],
    samplers: [{ wrapS: 10497, wrapT: 10497 }],
    textures: [{ source: 0, sampler: 0 }],
    images: [{ uri: imageUri }],
    buffers: [{ uri: 'data:application/octet-stream;base64,' + bin.toString('base64'), byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
    ],
  };
}
async function encodeTexture(srcImage, slot, outFile, mode) {
  if (fresh(outFile)) return;
  const tmpDir = join(BUILD, '_tmp/tex', basename(outFile) + '.' + Math.random().toString(36).slice(2, 8));
  mkdirp(tmpDir);
  const img = join(tmpDir, 'in' + extname(srcImage));
  copyFileSync(srcImage, img);
  writeFileSync(join(tmpDir, 'w.gltf'), JSON.stringify(wrapperGltf(basename(img), slot)));
  const args = ['-i', join(tmpDir, 'w.gltf'), '-o', join(tmpDir, 'w.glb')];
  if (mode === 'ktx2') args.push('-tc', ...(slot === 'normal' ? ['-tu', 'normal'] : []));
  else args.push('-tw', '-tq', slot === 'normal' ? '9' : '8');
  await gltfpack(args);
  const { json, bin } = readGltf(join(tmpDir, 'w.glb'));
  const im = json.images?.[0];
  if (!im || im.bufferView == null) throw new Error('wrapper: no embedded image for ' + srcImage);
  const bv = json.bufferViews[im.bufferView];
  mkdirp(dirname(outFile));
  writeFileSync(outFile, bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
  rmSync(tmpDir, { recursive: true, force: true });
}

/** ORM = R ambient occlusion (default 255), G roughness, B metalness (default 0), from separate greyscale maps. */
async function packOrm(aoFile, roughFile, metalFile, out) {
  const sharp = (await import('sharp')).default;
  const rough = await sharp(roughFile).removeAlpha().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = rough.info;
  const ch = async (file, fill) =>
    existsSync(file) ? sharp(file).resize(width, height).removeAlpha().extractChannel(0).raw().toBuffer() : Buffer.alloc(width * height, fill);
  const ao = await ch(aoFile, 255);
  const metal = await ch(metalFile, 0);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = ao[i];
    rgb[i * 3 + 1] = rough.data[i];
    rgb[i * 3 + 2] = metal[i];
  }
  mkdirp(dirname(out));
  await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toFile(out);
}

async function stepTextures() {
  credit('polyhaven', { title: 'Poly Haven textures and models', author: 'Poly Haven contributors', license: 'CC0-1.0', url: 'https://polyhaven.com' });
  credit('ambientcg', { title: 'ambientCG materials', author: 'Lennart Demes (ambientCG)', license: 'CC0-1.0', url: 'https://ambientcg.com' });
  const T = M.textures;
  const jobs = [];
  await pool(Object.entries(T.materials), 4, async ([id, spec]) => {
    const maps = ['albedo', 'normal', 'orm'];
    const built = (m) => fresh(join(BUILD, 'tex', id, `${m}.ktx2`)) && fresh(join(BUILD, 'tex', id, `${m}.webp`));
    if (maps.every(built)) {
      // offline-friendly: no API call when everything for this material is already built
      const res = (m) => (spec.acg ? (spec.acgRes || '1K').toLowerCase() : spec[m] || T.defaults[m]);
      for (const map of maps) jobs.push({ id, map, res: res(map), src: null, group: spec.group || 'site', ph: spec.ph || spec.acg, origin: spec.acg ? 'ambientcg' : 'polyhaven' });
      return;
    }
    if (spec.acg) {
      // ambientCG CC0: zip with _Color/_NormalGL/_Roughness/_AmbientOcclusion/_Metalness; ORM packed with sharp
      const res = (spec.acgRes || '1K').toUpperCase();
      const zipName = `${spec.acg}_${res}-JPG.zip`;
      const zip = join(SRC, '_dl', zipName);
      if (!existsSync(zip)) {
        // verify through the ambientCG v2 API first (asset exists, CC0, the zip is offered at this resolution)
        const info = await getJson(`https://ambientcg.com/api/v2/full_json?id=${spec.acg}&include=downloadData`);
        const asset = info.foundAssets?.find((x) => x.assetId === spec.acg);
        const dl = asset?.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads?.find((d) => d.fileName === zipName);
        if (!dl) throw new Error(`ambientCG ${spec.acg}: ${zipName} not offered by the API`);
      }
      await download(`https://ambientcg.com/get?file=${zipName}`, zip, { expectZip: true });
      const dir = join(SRC, 'ambientcg', spec.acg);
      extractZip(zip, dir);
      const f = (suffix) => join(dir, `${spec.acg}_${res}-JPG_${suffix}.jpg`);
      const orm = join(BUILD, '_tmp/acg', `${spec.acg}_orm.png`);
      // acgMetalFrom: take metalness from another map (MetalWalkway's own Metalness map is nearly black: metal = its Opacity)
      if (!existsSync(orm)) await packOrm(f('AmbientOcclusion'), f('Roughness'), f(spec.acgMetalFrom || 'Metalness'), orm);
      const group = spec.group || 'site';
      jobs.push({ id, map: 'albedo', res: res.toLowerCase(), src: f('Color'), group, ph: spec.acg, origin: 'ambientcg' });
      jobs.push({ id, map: 'normal', res: res.toLowerCase(), src: f('NormalGL'), group, ph: spec.acg, origin: 'ambientcg' });
      jobs.push({ id, map: 'orm', res: res.toLowerCase(), src: orm, group, ph: spec.acg, origin: 'ambientcg' });
      return;
    }
    const files = await getJson(`https://api.polyhaven.com/files/${spec.ph}`);
    for (const map of maps) {
      const res = spec[map] || T.defaults[map];
      const mk = PH_MAP[map].find((k) => files[k]);
      const entry = files[mk]?.[res]?.jpg || files[mk]?.[res]?.png;
      if (!entry) {
        warn('texture map missing', id, map, res);
        continue;
      }
      const src = join(SRC, 'polyhaven/textures', spec.ph, basename(new URL(entry.url).pathname));
      await download(entry.url, src);
      jobs.push({ id, map, res, src, group: spec.group || 'site', ph: spec.ph, origin: 'polyhaven' });
    }
  });
  await pool(jobs.filter((j) => j.src), 4, async (j) => {
    const base = join(BUILD, 'tex', j.id);
    const k = join(base, `${j.map}.ktx2`);
    const w = join(base, `${j.map}.webp`);
    await encodeTexture(j.src, j.map, k, 'ktx2');
    await encodeTexture(j.src, j.map, w, 'webp');
  });
  for (const j of jobs.sort((a, b) => (a.id + a.map).localeCompare(b.id + b.map))) {
    const base = join(BUILD, 'tex', j.id);
    reg(`tex.${j.id}.${j.map}`, join(base, `${j.map}.ktx2`), `tex/${j.id}/${j.map}.ktx2`, {
      group: j.group,
      credit: j.origin,
      extra: { colorSpace: j.map === 'albedo' ? 'srgb' : 'linear', res: j.res, source: `${j.origin}:${j.ph}` },
      alt: { webp: { file: join(base, `${j.map}.webp`), out: `tex/${j.id}/${j.map}.webp` } },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// decals (v1.2): one RGBA atlas (opacity packed into albedo alpha) of ambientCG CC0 decals + an index JSON.
// Cells: a 4 x 4 grid, each source fitted (aspect kept) inside its cell minus a gutter; the RGB under transparent texels
// is the cell's mean colour so mips never fringe. mode 'rgba' = Color + Opacity maps; 'mask' = alpha from the darkness
// of one grey map (1 - map) * gain, RGB = a fixed tint (leak streaks, footprint trails authored as materials).
// ---------------------------------------------------------------------------------------------------------------
async function stepDecals() {
  const D = M.decals;
  if (!D?.cells?.length) return;
  const out = join(BUILD, 'decals', 'atlas.png');
  const idxFile = join(BUILD, 'decals', 'index.json');
  const ktx = join(BUILD, 'decals', 'atlas.ktx2'), webp = join(BUILD, 'decals', 'atlas.webp');
  credit('ambientcg', { title: 'ambientCG materials', author: 'Lennart Demes (ambientCG)', license: 'CC0-1.0', url: 'https://ambientcg.com' });
  // the build is keyed by the spec: editing tools/assets.manifest.json decals rebuilds the atlas (no --force needed)
  const spec = sha(Buffer.from(JSON.stringify(D))).slice(0, 12);
  const built = (() => { try { return JSON.parse(readFileSync(idxFile, 'utf8')).spec; } catch { return null; } })();
  if (built !== spec) for (const f of [out, idxFile, ktx, webp]) rmSync(f, { force: true });
  if (!(fresh(out) && fresh(idxFile) && fresh(ktx) && fresh(webp))) {
    const sharp = (await import('sharp')).default;
    const size = D.size || 2048, cell = D.cell || 512, gut = D.gutter || 16, cols = Math.floor(size / cell);
    const inner = cell - 2 * gut;
    const res = D.res || '1K-PNG';
    const rgba = Buffer.alloc(size * size * 4);
    const cells = [];
    for (let i = 0; i < D.cells.length; i++) {
      const c = D.cells[i];
      const zipName = `${c.acg}_${res}.zip`;
      const zip = join(SRC, '_dl', zipName);
      if (!existsSync(zip)) {
        const info = await getJson(`https://ambientcg.com/api/v2/full_json?id=${c.acg}&include=downloadData`);
        const asset = info.foundAssets?.find((x) => x.assetId === c.acg);
        if (!asset?.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads?.some((d) => d.fileName === zipName)) throw new Error(`ambientCG ${c.acg}: ${zipName} not offered by the API`);
      }
      await download(`https://ambientcg.com/get?file=${zipName}`, zip, { expectZip: true });
      const dir = join(SRC, 'ambientcg', `${c.acg}_png`);
      extractZip(zip, dir);
      const map = (suffix) => join(dir, `${c.acg}_${res}_${suffix}.png`);
      const grey = async (file) => sharp(file).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
      let w, h, px; // RGBA source
      if (c.mode === 'mask') {
        const g = await grey(map(c.map || 'Color'));
        w = g.info.width; h = g.info.height; px = Buffer.alloc(w * h * 4);
        const [tr, tg, tb] = c.tint || [50, 44, 34];
        // auto levels: the 99.5th percentile of the darkness maps to alpha 220 (then * gain), so faint streak maps show
        let scale = c.gain || 1;
        if (c.auto) {
          const hist = new Uint32Array(256);
          for (let k = 0; k < w * h; k++) hist[255 - g.data[k * g.info.channels]]++;
          let acc = 0, p = 255;
          for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.995 * w * h) { p = v; break; } }
          scale *= 220 / Math.max(1, p);
        }
        for (let k = 0; k < w * h; k++) {
          px[k * 4] = tr; px[k * 4 + 1] = tg; px[k * 4 + 2] = tb;
          px[k * 4 + 3] = Math.max(0, Math.min(255, Math.round((255 - g.data[k * g.info.channels]) * scale)));
        }
      } else {
        const col = await sharp(map('Color')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        w = col.info.width; h = col.info.height;
        const op = await sharp(map('Opacity')).resize(w, h).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
        px = Buffer.alloc(w * h * 4);
        for (let k = 0; k < w * h; k++) {
          for (let ch = 0; ch < 3; ch++) px[k * 4 + ch] = col.data[k * col.info.channels + ch];
          px[k * 4 + 3] = op.data[k * op.info.channels];
        }
      }
      // fit inside the cell (aspect kept), centred
      const sc = Math.min(inner / w, inner / h);
      const fw = Math.max(1, Math.round(w * sc)), fh = Math.max(1, Math.round(h * sc));
      const fit = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).resize(fw, fh, { kernel: 'lanczos3' }).raw().toBuffer();
      const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell;
      const ox = cx + gut + Math.floor((inner - fw) / 2), oy = cy + gut + Math.floor((inner - fh) / 2);
      // mean colour of the visible texels (alpha-weighted) -> fill the whole cell, then paste
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let k = 0; k < fw * fh; k++) { const a = fit[k * 4 + 3]; sr += fit[k * 4] * a; sg += fit[k * 4 + 1] * a; sb += fit[k * 4 + 2] * a; sa += a; }
      const mr = sa ? Math.round(sr / sa) : 128, mg = sa ? Math.round(sg / sa) : 128, mb = sa ? Math.round(sb / sa) : 128;
      for (let y = cy; y < cy + cell; y++) for (let x = cx; x < cx + cell; x++) { const o = (y * size + x) * 4; rgba[o] = mr; rgba[o + 1] = mg; rgba[o + 2] = mb; rgba[o + 3] = 0; }
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
        const si = (y * fw + x) * 4, o = ((oy + y) * size + ox + x) * 4, a = fit[si + 3];
        if (!a) continue;
        rgba[o] = fit[si]; rgba[o + 1] = fit[si + 1]; rgba[o + 2] = fit[si + 2]; rgba[o + 3] = a;
      }
      const r4 = (v) => Math.round(v * 1e4) / 1e4;
      cells.push({ idx: i, name: c.name, kind: c.kind, surface: c.surface, uv: [r4(ox / size), r4(oy / size), r4((ox + fw) / size), r4((oy + fh) / size)], aspect: r4(fw / fh), size: c.size, source: `ambientcg:${c.acg}` });
    }
    mkdirp(dirname(out));
    await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toFile(out);
    writeAtomic(idxFile, JSON.stringify({ v: 1, note: 'uv = [u0, v0, u1, v1] of the visible content, v from the top image row (no flip); size = suggested world size [w, h] in metres', spec, size, cell, gutter: gut, cells }, null, 1));
    await encodeTexture(out, 'decal', ktx, 'ktx2');
    await encodeTexture(out, 'decal', webp, 'webp');
    log('built decal atlas', cells.length, 'cells');
  }
  reg('decal.atlas', ktx, 'decals/atlas.ktx2', { group: D.group || 'site', credit: 'ambientcg', extra: { colorSpace: 'srgb', res: '2k', source: 'ambientcg:decals' }, alt: { webp: { file: webp, out: 'decals/atlas.webp' } } });
  reg('decal.index', idxFile, 'decals/index.json', { group: D.group || 'site', credit: 'ambientcg' });
}

// ---------------------------------------------------------------------------------------------------------------
// props (Poly Haven CC0 glTF 1K -> gltfpack meshopt + KTX2)
// ---------------------------------------------------------------------------------------------------------------
async function stepProps() {
  credit('polyhaven', { title: 'Poly Haven textures and models', author: 'Poly Haven contributors', license: 'CC0-1.0', url: 'https://polyhaven.com' });
  const P = M.props;
  const itemErrors = [];
  await pool(Object.entries(P.items), 4, async ([key, spec]) => {
    if (spec.item) {
      // v1.2 item models (prop.item_*): their own build, below; one failing item never stops the others
      try {
        await buildItem(key, spec, P);
      } catch (e) {
        itemErrors.push(`${key}: ${e.message}`);
      }
      return;
    }
    const name = key.replace(/^prop\./, '');
    const out = join(BUILD, 'props', `${name}.glb`);
    if (!fresh(out)) {
      const dir = join(SRC, 'polyhaven/models', spec.ph);
      const res = spec.res || P.res;
      const files = await getJson(`https://api.polyhaven.com/files/${spec.ph}`);
      const g = files.gltf?.[res]?.gltf;
      if (!g) return warn('prop has no glTF at', res, spec.ph);
      const gltfPath = join(dir, basename(new URL(g.url).pathname));
      await download(g.url, gltfPath);
      for (const [relPath, inc] of Object.entries(g.include || {})) await download(inc.url, join(dir, relPath));
      // Poly Haven wires the packed ARM only as metallicRoughnessTexture; also use it as occlusion (R channel).
      const json = JSON.parse(readFileSync(gltfPath, 'utf8'));
      for (const m of json.materials || []) {
        const t = m.pbrMetallicRoughness?.metallicRoughnessTexture;
        if (t && !m.occlusionTexture) m.occlusionTexture = { index: t.index, ...(t.texCoord ? { texCoord: t.texCoord } : {}) };
      }
      if (spec.scale) {
        // fix source units: wrap the scene roots in one scaled node
        const sc = json.scenes[json.scene || 0];
        json.nodes.push({ name: spec.ph, scale: [spec.scale, spec.scale, spec.scale], children: sc.nodes });
        sc.nodes = [json.nodes.length - 1];
      }
      const patched = gltfPath.replace(/\.gltf$/, '.deadair.gltf');
      writeFileSync(patched, JSON.stringify(json));
      const args = ['-i', patched, '-o', out, '-cc', '-kn', '-tc'];
      if (spec.uastcNormals) args.push('-tu', 'normal');
      if (spec.maxTex) args.push('-tl', String(spec.maxTex));
      await gltfpack(args);
      const s = summarizeGlb(out);
      log('built', key, (s.bytes / 1e6).toFixed(2) + ' MB', 'meshes', s.meshes, 'clips', s.clips.length);
    }
    reg(key, out, `props/${name}.glb`, { group: spec.group || 'site', credit: 'polyhaven', extra: { source: `polyhaven:${spec.ph}` } });
  });
  if (itemErrors.length) throw new Error(`${itemErrors.length} item model(s) failed (not registered):\n  ${itemErrors.join('\n  ')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// item models (v1.2): small Poly Haven models drawn as world items (salvage, gear, crafting materials). They are
// props.items entries with "item": true, keyed prop.item_<name>, and load like any prop (loadPropModel('item_<name>')).
// Each is ONE mesh with ONE material in the Poly Haven three-texture layout (colour, normal, ARM = metal/rough + AO),
// so every item model draws as a plain mesh with one shared shader program:
//   - no -kn: gltfpack bakes every node transform into a single mesh (no node rotation survives)
//   - glass / lens / film / alpha-blend primitives dropped; per entry, "keep" (material names to keep) and "drop"
//     (more names to drop) regexes pick a sub-part (the tape out of a cassette player). A "keep" match overrides the
//     glass / alpha-blend rule: that material stays and is drawn opaque (circuit_board_alpha is the board itself)
//   - KHR_materials_* (transmission, clearcoat, ior, ...) and emissive stripped; every material double-sided; one
//     vertex layout (POSITION / NORMAL / TEXCOORD_0: extra colour / uv sets, tangents and morph targets dropped)
//   - one image per file and one texture per (image, sampler), so materials that differ only by a duplicate image
//     entry merge into one; textures and images no kept material references are pruned (gltfpack embeds every image)
//   - "pose": { "<node name>": [x, y, z] degrees } replaces a node's rotation (closes an authored-open lid)
//   - a wrapper node for the rest pose ("rest": [x, y, z] degrees, Euler XYZ: how it lies on a surface), "scale" (a
//     deliberate resize of the real object: the expected size scales too) and "units" (a source-units fix, e.g. 0.1 for
//     a mesh authored at 10x: the expected size stays the API's)
//   - "tint" baked into the textures: color ('#rrggbb': luminance kept, the mean texel becomes the colour), metallic
//     (the ARM blue channel), roughness (the roughness factor); a roughness-only "ARM" (one grey channel, Poly Haven
//     _rough maps) becomes AO 1 / rough / metal 0, so its roughness is not read as ambient occlusion
//   - -tl "maxTex" (default 256); -si targets the "tris" cap (default 3000) and -se "se" (default 0.02) bounds the
//     error, so a detailed model can stay above its cap
//   - the patched glTF, copies of its buffers / images and the baked PNGs sit in one short work folder
//     (.assets/build/_tmp/items/<name>, removed after a good build): no '..' paths (gltfpack skips an image it cannot
//     open, e.g. past Windows MAX_PATH, and the texture check below then fails the item)
//   - checks (each run): one material, one primitive, the three-texture layout, no node rotation, textures embedded
//     KTX2 within maxTex, and the built bounds against the Poly Haven API dimensions (mm, x / y / z with z up) after
//     rest pose and scale: no axis may exceed them, and the longest side must reach 0.75x of theirs (0.15x for a
//     keep/drop sub-part), so a model authored at 10x (or 0.1x) fails the step instead of shipping a giant pocket watch
// An item rebuilds when its manifest entry (minus note / group) or ITEM_PIPELINE changes: sidecar .assets/build/items.
// ---------------------------------------------------------------------------------------------------------------
const ITEM_PIPELINE = 5; // bump after changing buildItem / packItem output, so every item model rebuilds
const ITEM_DROP = /_(glass|lens|lense|alpha|flame|film)$/i;
const ITEM_SE = 0.02;

/** glTF quaternion [x, y, z, w] of Euler angles in degrees (three.js order 'XYZ') */
function eulerQuat([x = 0, y = 0, z = 0]) {
  const h = Math.PI / 360;
  const c1 = Math.cos(x * h), c2 = Math.cos(y * h), c3 = Math.cos(z * h);
  const s1 = Math.sin(x * h), s2 = Math.sin(y * h), s3 = Math.sin(z * h);
  const q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
  return q.map((v) => +v.toFixed(9) || 0);
}
/** row-major 3x3 rotation of a unit quaternion */
function quatRows([x, y, z, w]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
/** column-major 4x4 of a glTF node (matrix, or translation / rotation / scale) */
function nodeMatrix(n) {
  if (n.matrix) return n.matrix;
  const r = quatRows(n.rotation || [0, 0, 0, 1]);
  const s = n.scale || [1, 1, 1];
  const t = n.translation || [0, 0, 0];
  return [r[0][0] * s[0], r[1][0] * s[0], r[2][0] * s[0], 0, r[0][1] * s[1], r[1][1] * s[1], r[2][1] * s[1], 0, r[0][2] * s[2], r[1][2] * s[2], r[2][2] * s[2], 0, t[0], t[1], t[2], 1];
}
function mat4Mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
/** scene bounds in metres from the JSON alone: POSITION accessor min/max (dequantised when normalized) through every
 *  node's transform (8 box corners per primitive; exact when no node is rotated, as in a built item) */
function gltfBounds(json) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const NORM = { 5120: (v) => Math.max(v / 127, -1), 5121: (v) => v / 255, 5122: (v) => Math.max(v / 32767, -1), 5123: (v) => v / 65535 };
  const deq = (v, a) => (a.normalized && NORM[a.componentType] ? NORM[a.componentType](v) : v);
  const walk = (ni, parent) => {
    const n = json.nodes[ni];
    const W = mat4Mul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives) {
      const a = json.accessors[p.attributes.POSITION];
      if (!a?.min || !a?.max) throw new Error(`mesh ${n.mesh}: POSITION without min/max`);
      const mn = a.min.map((v) => deq(v, a)), mx = a.max.map((v) => deq(v, a));
      for (let c = 0; c < 8; c++) {
        const v = [c & 1 ? mx[0] : mn[0], c & 2 ? mx[1] : mn[1], c & 4 ? mx[2] : mn[2]];
        for (let k = 0; k < 3; k++) {
          const w = W[k] * v[0] + W[4 + k] * v[1] + W[8 + k] * v[2] + W[12 + k];
          lo[k] = Math.min(lo[k], w);
          hi[k] = Math.max(hi[k], w);
        }
      }
    }
    for (const c of n.children || []) walk(c, W);
  };
  for (const ni of json.scenes[json.scene || 0].nodes) walk(ni, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { min: lo, max: hi, size: lo.map((v, k) => hi[k] - v) };
}
/** triangles drawn by the scene (a mesh counts once per node that uses it: gltfpack bakes instances) */
function sceneTris(json) {
  let t = 0;
  const walk = (ni) => {
    const n = json.nodes[ni];
    if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives) t += json.accessors[p.indices ?? p.attributes.POSITION].count / 3;
    for (const c of n.children || []) walk(c);
  };
  for (const ni of json.scenes[json.scene || 0].nodes) walk(ni);
  return Math.round(t);
}
/** expected built size (m, glTF axes) from the Poly Haven API dimensions (mm, Blender x / y / z, z up), scaled and
 *  turned by the rest pose (bounds of the rotated box) */
function itemExpectedSize(info, spec) {
  const d = info?.dimensions;
  if (!Array.isArray(d) || d.length !== 3 || !d.every((v) => v > 0)) return null;
  const e = [d[0], d[2], d[1]].map((v) => (v / 1000) * (spec.scale || 1));
  if (!spec.rest) return e;
  return quatRows(eulerQuat(spec.rest)).map((row) => Math.abs(row[0]) * e[0] + Math.abs(row[1]) * e[1] + Math.abs(row[2]) * e[2]);
}
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) throw new Error(`tint.color ${hex}: want #rrggbb`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
/** base colour -> the tint colour, keeping the texture's relative luminance (its mean texel becomes the tint) */
async function bakeTintColor(src, dest, hex) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels, n = info.width * info.height;
  const lum = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    lum[i] = ch >= 3 ? 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2] : data[o];
    sum += lum[i];
  }
  const mean = sum / n || 1;
  const tint = hexRgb(hex);
  const rgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round((tint[c] * lum[i]) / mean)));
  mkdirp(dirname(dest));
  await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toFile(dest);
}
/** ARM (R ambient occlusion, G roughness, B metalness): a one-channel roughness map becomes AO 1 / rough / metal 0;
 *  metallic (0..1) overrides the blue channel */
async function bakeArm(src, dest, metallic) {
  const sharp = (await import('sharp')).default;
  // from the file, not the decoded buffer: sharp's raw() hands a one-channel JPEG back as three equal channels
  const roughOnly = (await sharp(src).metadata()).channels < 3;
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels, n = info.width * info.height;
  const metal = metallic == null ? null : Math.max(0, Math.min(255, Math.round(metallic * 255)));
  const rgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    rgb[i * 3] = roughOnly ? 255 : data[o];
    rgb[i * 3 + 1] = data[o + (ch >= 3 ? 1 : 0)];
    rgb[i * 3 + 2] = metal ?? (roughOnly ? 0 : data[o + (ch >= 3 ? 2 : 0)]);
  }
  mkdirp(dirname(dest));
  await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toFile(dest);
}

/** download, patch and pack one item model (see the block comment above); returns build stats */
async function packItem(name, spec, res, dir, infoFile, out) {
  const files = await getJson(`https://api.polyhaven.com/files/${spec.ph}`);
  const g = files.gltf?.[res]?.gltf;
  if (!g) throw new Error(`no glTF at ${res} for ${spec.ph}`);
  const gltfPath = join(dir, basename(new URL(g.url).pathname));
  await download(g.url, gltfPath);
  for (const [relPath, inc] of Object.entries(g.include || {})) await download(inc.url, join(dir, relPath));
  writeAtomic(infoFile, JSON.stringify(await getJson(`https://api.polyhaven.com/info/${spec.ph}`)));
  const json = JSON.parse(readFileSync(gltfPath, 'utf8'));
  const srcTris = sceneTris(json);
  // 1. materials: drop glass / lens / alpha-blend (+ the entry's keep / drop), primitives with them, emptied meshes
  const keep = spec.keep ? new RegExp(spec.keep, 'i') : null;
  const dropRe = spec.drop ? new RegExp(spec.drop, 'i') : null;
  const mats = json.materials || [];
  const dropped = new Set();
  mats.forEach((m, i) => {
    const n = m.name || '';
    const kept = !!keep?.test(n);
    if (dropRe?.test(n) || (keep && !kept) || (!kept && (m.alphaMode === 'BLEND' || ITEM_DROP.test(n)))) dropped.add(i);
  });
  for (const m of json.meshes || []) m.primitives = m.primitives.filter((p) => (p.material === undefined ? !keep : !dropped.has(p.material)));
  const meshMap = new Map();
  const meshes = [];
  (json.meshes || []).forEach((m, i) => {
    if (!m.primitives.length) return;
    meshMap.set(i, meshes.length);
    meshes.push(m);
  });
  for (const n of json.nodes || []) {
    if (n.mesh === undefined) continue;
    if (meshMap.has(n.mesh)) n.mesh = meshMap.get(n.mesh);
    else delete n.mesh;
  }
  json.meshes = meshes;
  const keptTris = sceneTris(json);
  if (!keptTris) throw new Error(`nothing left after dropping [${[...dropped].map((i) => mats[i].name).join(', ')}]`);
  // one vertex layout for every item: POSITION / NORMAL / TEXCOORD_0 (no extra colour / uv sets, no tangents: three
  // would take another normal-map path), no morph targets
  const ITEM_ATTRS = new Set(['POSITION', 'NORMAL', 'TEXCOORD_0']);
  for (const m of meshes) for (const p of m.primitives) {
    for (const a of Object.keys(p.attributes)) if (!ITEM_ATTRS.has(a)) delete p.attributes[a];
    if (!p.attributes.NORMAL || !p.attributes.TEXCOORD_0) throw new Error('a kept primitive has no NORMAL / TEXCOORD_0');
    delete p.targets;
  }
  for (const m of meshes) delete m.weights;
  // 2. kept materials: no KHR_materials_*, no emissive, double-sided, ARM also as occlusion (as stepProps)
  const notes = [];
  mats.forEach((m, i) => {
    if (dropped.has(i)) {
      mats[i] = { name: m.name }; // unreferenced now (gltfpack drops it); no texture references left behind
      return;
    }
    if (m.alphaMode === 'MASK') throw new Error(`kept material ${m.name} is alphaMode MASK (its own shader program): drop it or pick another model`);
    if (m.alphaMode === 'BLEND') {
      delete m.alphaMode; // kept on purpose ("keep" match): drawn opaque
      notes.push(`opaque ${m.name}`);
    }
    if (m.extensions) {
      for (const k of Object.keys(m.extensions)) if (k.startsWith('KHR_materials_')) { delete m.extensions[k]; notes.push(`-${k.slice(14)}`); }
      if (!Object.keys(m.extensions).length) delete m.extensions;
    }
    if (m.emissiveTexture || m.emissiveFactor) notes.push('-emissive');
    delete m.emissiveTexture;
    delete m.emissiveFactor;
    m.doubleSided = true;
    const t = m.pbrMetallicRoughness?.metallicRoughnessTexture;
    if (t && !m.occlusionTexture) m.occlusionTexture = { index: t.index, ...(t.texCoord ? { texCoord: t.texCoord } : {}) };
    for (const r of [m.pbrMetallicRoughness?.baseColorTexture, t, m.normalTexture, m.occlusionTexture]) if (r?.texCoord) throw new Error(`kept material ${m.name} samples TEXCOORD_${r.texCoord} (items keep TEXCOORD_0 only)`);
  });
  for (const k of ['extensionsUsed', 'extensionsRequired']) {
    if (!json[k]) continue;
    json[k] = json[k].filter((e) => !e.startsWith('KHR_materials_'));
    if (!json[k].length) delete json[k];
  }
  // 3. one image per file, one texture per (image, sampler); then prune textures / images no kept material references
  const refs = (m) => [m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture].filter(Boolean);
  const firstImg = new Map();
  const imgCanon = (json.images || []).map((im, i) => {
    if (!im.uri || im.uri.startsWith('data:')) return i;
    if (!firstImg.has(im.uri)) firstImg.set(im.uri, i);
    return firstImg.get(im.uri);
  });
  for (const t of json.textures || []) if (t.source !== undefined) t.source = imgCanon[t.source];
  const firstTex = new Map();
  const texCanon = (json.textures || []).map((t, i) => {
    const k = JSON.stringify([t.source ?? null, t.sampler ?? null, t.extensions ?? null]);
    if (!firstTex.has(k)) firstTex.set(k, i);
    return firstTex.get(k);
  });
  for (const m of mats) for (const r of refs(m)) r.index = texCanon[r.index];
  const usedTex = new Set(mats.flatMap((m) => refs(m).map((r) => r.index)));
  const texMap = new Map(), imgMap = new Map(), textures = [], images = [];
  (json.textures || []).forEach((t, i) => {
    if (!usedTex.has(i)) return;
    texMap.set(i, textures.length);
    const nt = { ...t };
    if (t.source !== undefined) {
      if (!imgMap.has(t.source)) {
        imgMap.set(t.source, images.length);
        images.push({ ...json.images[t.source] });
      }
      nt.source = imgMap.get(t.source);
    }
    textures.push(nt);
  });
  for (const m of mats) for (const r of refs(m)) r.index = texMap.get(r.index);
  const imagesBefore = (json.images || []).length;
  json.textures = textures;
  json.images = images;
  // 4. bake: tint (colour / metallic) and roughness-only ARM maps, as PNGs in the work folder
  const work = join(BUILD, '_tmp', 'items', name);
  rmSync(work, { recursive: true, force: true });
  mkdirp(work);
  const role = new Map(); // image index -> 'color' | 'arm' | 'normal'
  for (const m of mats) {
    const set = (ref, r) => {
      if (!ref) return;
      const img = textures[ref.index]?.source;
      if (img === undefined) return;
      if (role.has(img) && role.get(img) !== r) throw new Error(`image ${images[img].name} is both ${role.get(img)} and ${r}`);
      role.set(img, r);
    };
    set(m.pbrMetallicRoughness?.baseColorTexture, 'color');
    set(m.pbrMetallicRoughness?.metallicRoughnessTexture, 'arm');
    set(m.occlusionTexture, 'arm');
    set(m.normalTexture, 'normal');
  }
  const tint = spec.tint || {};
  const baked = new Set();
  const sharp = (await import('sharp')).default;
  for (const [img, r] of role) {
    const im = images[img];
    if (!im.uri || im.uri.startsWith('data:')) continue;
    const src = join(dir, decodeURIComponent(im.uri));
    const file = `baked_${img}_${(im.name || 'image').replace(/[^A-Za-z0-9_.-]/g, '_')}.png`;
    if (r === 'color' && tint.color) {
      await bakeTintColor(src, join(work, file), tint.color);
      notes.push(`tint ${tint.color}`);
    } else if (r === 'arm' && (tint.metallic != null || (await sharp(src).metadata()).channels < 3)) {
      await bakeArm(src, join(work, file), tint.metallic);
      notes.push(tint.metallic != null ? `metallic ${tint.metallic}` : 'rough-only ARM -> AO 1');
    } else continue;
    Object.assign(im, { uri: file, mimeType: 'image/png' });
    baked.add(im);
  }
  for (const m of mats) {
    if (!m.pbrMetallicRoughness) continue;
    if (tint.metallic != null) m.pbrMetallicRoughness.metallicFactor = 1; // the baked blue channel holds the value
    if (tint.roughness != null) m.pbrMetallicRoughness.roughnessFactor = tint.roughness;
  }
  // 5. node pose overrides, then rest pose + scale on one wrapper node (gltfpack bakes both into the mesh)
  for (const [nodeName, euler] of Object.entries(spec.pose || {})) {
    const n = (json.nodes || []).find((x) => x.name === nodeName);
    if (!n) throw new Error(`pose: no node named ${nodeName}`);
    if (n.matrix) throw new Error(`pose: node ${nodeName} uses a matrix`);
    n.rotation = eulerQuat(euler);
    notes.push(`pose ${nodeName}`);
  }
  const s = (spec.scale || 1) * (spec.units || 1);
  if (spec.rest || s !== 1) {
    const sc = json.scenes[json.scene || 0];
    const wrap = { name: `item_${name}` };
    if (spec.rest) wrap.rotation = eulerQuat(spec.rest);
    if (s !== 1) wrap.scale = [s, s, s];
    json.nodes.push({ ...wrap, children: sc.nodes });
    sc.nodes = [json.nodes.length - 1];
  }
  // 6. buffers and unbaked images are copied next to the patched glTF (short local names, no '..' paths)
  const local = new Map(); // source file -> local name
  const localUri = (uri) => {
    const src = join(dir, decodeURIComponent(uri));
    if (!local.has(src)) {
      const n = `${local.size}_${basename(src).replace(/[^A-Za-z0-9_.-]/g, '_')}`;
      copyFileSync(src, join(work, n));
      local.set(src, n);
    }
    return local.get(src);
  };
  for (const b of json.buffers || []) if (b.uri && !b.uri.startsWith('data:')) b.uri = localUri(b.uri);
  for (const im of images) if (im.uri && !im.uri.startsWith('data:') && !baked.has(im)) im.uri = localUri(im.uri);
  const patched = join(work, `${name}.gltf`);
  writeAtomic(patched, JSON.stringify(json));
  const maxTex = spec.maxTex || 256;
  const ratio = Math.min(1, (spec.tris || 3000) / keptTris);
  const args = ['-i', patched, '-o', out, '-cc', '-tc', '-tl', String(maxTex)];
  if (ratio < 1) args.push('-si', ratio.toFixed(4), '-se', String(spec.se ?? ITEM_SE));
  await gltfpack(args);
  rmSync(work, { recursive: true, force: true }); // kept only when packing failed (for a look at the patched glTF)
  return {
    srcTris,
    keptTris,
    ratio: +ratio.toFixed(4),
    dropped: [...dropped].map((i) => mats[i].name),
    imagesPruned: imagesBefore - images.length,
    notes: [...new Set(notes)],
  };
}

/** checks of a built item GLB (see the block comment above); returns stats + the list of problems */
function checkItem(file, spec, info) {
  const { json, bin } = readGltf(file);
  const errs = [];
  const mats = json.materials || [];
  const prims = (json.meshes || []).flatMap((m) => m.primitives);
  if (mats.length !== 1) errs.push(`${mats.length} materials (want 1): ${mats.map((m) => m.name).join(', ')}`);
  if (prims.length !== 1) errs.push(`${prims.length} primitives (want 1)`);
  for (const p of prims) if (Object.keys(p.attributes).sort().join() !== 'NORMAL,POSITION,TEXCOORD_0' || p.targets || (p.mode ?? 4) !== 4) errs.push(`primitive is not indexed triangles with POSITION / NORMAL / TEXCOORD_0 only (${Object.keys(p.attributes).join(', ')})`);
  for (const n of json.nodes || []) if (n.matrix || (n.rotation && Math.abs(n.rotation[3]) < 0.999999)) errs.push(`node ${n.name ?? '(unnamed)'} keeps a rotation`);
  const m = mats[0] || {};
  const pbr = m.pbrMetallicRoughness || {};
  if (!pbr.baseColorTexture || !m.normalTexture || !pbr.metallicRoughnessTexture || m.occlusionTexture?.index !== pbr.metallicRoughnessTexture.index) errs.push('material is not the colour / normal / ARM (metal-rough = occlusion) layout');
  if (!m.doubleSided) errs.push('material is single-sided');
  if ((m.alphaMode && m.alphaMode !== 'OPAQUE') || m.emissiveTexture || m.emissiveFactor || m.extensions) errs.push(`material keeps ${JSON.stringify({ alphaMode: m.alphaMode, emissive: !!(m.emissiveTexture || m.emissiveFactor), extensions: Object.keys(m.extensions || {}) })}`);
  const maxTex = spec.maxTex || 256;
  const images = (json.images || []).map((im) => {
    const bv = json.bufferViews[im.bufferView];
    const k = bv && bin ? bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength) : null;
    if (im.mimeType !== 'image/ktx2' || !k || k.readUInt32BE(0) !== 0xab4b5458) {
      errs.push(`image ${im.name} is not an embedded KTX2`);
      return { name: im.name };
    }
    const r = { name: im.name, w: k.readUInt32LE(20), h: k.readUInt32LE(24), levels: k.readUInt32LE(40), kb: +(k.length / 1024).toFixed(1) };
    if (Math.max(r.w, r.h) > maxTex) errs.push(`image ${im.name} is ${r.w}x${r.h} (maxTex ${maxTex})`);
    return r;
  });
  if (images.length > 3) errs.push(`${images.length} images (want 3)`);
  const b = gltfBounds(json);
  const exp = itemExpectedSize(info, spec);
  if (!exp) warn(`item ${spec.ph}: no API dimensions, bounds not checked`);
  else {
    const r3 = (v) => v.toFixed(3);
    for (let k = 0; k < 3; k++) if (b.size[k] > exp[k] * 1.25 + 0.005) errs.push(`${'xyz'[k]} ${r3(b.size[k])} m exceeds the API ${r3(exp[k])} m (${(b.size[k] / exp[k]).toFixed(2)}x: wrong units or rest pose?)`);
    const ratio = Math.max(...b.size) / Math.max(...exp);
    if (ratio < (spec.keep || spec.drop ? 0.15 : 0.75)) errs.push(`longest side ${r3(Math.max(...b.size))} m is ${ratio.toFixed(2)}x the API ${r3(Math.max(...exp))} m (wrong units?)`);
  }
  const tris = Math.round(prims.reduce((a, p) => a + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0));
  return { errs, tris, bytes: statSync(file).size, size: b.size.map((v) => +v.toFixed(4)), api: exp?.map((v) => +v.toFixed(4)) ?? null, materials: mats.map((x) => x.name), images };
}

async function buildItem(key, spec, P) {
  if (!/^prop\.item_[a-z0-9_]+$/.test(key)) throw new Error('item keys are prop.item_<a-z0-9_>');
  if (!spec.ph) throw new Error('no Poly Haven id (ph)');
  const name = key.replace(/^prop\./, '');
  const out = join(BUILD, 'props', `${name}.glb`);
  const side = join(BUILD, 'items', `${name}.json`);
  const dir = join(SRC, 'polyhaven/models', spec.ph);
  const infoFile = join(dir, 'polyhaven-info.json');
  const res = spec.res || P.res;
  const { note: _note, group: _group, ...buildSpec } = spec;
  const specHash = sha(Buffer.from(JSON.stringify({ pipeline: ITEM_PIPELINE, res, ...buildSpec }))).slice(0, 12);
  const prev = (() => {
    try {
      return JSON.parse(readFileSync(side, 'utf8'));
    } catch {
      return null;
    }
  })();
  let built = null;
  if (!fresh(out) || prev?.spec !== specHash || !existsSync(infoFile)) {
    rmSync(out, { force: true });
    rmSync(side, { force: true });
    try {
      built = await packItem(name, spec, res, dir, infoFile, out);
    } catch (e) {
      rmSync(out, { force: true });
      throw e;
    }
  }
  const c = checkItem(out, spec, JSON.parse(readFileSync(infoFile, 'utf8')));
  if (c.errs.length) {
    rmSync(out, { force: true });
    rmSync(side, { force: true });
    throw new Error(c.errs.join('; '));
  }
  if (built) {
    const { errs: _errs, ...stats } = c;
    writeAtomic(side, JSON.stringify({ spec: specHash, key, ph: spec.ph, ...built, ...stats }, null, 1));
    const tex = c.images.map((i) => `${i.w}`).join('/');
    log('built item', key, `${(c.bytes / 1024).toFixed(0)} KB`, `tris ${built.srcTris} -> ${built.keptTris} -> ${c.tris}`, `tex ${tex}`, `size ${c.size.map((v) => v.toFixed(3)).join(' x ')} m`, `(api ${c.api?.map((v) => v.toFixed(3)).join(' x ') ?? '?'})`, built.dropped.length ? `dropped [${built.dropped.join(', ')}]` : '', built.notes.join(', '));
  }
  reg(key, out, `props/${name}.glb`, { group: spec.group || 'site', credit: 'polyhaven', extra: { source: `polyhaven:${spec.ph}` } });
}

// ---------------------------------------------------------------------------------------------------------------
// audio: curated CC0 / CC-BY packs (selection in .assets/src/audio/selection.json, mirrored in assets.manifest.json)
// ---------------------------------------------------------------------------------------------------------------
async function stepAudio() {
  // The committed manifest is the source of truth; .assets/src/audio/selection.json is only a curation fallback.
  let sel = M.audio?.sounds ? { sources: M.audio.sources, sounds: M.audio.sounds } : null;
  const selFile = join(SRC, 'audio/selection.json');
  if (!sel && existsSync(selFile)) sel = JSON.parse(readFileSync(selFile, 'utf8'));
  if (!sel) return warn('audio: no selection yet');
  for (const [id, s] of Object.entries(sel.sources)) {
    const zip = join(SRC, '_dl', s.zip);
    if (!existsSync(join(SRC, 'audio', id)) || !readdirSync(join(SRC, 'audio', id)).length) {
      await download(s.url, zip, { expectZip: true });
      extractZip(zip, join(SRC, 'audio', id));
    }
    credit(id, { title: s.title, author: s.author, license: s.license, url: s.page, ...(s.license.startsWith('CC-BY') ? { attribution: s.attribution || `${s.title} by ${s.author} (${s.license}), ${s.page}` } : {}) });
  }
  for (const snd of sel.sounds) {
    const file = join(SRC, 'audio', snd.source, snd.file);
    const ext = extname(file).toLowerCase();
    reg(snd.key, file, `sfx/${snd.key.replace(/^sfx\./, '')}${ext}`, { group: snd.group || (snd.key.startsWith('sfx.ui_') ? 'boot' : 'site'), credit: snd.source, extra: snd.durationSec ? { durationSec: snd.durationSec } : undefined });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// fonts (v1.2): SIL OFL handwriting font for lore pages + its licence text (shipped next to the font, as the OFL asks)
// ---------------------------------------------------------------------------------------------------------------
async function stepFonts() {
  for (const [key, f] of Object.entries(M.fonts?.items || {})) {
    const dir = join(SRC, 'fonts', f.id);
    const ttf = join(dir, basename(new URL(f.ttf).pathname));
    const lic = join(dir, basename(new URL(f.license).pathname));
    await download(f.ttf, ttf, { minBytes: 10000 });
    await download(f.license, lic, { minBytes: 1000 });
    if (readFileSync(ttf).readUInt32BE(0) !== 0x00010000) throw new Error(`${key}: not a TrueType font`);
    if (!/SIL OPEN FONT LICENSE/i.test(readFileSync(lic, 'utf8'))) throw new Error(`${key}: licence is not the SIL OFL`);
    credit(f.id, { title: f.title, author: f.author, license: 'OFL-1.1', url: f.page, note: `SIL Open Font License 1.1; the licence text ships as ${key}.license` });
    reg(key, ttf, `fonts/${f.id}.ttf`, { group: f.group || 'site', credit: f.id });
    reg(`${key}.license`, lic, `fonts/${f.id}.OFL.txt`, { group: f.group || 'site', credit: f.id });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ElevenLabs build-time SFX (prompts in tools/sfx-manifest.json; audio cached in .assets/src/elevenlabs)
// ---------------------------------------------------------------------------------------------------------------
async function stepElevenLabs() {
  const dir = join(SRC, 'elevenlabs');
  if (flag('generate')) {
    // costs credits: only with --generate (and --tts for the PA voice lines); skips files that already exist
    const s = await generateElevenLabs({ root: ROOT, log, dryRun: flag('dry-run'), tts: flag('tts') });
    if (s.stopped || s.failed.length) warn('elevenlabs:', s.stopped || s.failed.map((x) => x.key).join(','));
  }
  const idxFile = join(dir, 'index.json');
  if (!existsSync(idxFile)) return warn('elevenlabs: no generated audio yet');
  const idx = JSON.parse(readFileSync(idxFile, 'utf8'));
  credit('elevenlabs', { title: 'Generated sound effects / voice (ElevenLabs, build time)', author: 'ElevenLabs (generated for DEAD AIR)', license: 'ElevenLabs Terms of Service (generated output)', url: 'https://elevenlabs.io' });
  const post = M.elevenlabs || {};
  for (const [key, e] of Object.entries(idx)) {
    let file = join(dir, e.file);
    if (!existsSync(file)) continue;
    const ext = extname(file).toLowerCase();
    if (ext === '.wav' && (post.mono?.includes(key) || post.gainDb?.[key])) {
      // positional loops: downmix to mono (PannerNode input is mono anyway) and trim gain where the take clips
      const out = join(BUILD, 'el', `${key}.wav`);
      if (!fresh(out)) processWav(file, out, { mono: post.mono?.includes(key), gainDb: post.gainDb?.[key] || 0 });
      file = out;
    }
    const out = key.startsWith('vo.') ? `vo/${key.slice(3)}${ext}` : `sfx/${key.replace(/^sfx\./, '')}${ext}`;
    reg(key, file, out, { group: key.startsWith('vo.') ? 'lobby' : 'site', credit: 'elevenlabs', extra: { loop: !!e.loop, durationSec: e.duration_seconds } });
  }
}

/** 16-bit PCM WAV: optional stereo->mono downmix and gain (dB), clamped. */
function processWav(src, dest, { mono, gainDb }) {
  const b = readFileSync(src);
  let o = 12;
  let ch = 0;
  let sr = 0;
  let bits = 0;
  let data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('latin1', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      ch = b.readUInt16LE(o + 10);
      sr = b.readUInt32LE(o + 12);
      bits = b.readUInt16LE(o + 22);
    }
    if (id === 'data') {
      data = b.subarray(o + 8, o + 8 + Math.min(size, b.length - o - 8));
      break;
    }
    o += 8 + size + (size & 1);
  }
  if (bits !== 16 || !data) throw new Error('processWav: 16-bit PCM only: ' + src);
  const g = Math.pow(10, (gainDb || 0) / 20);
  const outCh = mono ? 1 : ch;
  const frames = Math.floor(data.length / (2 * ch));
  const pcm = Buffer.alloc(frames * outCh * 2);
  for (let f = 0; f < frames; f++) {
    if (mono) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += data.readInt16LE((f * ch + c) * 2);
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((s / ch) * g))), f * 2);
    } else for (let c = 0; c < ch; c++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data.readInt16LE((f * ch + c) * 2) * g))), (f * ch + c) * 2);
  }
  mkdirp(dirname(dest));
  writeFileSync(dest, elWav(pcm, sr, outCh));
}

// --- ElevenLabs generator (merged from the helper agent; budget-guarded, idempotent, never logs the key) ---
const EL_API = 'https://api.elevenlabs.io';
const EL_EXTS = ['mp3', 'wav', 'ogg', 'webm'];
const EL_STOP_STATUS = new Set([401, 402, 429]); // auth, payment, quota or rate limit: stop everything
const EL_PRO_TIERS = new Set(['pro', 'scale', 'business', 'growing_business', 'enterprise']);

class ElStop extends Error {}
const elSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateElevenLabs({ root, log = console.log, dryRun = false, maxCreditsFraction, tts = false, only, limit } = {}) {
  root = resolve(root ?? '.');
  const key = process.env.ELEVENLABS_API_KEY || '';
  const redact = (s) => (key ? String(s).split(key).join('<redacted>') : String(s));
  const say = (m) => log(`[elevenlabs] ${redact(m)}`);

  const manifest = JSON.parse(readFileSync(join(root, 'tools', 'sfx-manifest.json'), 'utf8'));
  const outDir = join(root, '.assets', 'src', 'elevenlabs');
  const indexPath = join(outDir, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  const writeAtomic = (file, data) => { writeFileSync(`${file}.part`, data); renameSync(`${file}.part`, file); };
  const saveIndex = () => writeAtomic(indexPath, `${JSON.stringify(Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
  const existing = (k) => {
    for (const ext of EL_EXTS) {
      const f = join(outDir, `${k}.${ext}`);
      if (existsSync(f) && statSync(f).size > 0) return f;
    }
    return null;
  };

  // ---- manifest guards (every clip needs an explicit duration so the cost is predictable)
  const defaults = manifest.defaults ?? {};
  const cfg = manifest.budget ?? {};
  const clips = manifest.clips ?? [];
  const maxClips = cfg.maxClips ?? 31, maxOne = cfg.maxSecondsPerClip ?? 4, maxLoop = cfg.maxSecondsPerLoop ?? 8;
  if (clips.length > maxClips) throw new Error(`manifest has ${clips.length} clips, more than maxClips ${maxClips}`);
  const seen = new Set();
  for (const c of clips) {
    if (seen.has(c.key)) throw new Error(`duplicate clip key ${c.key}`);
    seen.add(c.key);
    const cap = c.loop ? maxLoop : maxOne;
    if (!(c.duration_seconds >= 0.5 && c.duration_seconds <= cap)) throw new Error(`${c.key}: duration_seconds must be 0.5..${cap}`);
  }
  const ttsCfg = manifest.tts ?? null;
  const clamp01 = (x) => Math.min(1, Math.max(0, Number(x)));
  const fraction = clamp01(maxCreditsFraction ?? cfg.maxCreditsFraction ?? 0.25);
  const ttsFraction = clamp01(ttsCfg?.maxCreditsFraction ?? 0.1);
  const cps = Number(cfg.estimatedCreditsPerSecond ?? 40);
  const estClip = (c) => Math.ceil(c.duration_seconds * cps);
  const estLine = (l) => Math.ceil(l.text.length * Number(ttsCfg?.credits_per_character ?? 1));

  // ---- plan: only files that do not exist yet
  const onlySet = only ? new Set((Array.isArray(only) ? only : String(only).split(',')).map((s) => s.trim()).filter(Boolean)) : null;
  const wanted = (k) => !onlySet || onlySet.has(k);
  const present = clips.filter((c) => existing(c.key)).length;
  let todo = clips.filter((c) => wanted(c.key) && !existing(c.key));
  if (limit != null) todo = todo.slice(0, Math.max(0, Number(limit)));
  let ttsTodo = tts && ttsCfg ? (ttsCfg.lines ?? []).filter((l) => wanted(l.key) && !existing(l.key)) : [];
  const sfxEstimate = todo.reduce((s, c) => s + estClip(c), 0);
  const ttsEstimate = ttsTodo.reduce((s, l) => s + estLine(l), 0);
  say(`plan: ${todo.length} SFX to generate (${present}/${clips.length} present), est ${sfxEstimate} credits; TTS ${tts ? `${ttsTodo.length} lines, est ${ttsEstimate} credits` : 'off (pass --tts)'}${dryRun ? ' [dry run]' : ''}`);
  for (const c of todo) say(`  todo ${c.key} ${c.duration_seconds}s${c.loop ? ' loop' : ''} ~${estClip(c)} cr`);
  for (const l of ttsTodo) say(`  todo ${l.key} ${l.text.length} chars ~${estLine(l)} cr`);

  const summary = {
    dryRun, tier: null, before: null, after: null, budget: { sfx: null, tts: null },
    estimate: { sfx: sfxEstimate, tts: ttsEstimate }, spent: { sfx: 0, tts: 0 }, creditsPerSecond: null,
    generated: [], failed: [], stopped: null, verify: null,
  };

  // ---- API helpers (the key only ever goes into the xi-api-key header)
  const getSub = async () => {
    const r = await fetch(`${EL_API}/v1/user/subscription`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(30_000) });
    if (EL_STOP_STATUS.has(r.status)) throw new ElStop(`subscription check: HTTP ${r.status}`);
    if (!r.ok) throw new Error(`subscription check: HTTP ${r.status}`);
    const j = await r.json();
    return { tier: String(j.tier ?? ''), used: Number(j.character_count), limit: Number(j.character_limit), reset: j.next_character_count_reset_unix ?? null };
  };
  // subscription.character_count can lag by minutes for sound effects; the usage stats endpoint
  // is near-real-time, so spend is measured as the change in its totals (all products summed).
  const usageStart = Date.now() - 2 * 86_400_000;
  const getUsage = async () => {
    const total = async (metric) => {
      const q = new URLSearchParams({ start_unix: String(usageStart), end_unix: String(Date.now() + 60_000), aggregation_interval: 'day', metric });
      const r = await fetch(`${EL_API}/v1/usage/character-stats?${q}`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`usage stats: HTTP ${r.status}`);
      const j = await r.json();
      return Object.values(j.usage ?? {}).flat().reduce((s, v) => s + Number(v || 0), 0);
    };
    try { return { credits: await total('credits'), requests: await total('request_count') }; } catch { return null; }
  };
  // Waits (bounded) until the usage stats include `requests` new requests, then returns the totals.
  const settleUsage = async (base, requests) => {
    let u = null;
    for (let i = 0; i < 6; i++) {
      await elSleep(i ? 5000 : 1500);
      u = await getUsage();
      if (!u || !base || u.requests - base.requests >= requests) break;
    }
    return u;
  };
  const post = async (path, query, body) => {
    const url = `${EL_API}${path}?${new URLSearchParams(query)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
        if (r.status >= 500 && attempt === 0) { await r.body?.cancel(); say(`  HTTP ${r.status}, retrying once`); await elSleep(2000); continue; }
        return r;
      } catch (e) {
        if (attempt === 0) { say(`  network error (${e?.message ?? e}), retrying once`); await elSleep(2000); continue; }
        throw e;
      }
    }
  };
  const rejected = new Set(); // output formats this account refused during this run
  const formatsFor = (c, tier) => {
    const base = defaults.output_format ?? 'mp3_44100_128';
    const list = c.output_format ? [c.output_format] : c.loop ? (defaults.loop_output_formats ?? [base]) : [base];
    return list.filter((f) => elTierAllows(f, tier) && !rejected.has(f));
  };
  // Tries the formats in order; falls back only when the account refuses a format (403, or a
  // 400/422 that names the format/tier). Refused requests cost nothing.
  const requestAudio = async (label, path, body, formats) => {
    if (!formats.length) throw new Error('no allowed output format for this tier');
    for (let i = 0; i < formats.length; i++) {
      const fmt = formats[i];
      const r = await post(path, { output_format: fmt }, body);
      if (r.ok) return { fmt, buf: Buffer.from(await r.arrayBuffer()) };
      const detail = redact(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      if (EL_STOP_STATUS.has(r.status)) throw new ElStop(`HTTP ${r.status} on ${label}: ${detail}`);
      const formatRefused = r.status === 403 || ((r.status === 400 || r.status === 422) && /format|tier|subscri|upgrade/i.test(detail));
      if (formatRefused && i < formats.length - 1) {
        rejected.add(fmt);
        say(`  ${fmt} refused (HTTP ${r.status}: ${detail.slice(0, 120)}); falling back to ${formats[i + 1]}`);
        continue;
      }
      throw new Error(`HTTP ${r.status}: ${detail}`);
    }
    throw new Error('unreachable');
  };
  const store = (k, fmt, buf, durationHint) => {
    const { ext, data } = elEncode(fmt, buf, durationHint);
    const file = `${k}.${ext}`;
    writeAtomic(join(outDir, file), data);
    return { file, bytes: data.length, format: fmt, ...elProbe(ext, data) };
  };

  // ---- subscription + budget (checked before anything is generated)
  let sub0 = null, usage0 = null;
  if (!key) {
    if (!dryRun && (todo.length || ttsTodo.length)) throw new Error('ELEVENLABS_API_KEY is not set (run with node --env-file=.env)');
    say('ELEVENLABS_API_KEY not set: budget not checked');
  } else {
    sub0 = await getSub();
    usage0 = await getUsage();
    const remaining = sub0.limit - sub0.used;
    summary.tier = sub0.tier;
    summary.before = { used: sub0.used, limit: sub0.limit, remaining };
    summary.budget = { sfx: Math.floor(fraction * remaining), tts: Math.floor(ttsFraction * remaining) };
    say(`subscription: tier=${sub0.tier} used=${sub0.used}/${sub0.limit} remaining=${remaining}; budget SFX ${summary.budget.sfx} (${fraction * 100}%), TTS ${summary.budget.tts} (${ttsFraction * 100}%)`);
    if (sfxEstimate > summary.budget.sfx) {
      summary.stopped = `SFX estimate ${sfxEstimate} exceeds budget ${summary.budget.sfx}`;
      if (!dryRun) throw new Error(`${summary.stopped}; aborting before any request`);
      say(`WOULD ABORT: ${summary.stopped}`);
    }
    if (ttsEstimate > summary.budget.tts) { say(`TTS estimate ${ttsEstimate} exceeds budget ${summary.budget.tts}: skipping TTS`); ttsTodo = []; }
  }

  if (!dryRun && (todo.length || ttsTodo.length)) {
    mkdirSync(outDir, { recursive: true });
    // ---- sound effects, sequentially
    let usedReal = 0, estSoFar = 0, seconds = 0, fails = 0, made = 0;
    for (const c of todo) {
      if (Math.max(usedReal, estSoFar) + estClip(c) > summary.budget.sfx) { summary.stopped = `SFX budget reached before ${c.key}`; say(summary.stopped); break; }
      const t0 = Date.now();
      try {
        const body = {
          text: c.text,
          model_id: manifest.model_id ?? 'eleven_text_to_sound_v2',
          duration_seconds: c.duration_seconds,
          prompt_influence: c.prompt_influence ?? defaults.prompt_influence ?? 0.3,
          loop: Boolean(c.loop),
        };
        const { fmt, buf } = await requestAudio(c.key, '/v1/sound-generation', body, formatsFor(c, sub0.tier));
        const saved = store(c.key, fmt, buf, c.duration_seconds);
        index[c.key] = { ...saved, duration_seconds: c.duration_seconds, loop: Boolean(c.loop), text: c.text, prompt_influence: body.prompt_influence, generatedAt: new Date().toISOString() };
        saveIndex();
        estSoFar += estClip(c); seconds += c.duration_seconds; fails = 0; made++;
        summary.generated.push({ key: c.key, file: saved.file, format: fmt, bytes: saved.bytes });
        say(`  ok ${saved.file} ${fmt} ${saved.bytes} B${saved.measured_seconds != null ? ` ${saved.measured_seconds}s` : ''}${saved.channels ? ` ch=${saved.channels}` : ''} (${Date.now() - t0} ms)`);
      } catch (e) {
        if (e instanceof ElStop) { summary.stopped = e.message; say(`STOP: ${e.message}`); break; }
        summary.failed.push({ key: c.key, error: redact(e?.message ?? e) });
        say(`  FAILED ${c.key}: ${e?.message ?? e}`);
        if (++fails >= 3) { summary.stopped = '3 consecutive failures'; say(`STOP: ${summary.stopped}`); break; }
      }
      const u = usage0 ? await getUsage() : null;
      if (u) usedReal = u.credits - usage0.credits;
    }
    if (made) {
      const u = await settleUsage(usage0, made);
      summary.spent.sfx = u && usage0 ? +(u.credits - usage0.credits).toFixed(2) : estSoFar; // estimate if stats are unavailable
      if (seconds > 0) summary.creditsPerSecond = +(summary.spent.sfx / seconds).toFixed(2);
    }

    // ---- optional Company PA lines
    if (ttsTodo.length && !summary.stopped) {
      const base = await getUsage();
      let tEst = 0, tMade = 0;
      for (const l of ttsTodo) {
        if (tEst + estLine(l) > summary.budget.tts) { summary.stopped = `TTS budget reached before ${l.key}`; say(summary.stopped); break; }
        const t0 = Date.now();
        try {
          const body = { text: l.text, model_id: ttsCfg.model_id, ...(ttsCfg.voice_settings ? { voice_settings: ttsCfg.voice_settings } : {}) };
          const { fmt, buf } = await requestAudio(l.key, `/v1/text-to-speech/${encodeURIComponent(ttsCfg.voice_id)}`, body, [ttsCfg.output_format ?? 'mp3_44100_128']);
          const saved = store(l.key, fmt, buf, null);
          index[l.key] = { ...saved, duration_seconds: saved.measured_seconds ?? null, loop: false, text: l.text, kind: 'tts', model_id: ttsCfg.model_id, voice_id: ttsCfg.voice_id, voice_name: ttsCfg.voice_name ?? null, generatedAt: new Date().toISOString() };
          saveIndex();
          tEst += estLine(l); tMade++;
          summary.generated.push({ key: l.key, file: saved.file, format: fmt, bytes: saved.bytes });
          say(`  ok ${saved.file} ${fmt} ${saved.bytes} B${saved.measured_seconds != null ? ` ${saved.measured_seconds}s` : ''} (${Date.now() - t0} ms)`);
        } catch (e) {
          if (e instanceof ElStop) { summary.stopped = e.message; say(`STOP: ${e.message}`); break; }
          summary.failed.push({ key: l.key, error: redact(e?.message ?? e) });
          say(`  FAILED ${l.key}: ${e?.message ?? e}`);
        }
      }
      if (tMade) {
        const u = await settleUsage(base, tMade);
        summary.spent.tts = u && base ? +(u.credits - base.credits).toFixed(2) : tEst;
      }
    }
  }

  // ---- final credit check
  if (key && sub0) {
    const s = await getSub().catch(() => null);
    if (s) summary.after = { used: s.used, limit: s.limit, remaining: s.limit - s.used };
    const cpsNote = summary.creditsPerSecond != null ? `; ${summary.creditsPerSecond} credits per clip-second` : '';
    say(`credits: subscription counter ${sub0.used} -> ${s ? s.used : '?'} of ${sub0.limit} (can lag); spent this run SFX ${summary.spent.sfx}, TTS ${summary.spent.tts}${cpsNote}`);
  }

  // ---- verify every expected output (non-empty, header matches the extension)
  const verify = { ok: [], missing: [], invalid: [] };
  let dirty = false;
  for (const item of [...clips, ...(ttsCfg?.lines ?? [])]) {
    const f = existing(item.key);
    if (!f) { verify.missing.push(item.key); continue; }
    const buf = readFileSync(f);
    const ext = f.slice(f.lastIndexOf('.') + 1);
    if (elSniff(buf) !== ext) { verify.invalid.push(item.key); continue; }
    verify.ok.push(item.key);
    if (!index[item.key] && !dryRun) { // file present but not indexed (e.g. index.json was deleted)
      index[item.key] = { file: basename(f), bytes: buf.length, format: ext, ...elProbe(ext, buf), duration_seconds: item.duration_seconds ?? null, loop: Boolean(item.loop), text: item.text, generatedAt: null };
      dirty = true;
    }
  }
  if (dirty) saveIndex();
  summary.verify = verify;
  say(`verify: ${verify.ok.length} ok, ${verify.missing.length} missing${verify.missing.length ? ` (${verify.missing.join(', ')})` : ''}, ${verify.invalid.length} invalid${verify.invalid.length ? ` (${verify.invalid.join(', ')})` : ''}`);
  if (summary.failed.length) say(`failed: ${summary.failed.map((f) => f.key).join(', ')}`);
  return summary;
}

// pcm/wav at 44.1 kHz need Pro or above; mp3 192 kbps needs Creator or above (API reference notes).
function elTierAllows(fmt, tier) {
  if (/^(pcm|wav)_44100$/.test(fmt)) return EL_PRO_TIERS.has(tier);
  if (fmt === 'mp3_44100_192') return !['free', 'starter'].includes(tier);
  return true;
}

function elSniff(b) {
  if (!b || b.length < 12) return null;
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  const magic = b.toString('latin1', 0, 4);
  if (magic === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (magic === 'OggS') return 'ogg';
  if (b.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  return null;
}

// Raw pcm_* responses are 16-bit little-endian samples; they get a RIFF header (channel count
// inferred from the byte count against the requested duration). Everything else is sniffed.
function elEncode(fmt, buf, durationHint) {
  if (fmt.startsWith('pcm_')) {
    if (buf.length < 1000 || (buf.length < 4000 && buf.toString('latin1', 0, 2) === '{"')) throw new Error('PCM response is too short or not audio');
    const rate = Number(fmt.split('_')[1]);
    const channels = durationHint && buf.length / (rate * 2 * durationHint) > 1.5 ? 2 : 1;
    return { ext: 'wav', data: elWav(buf, rate, channels) };
  }
  const ext = elSniff(buf);
  if (!ext) throw new Error(`response is not audio (starts with ${buf.subarray(0, 8).toString('hex')})`);
  return { ext, data: buf };
}

function elWav(pcm, sampleRate, channels) {
  const len = pcm.length - (pcm.length % (2 * channels));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + len, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(len, 40);
  return Buffer.concat([h, pcm.subarray(0, len)]);
}

// Best-effort { sample_rate, channels, measured_seconds } for wav / mp3 / ogg-opus.
function elProbe(ext, b) {
  try {
    if (ext === 'wav') {
      let o = 12, ch = 0, sr = 0, bits = 16, len = 0;
      while (o + 8 <= b.length) {
        const id = b.toString('latin1', o, o + 4), size = b.readUInt32LE(o + 4);
        if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); sr = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22); }
        if (id === 'data') { len = Math.min(size, b.length - o - 8); break; }
        o += 8 + size + (size & 1);
      }
      return sr && ch ? { sample_rate: sr, channels: ch, measured_seconds: +(len / (sr * ch * (bits / 8))).toFixed(3) } : {};
    }
    if (ext === 'ogg') {
      const h = b.indexOf('OpusHead');
      const p = b.lastIndexOf('OggS');
      if (h < 0 || p < 0) return {};
      const granule = Number(b.readBigUInt64LE(p + 6));
      return { sample_rate: 48000, channels: b[h + 9], measured_seconds: +((granule - b.readUInt16LE(h + 10)) / 48000).toFixed(3) };
    }
    if (ext === 'mp3') return elProbeMp3(b);
  } catch { /* probe is informational only */ }
  return {};
}

function elProbeMp3(b) {
  let i = b.toString('latin1', 0, 3) === 'ID3' ? 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)) : 0;
  const KBPS1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const KBPS2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  let frames = 0, sr = 0, ch = 0, spf = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) { i++; continue; } // MPEG audio Layer III only
    const rate = RATES[ver][sri], kbps = (ver === 3 ? KBPS1 : KBPS2)[bri];
    if (!frames) { sr = rate; ch = b[i + 3] >> 6 === 3 ? 1 : 2; spf = ver === 3 ? 1152 : 576; }
    const xing = frames === 0 && /Xing|Info/.test(b.toString('latin1', i + 4, Math.min(i + 48, b.length)));
    if (!xing) frames++;
    i += Math.floor(((ver === 3 ? 144000 : 72000) * kbps) / rate) + pad;
  }
  return frames ? { sample_rate: sr, channels: ch, measured_seconds: +((frames * spf) / sr).toFixed(3) } : {};
}

// ---------------------------------------------------------------------------------------------------------------
// emit: content-hashed dist + manifest.json + credits.json + assets.ts key list
// ---------------------------------------------------------------------------------------------------------------
function hashedCopy(file, out) {
  const buf = readFileSync(file);
  const h = sha(buf).slice(0, 10);
  const ext = extname(out);
  const url = `${out.slice(0, -ext.length)}.${h}${ext}`;
  const dest = join(DIST, url);
  if (!existsSync(dest) || statSync(dest).size !== buf.length) writeAtomic(dest, buf);
  return { url, bytes: buf.length };
}
const TYPE = { '.glb': 'glb', '.ktx2': 'ktx2', '.webp': 'webp', '.ogg': 'ogg', '.mp3': 'mp3', '.wav': 'wav', '.json': 'json', '.png': 'png', '.ttf': 'ttf', '.txt': 'txt' };

function readPrevManifest() {
  try {
    return JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function emit() {
  mkdirp(DIST);
  const prev = readPrevManifest();
  const files = {};
  // keep entries from steps that did not run this time (--only, and every staged --dist run), so partial runs never
  // shrink the manifest: a staged manifest is always a superset of the stage it started from
  if (prev && (ONLY || STAGED)) for (const [k, v] of Object.entries(prev.files || {})) if (!REG.has(k) && existsSync(join(DIST, v.url))) files[k] = v;
  log(`emit -> ${STAGED ? DIST + ' (staged)' : rel(DIST) + ' (live: no prune)'}`);
  for (const [key, r] of [...REG.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { url, bytes } = hashedCopy(r.file, r.out);
    const e = { url, bytes, group: r.group, type: TYPE[extname(r.out)] || extname(r.out).slice(1) };
    if (r.alt) {
      e.alt = {};
      for (const [fmt, a] of Object.entries(r.alt)) if (existsSync(a.file)) e.alt[fmt] = hashedCopy(a.file, a.out).url;
    }
    if (r.extra) Object.assign(e, r.extra);
    files[key] = e;
  }
  // basis transcoder for KTX2Loader.setTranscoderPath(`${base}basis/`)
  const basisSrc = join(ROOT, 'node_modules/three/examples/jsm/libs/basis');
  let basisPath = prev?.basisPath;
  if (existsSync(basisSrc)) {
    mkdirp(join(DIST, 'basis'));
    for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) copyFileSync(join(basisSrc, f), join(DIST, 'basis', f));
    basisPath = 'basis/';
  } else warn('node_modules/three not installed yet: basis transcoder not copied (re-run --only emit later)');
  // prune stale hashed files (staged --dist only, unless --no-prune; the live .assets/dist only with --prune)
  const keep = new Set(Object.values(files).flatMap((e) => [e.url, ...Object.values(e.alt || {})]));
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const r = relative(DIST, p).replaceAll('\\', '/');
      if (statSync(p).isDirectory()) {
        if (r !== 'basis') walk(p);
      } else if (/\.[0-9a-f]{10}\.[a-z0-9]+$/.test(n) && !keep.has(r)) rmSync(p);
    }
  };
  if (PRUNE) walk(DIST);
  const groups = {};
  let total = 0;
  for (const e of Object.values(files)) {
    groups[e.group] = (groups[e.group] || 0) + e.bytes;
    total += e.bytes;
  }
  const manifest = { v: 1, generated: new Date().toISOString(), base: '/assets/', ...(basisPath ? { basisPath } : {}), totalBytes: total, groupBytes: groups, files };
  writeAtomic(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 1));
  // credits
  const prevCredits = (() => {
    try {
      return JSON.parse(readFileSync(join(DIST, 'credits.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  const sources = [...CREDITS.entries()].map(([id, c]) => ({ id, ...c, keys: c.keys.filter((k) => files[k]).sort() })).filter((c) => c.keys.length);
  if (prevCredits && (ONLY || STAGED)) for (const s of prevCredits.sources || []) {
    const cur = sources.find((x) => x.id === s.id);
    if (!cur) sources.push(s);
    else cur.keys = [...new Set([...cur.keys, ...(s.keys || []).filter((k) => files[k])])].sort();
  }
  const credits = {
    note: 'Asset credits for DEAD AIR. CC-BY entries REQUIRE the attribution line in the in-game credits screen. CC0 entries are credited as a courtesy.',
    generated: manifest.generated,
    required: sources.filter((s) => /^CC-BY/.test(s.license)).map((s) => s.attribution || `${s.title} by ${s.author} (${s.license}) ${s.url}`),
    sources: sources.sort((a, b) => a.id.localeCompare(b.id)),
  };
  writeAtomic(join(DIST, 'credits.json'), JSON.stringify(credits, null, 1));
  if (!flag('no-keys-ts')) writeKeysTs(Object.keys(files).sort());
  log(`manifest: ${Object.keys(files).length} keys, ${(total / 1e6).toFixed(1)} MB`, JSON.stringify(Object.fromEntries(Object.entries(groups).map(([g, b]) => [g, +(b / 1e6).toFixed(1)]))));
}

function writeKeysTs(keys) {
  const file = join(ROOT, 'packages/shared/src/assets.ts');
  if (!existsSync(file)) return warn('assets.ts missing');
  const src = readFileSync(file, 'utf8');
  const start = '// <generated:keys>';
  const end = '// </generated:keys>';
  const i = src.indexOf(start);
  const j = src.indexOf(end);
  if (i < 0 || j < 0) return warn('assets.ts: generated markers missing');
  // union with the lists already in the file: keys and material ids are only ever added (a staged or partial run, or a
  // material listed ahead of its textures, never removes a name other code is typed against)
  const block = src.slice(i, j);
  const listed = (name) => {
    const a = block.indexOf(`export const ${name} = [`);
    if (a < 0) return [];
    const b = block.indexOf('] as const;', a);
    return [...block.slice(a, b).matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  keys = [...new Set([...listed('ASSET_KEYS'), ...keys])].sort();
  const mats = [...new Set([...listed('MATERIAL_IDS'), ...keys.filter((k) => k.startsWith('tex.')).map((k) => k.split('.')[1])])].sort();
  const body = [
    start,
    '// Written by tools/fetch-assets.mjs from the built manifest. Do not edit by hand.',
    'export const ASSET_KEYS = [',
    ...keys.map((k) => `  '${k}',`),
    '] as const;',
    'export const MATERIAL_IDS = [',
    ...mats.map((k) => `  '${k}',`),
    '] as const;',
    '',
  ].join('\n');
  const next = src.slice(0, i) + body + src.slice(j);
  if (next !== src) writeAtomic(file, next);
}

// ---------------------------------------------------------------------------------------------------------------
const steps = [
  ['chars', stepCharacters],
  ['anims', stepAnimations],
  ['hound', stepHound],
  ['tex', stepTextures],
  ['props', stepProps],
  ['fonts', stepFonts],
  ['decals', stepDecals],
  ['audio', stepAudio],
  ['el', stepElevenLabs],
];
const t0 = Date.now();
let failed = 0;
for (const [name, fn] of steps) {
  if (!want(name)) continue;
  const t = Date.now();
  try {
    await fn();
    log(`step ${name} ok (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.error(`[assets] step ${name} FAILED:`, e.stack || e.message);
  }
}
if (!flag('no-emit')) await emit();
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s${failed ? `, ${failed} step(s) failed` : ''}`);
process.exitCode = failed ? 1 : 0;
