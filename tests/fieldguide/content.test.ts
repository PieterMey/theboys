// Owner: fieldguide (v1.2). Content: every page has a title and text, placeholders resolve against the real balance files,
// the copy states the v1.2 rules, and no page text leaks into the client bundle (apps/client/**, config/balance/**).
//   node --test tests/fieldguide/content.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ANOMALY_KINDS, ANOMALY_LABELS, MONSTERS, MONSTER_ORDER, PAGES, PLACEHOLDER, allTemplates, fillText, pageIdsOf, renderCard, renderPage, resolvePlaceholder,
} from '../../apps/server/src/fieldguide/content.ts';
import { MONSTER_NAMES } from '../../apps/client/src/fieldguide/store.ts';

const REPO = resolve(import.meta.dirname, '../..');
function readBalance(): Record<string, unknown> {
  const dir = join(REPO, 'config/balance');
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) out[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
}
const balance = readBalance();

test('pages: HOUND 5, LISTENER 6, MANNEQUIN 4, SNATCHER 4, ids monster.n, every one with a title and text', () => {
  assert.deepEqual(MONSTER_ORDER.map((k) => pageIdsOf(k).length), [5, 6, 4, 4]);
  const ids = new Set<string>();
  for (const p of PAGES) {
    assert.ok(!ids.has(p.id), `unique id ${p.id}`);
    ids.add(p.id);
    assert.equal(p.id, `${p.monster}.${p.n}`);
    assert.ok(p.title.trim().length >= 4, `${p.id} title`);
    assert.ok(p.text.trim().length >= 80, `${p.id} text`);
    if (p.textV11 !== undefined) assert.ok(p.textV11.trim().length >= 60, `${p.id} v1.1 text`);
    for (const t of [p.text, p.textV11].filter((x): x is string => x !== undefined)) {
      for (const para of t.split('\n')) assert.ok(para.trim().length > 0, `${p.id}: no empty paragraph`);
    }
  }
  for (const k of MONSTER_ORDER) {
    assert.ok(MONSTERS[k].card.length === 3 && MONSTERS[k].sounds.length >= 2, `${k} card + sounds`);
    assert.equal(MONSTERS[k].name, MONSTER_NAMES[k], `client display name matches for ${k}`);
  }
  assert.equal(ANOMALY_KINDS.length, 16);
  for (const k of ANOMALY_KINDS) assert.ok(ANOMALY_LABELS[k].length >= 4);
});

test('placeholders resolve from config/balance (v1.2 keys may use their inline default until they land)', () => {
  const pending: string[] = [];
  for (const { where, text } of allTemplates()) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const [, path, def] = m;
      const v = resolvePlaceholder(path!, balance);
      if (v === undefined) {
        assert.ok(def !== undefined, `${where}: {{${path}}} resolves to nothing and has no default`);
        pending.push(path!);
      } else if (typeof v === 'number') assert.ok(Number.isFinite(v), `${where}: ${path} finite`);
    }
    const filled = fillText(text, balance);
    assert.ok(!filled.includes('{{') && !filled.includes('}}'), `${where}: all braces filled`);
    assert.ok(!/(^|\s)\?(\s|$|[.,)])/.test(filled), `${where}: no unresolved '?' value in "${filled.slice(0, 80)}"`);
  }
  if (pending.length) console.log(`  (balance keys not landed yet, inline defaults used: ${[...new Set(pending)].join(', ')})`);
  // a few spot checks against the real numbers
  const lis = (balance.monsters as { listener: Record<string, number> }).listener;
  const p5 = renderPage(PAGES.find((p) => p.id === 'listener.5')!, balance, true);
  assert.ok(p5.text.includes(`within ${lis.grabAloneM} m`), 'grabAloneM filled from monsters.json');
  const h2 = renderPage(PAGES.find((p) => p.id === 'hound.2')!, balance, true);
  assert.ok(h2.text.includes(String((balance.monsters as { hound: Record<string, number> }).hound.chargeSpeed)), 'hound chargeSpeed filled');
});

test('the copy states the v1.2 rules (and the v1.1 variant for listenerFairV12 off)', () => {
  const card = renderCard('listener', balance, true).join(' ');
  for (const w of [/notices/, /[Ss]print/, /[Cc]rouch/, /door/, /flare/, /crowbar/, /knocks you down/, /shel/]) assert.match(card, w);
  const all = PAGES.filter((p) => p.monster === 'listener').map((p) => renderPage(p, balance, true).text).join(' ');
  assert.match(all, /notices you, it stops/);
  assert.match(all, /sprint at/);
  assert.match(all, /shelf/, 'low cover includes tall solids (plan check #10)');
  assert.match(all, /stunned/);
  assert.match(all, /flare/);
  assert.match(all, /staggers/);
  assert.match(all, /only knocks you down/);
  const mirror = PAGES.filter((p) => p.monster === 'mannequin').map((p) => p.text).join(' ');
  assert.match(mirror, /a mirror does not count as watching it/);
  const off = PAGES.filter((p) => p.monster === 'listener').map((p) => renderPage(p, balance, false).text).join(' ');
  for (const w of [/knocks you down/, /stunned/, /MASH E/, /huntSpeed/]) assert.doesNotMatch(off, w, `v1.1 copy has no ${w}`);
  assert.doesNotMatch(renderCard('listener', balance, false).join(' '), /knocks you down/);
});

// ---------------------------------------------------------------- leak check

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) { if (f !== 'node_modules' && f !== 'dist') walk(p, out); } else if (/\.(ts|tsx|js|mjs|json|css|html|md)$/.test(f)) out.push(p);
  }
  return out;
}

test('no page, card or sound text anywhere in apps/client/** or config/balance/**', () => {
  const files = [...walk(join(REPO, 'apps/client')), ...walk(join(REPO, 'config/balance'))];
  const corpus = files.map((f) => ({ f, s: readFileSync(f, 'utf8') }));
  const needles = new Set<string>();
  for (const { text } of allTemplates()) {
    for (const piece of text.split(PLACEHOLDER)) {
      if (!piece) continue;
      for (const frag of piece.split(/[.!?\n:;]/)) {
        const t = frag.replace(/^✎\s*/, '').trim();
        if (t.length >= 22) needles.add(t);
      }
    }
  }
  for (const p of PAGES) for (const t of [p.title, p.titleV11 ?? '']) if (t.length >= 12) needles.add(t);
  assert.ok(needles.size > 80, `enough fragments to check (${needles.size})`);
  const hits: string[] = [];
  for (const n of needles) for (const { f, s } of corpus) if (s.includes(n)) hits.push(`${f.slice(REPO.length + 1)}: "${n}"`);
  assert.deepEqual(hits, [], 'page text must live server-side only');
  console.log(`  ${needles.size} text fragments checked against ${files.length} client/balance files`);
});
