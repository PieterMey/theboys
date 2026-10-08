// Owner: env-paranormal (v1.2). Tell-language guard: the paranormal code (server + client) never uses monster cues,
// strobes, walkies / intercoms, vents, ceiling scratching, the scrape loop, breath or whisper sounds, and never
// Math.random in server decisions.  node --test tests/paranormal/grep.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const DIRS = ['apps/server/src/paranormal', 'apps/client/src/paranormal'];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

/** code lines only (comment-only lines may name what is banned) with trailing // comments stripped */
function codeLines(path: string): { n: number; s: string }[] {
  const out: { n: number; s: string }[] = [];
  let block = false;
  readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, i) => {
    let s = line;
    if (block) {
      const e = s.indexOf('*/');
      if (e < 0) return;
      s = s.slice(e + 2);
      block = false;
    }
    if (/^\s*(\/\/|\*)/.test(s)) return;
    const b = s.indexOf('/*');
    if (b >= 0 && s.indexOf('*/', b) < 0) { block = true; s = s.slice(0, b); }
    s = s.replace(/\/\*.*?\*\//g, '');
    // strip a trailing // comment (not inside a URL string)
    const c = s.search(/(^|[^:'"])\/\/(?!.*['"])/);
    if (c >= 0) s = s.slice(0, c + 1);
    if (s.trim()) out.push({ n: i + 1, s });
  });
  return out;
}

const BANNED: [RegExp, string, ('server' | 'client' | 'both')?][] = [
  [/\bflickerSpace\b/, 'strobe (flickerSpace is the Listener telegraph)'],
  [/sfx\.(listener|mannequin|creature|hound|radio)_/, 'monster / walkie sound key'],
  [/['"`]monsters\.(cue|telegraph|lure|led|director|vent|blink|grab|snatch)['"`]/, 'monster event'],
  [/walkie|intercom|squelch/i, 'walkies / intercoms'],
  [/\bvent\b|vent_|_vent|ductThump|listener_vent/i, 'vents', 'client'],
  [/['"`]vent_rattle['"`]|listener_vent|ductThump/, 'vent tells', 'server'],
  [/scratch/i, 'ceiling scratching'],
  [/(?<!chair_)scrape/i, 'the scrape loop (only the one-shot chair_scrape is allowed)'],
  [/whisper/i, 'whisper sounds'],
  [/synth\??\.?\(\s*['"`]breath|['"`]sfx\.[a-z_]*breath|creature_breath/, 'breath sounds (the Listener retreat cue)'],
  [/\bMath\.random\b/, 'Math.random in decisions (use the crew rng / the event seed)'],
];

test('paranormal code speaks only its own tell language', () => {
  const hits: string[] = [];
  let scanned = 0;
  for (const d of DIRS) {
    const side = d.includes('/server/') ? 'server' : 'client';
    for (const f of files(join(REPO, d))) {
      scanned++;
      for (const { n, s } of codeLines(f)) {
        for (const [re, why, only] of BANNED) {
          if (only && only !== side) continue;
          if (re.test(s)) hits.push(`${relative(REPO, f)}:${n}: ${why}\n    ${s.trim().slice(0, 140)}`);
        }
      }
    }
  }
  assert.ok(scanned >= 10, `scanned ${scanned} files`);
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('the synth kinds E4 plays exist in the shared SynthKind list (no breath / whisper there either)', () => {
  const api = readFileSync(join(REPO, 'apps/client/src/audio/api.ts'), 'utf8');
  const kinds = new Set([...api.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(!kinds.has('breath') && !kinds.has('whisper'), 'SynthKind has no breath / whisper');
  const used = new Set<string>();
  for (const f of files(join(REPO, 'apps/client/src/paranormal'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/synth\(\s*'([a-z_]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 6, `synth kinds used: ${[...used].join(', ')}`);
  for (const k of used) assert.ok(kinds.has(k), `SynthKind '${k}'`);
});
