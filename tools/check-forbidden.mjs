#!/usr/bin/env node
// Forbidden / obsolete API grep (CLAUDE.md "Code rules", PLAN.md Appendix B). Scans apps/** and packages/**
// sources (not node_modules/dist). Prints file:line for every hit and exits 1 if there are any.
// Usage: node tools/check-forbidden.mjs [paths...]
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|html)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', '.git', '.assets', 'coverage']);

/** [regex, why, optional path prefix filter (posix, relative to repo root)] */
const RULES = [
  [/\bEffectComposer\b/, 'three: EffectComposer is WebGL-only; use RenderPipeline + TSL nodes'],
  [/\bShaderMaterial\b/, 'three: ShaderMaterial is not supported by WebGPURenderer; use NodeMaterial + TSL'],
  [/\bRawShaderMaterial\b/, 'three: RawShaderMaterial; use NodeMaterial + TSL'],
  [/\bonBeforeCompile\b/, 'three: onBeforeCompile does nothing on node materials'],
  [/\bPCFSoftShadowMap\b/, 'three: PCFSoftShadowMap (deprecated in r186)'],
  [/\bRGBELoader\b/, 'three: RGBELoader (use HDRLoader)'],
  [/\bClusteredLighting\b/, 'three: ClusteredLighting renders black on WebGL2'],
  [/\bBundleGroup\b/, 'three: BundleGroup crashes with GTAO'],
  [/addons\/physics\/RapierPhysics/, 'three: RapierPhysics addon (no physics engine tonight)'],
  [/\bBatchedMesh\b/, 'three: BatchedMesh for level geometry', 'apps/client/src/level/'],
  [/ScriptProcessor/, 'audio: ScriptProcessorNode; use an AudioWorklet'],
  [/['"`]remote-only['"`]/, "audio: echoCancellation 'remote-only' does not cancel Web Audio output"],
  [/autoGainControl\s*:\s*true/, 'audio: AGC squashes whisper/shout; use autoGainControl:false'],
  [/\b(ctrlKey|metaKey)\b/, 'input: never bind Ctrl/Meta (Ctrl+W closes the tab)'],
  [/\bsetInterval\s*\(/, 'server: setInterval runs at ~21 Hz on Windows; use the performance.now() accumulator loop', 'apps/server/'],
  [/\bMath\.random\b/, 'determinism: use makeRng() from packages/shared/src/rng.ts', 'packages/shared/src/procgen/'],
  [/\bMath\.random\b/, 'determinism: use makeRng() from packages/shared/src/rng.ts', 'apps/server/src/level/'],
  [/messages\.parse\(/, 'claude: messages.parse() drops the message on truncation; use create() + output_config.format'],
  [/\bbudget_tokens\b/, 'claude: budget_tokens returns 400 on the 5.5 models'],
  [/\bdangerouslyAllowBrowser\b/, 'claude: never call the API from the browser'],
  [/type\s*:\s*['"`]disabled['"`]/, "claude: thinking {type:'disabled'} is not allowed (Opus 5.5 always thinks)"],
  [/\btemperature\s*:/, 'claude: temperature returns 400 on the 5.5 models', 'apps/server/src/ai/'],
  [/\btop_[pk]\s*:/, 'claude: top_p/top_k return 400 on the 5.5 models', 'apps/server/src/ai/'],
  [/\boutput_format\b/, 'claude: use output_config.format', 'apps/server/src/ai/'],
];

function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name) && st.size < 2 * 1024 * 1024) out.push(p);
  }
}

const args = process.argv.slice(2);
const files = [];
for (const d of args.length ? args : ['apps', 'packages']) {
  const p = resolve(root, d);
  if (existsSync(p) && statSync(p).isFile()) files.push(p);
  else walk(p, files);
}

const hits = [];
for (const f of files) {
  const rel = relative(root, f).split(sep).join('/');
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  for (const [re, why, prefix] of RULES) {
    if (prefix && !rel.startsWith(prefix)) continue;
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return; // comment-only lines may name forbidden APIs
      if (re.test(line)) hits.push(`${rel}:${i + 1}: ${why}\n    ${line.trim().slice(0, 160)}`);
    });
  }
}

if (hits.length) {
  console.error(`FORBIDDEN API CHECK FAILED (${hits.length} hit${hits.length > 1 ? 's' : ''}):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`forbidden-API check ok (${files.length} files, ${RULES.length} rules)`);
