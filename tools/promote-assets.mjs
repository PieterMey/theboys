// Integrator tool: promote a staged asset dist into the live .assets/dist ADDITIVELY. It never prunes and never
// overwrites a hashed file with different bytes; it copies the new files first, then swaps manifest.json and
// credits.json in by rename, and finally checks that every file the new manifest names exists.
//   node tools/promote-assets.mjs <stage dist> [--dist <live dist>] [--dry]
// <stage dist> is the folder tools/fetch-assets.mjs --dist wrote (it holds manifest.json). The live dist defaults to
// <repo>/.assets/dist, which the live server reads (theboys-live has no .assets of its own).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const STAGE = args.find((a) => !a.startsWith('--') && a !== opt('dist'));
const DIST = resolve(opt('dist') ?? join(import.meta.dirname, '..', '.assets', 'dist'));
const DRY = args.includes('--dry');
const SWAP = new Set(['manifest.json', 'credits.json']);

if (!STAGE || !existsSync(join(STAGE, 'manifest.json'))) {
  console.error('usage: node tools/promote-assets.mjs <stage dist with manifest.json> [--dist <live dist>] [--dry]');
  process.exit(2);
}
if (resolve(STAGE) === DIST) { console.error('stage and live dist are the same folder'); process.exit(2); }

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const toAdd = [];
let same = 0;
for (const src of walk(STAGE)) {
  const rel = relative(STAGE, src).split(sep).join('/');
  if (SWAP.has(rel)) continue;
  const dst = join(DIST, rel);
  if (existsSync(dst)) {
    if (!readFileSync(dst).equals(readFileSync(src))) throw new Error(`refusing to overwrite a different existing file: ${rel}`);
    same++;
    continue;
  }
  toAdd.push([src, dst, rel]);
}

// the new manifest may only name files that exist after the copy
const man = JSON.parse(readFileSync(join(STAGE, 'manifest.json'), 'utf8'));
const adding = new Set(toAdd.map(([, , rel]) => rel));
const missing = Object.values(man.files ?? {}).map((f) => f.url).filter((u) => !existsSync(join(DIST, u)) && !adding.has(u));
if (missing.length) throw new Error(`the staged manifest names ${missing.length} files that would not exist, e.g. ${missing.slice(0, 3).join(', ')}`);

if (!DRY) {
  for (const [src, dst] of toAdd) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  for (const f of SWAP) {
    if (!existsSync(join(STAGE, f))) continue;
    const tmp = join(DIST, `${f}.tmp-${process.pid}`);
    copyFileSync(join(STAGE, f), tmp);
    renameSync(tmp, join(DIST, f));
  }
}

const live = JSON.parse(readFileSync(join(DRY ? STAGE : DIST, 'manifest.json'), 'utf8'));
const liveMissing = DRY ? missing.length : Object.values(live.files ?? {}).map((f) => f.url).filter((u) => !existsSync(join(DIST, u))).length;
console.log(JSON.stringify({ dry: DRY, dist: DIST, added: DRY ? 0 : toAdd.length, wouldAdd: toAdd.length, alreadyIdentical: same, manifestKeys: Object.keys(live.files ?? {}).length, missingAfter: liveMissing }));
