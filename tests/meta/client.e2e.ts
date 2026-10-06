// Owner: track (d) Meta. Real-client integration (2 Chrome players): walk up to hub items and press E through
// ⑤ input -> (b) interaction -> meta.open; edit the suit at the locker mirror and check the OTHER player sees it;
// pick an order on the board and HOLD TO DRIVE through the UI -> drive -> contract; open the van console with E.
// Run: node tests/meta/client.e2e.ts   (own dev server on PORT (default 3014))
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { launchPlayer } from '../lib/launch.ts';
import { dbg, freezeVite, joined, phase, screenIs, shot, sleep, startServer } from './lib.ts';
import type { G } from './lib.ts';

const PORT = Number(process.env.PORT ?? 3014);
const srv = await startServer(PORT);
let code = 0;
const closers: (() => Promise<void>)[] = [];

/** stand 1.2 m in front of a layout item (its rot = facing), look at it, mirror the pose on the server */
async function standAt(page: Page, kind: string): Promise<{ id: string }> {
  const target = (await page.evaluate((k) => {
    const w = window as unknown as { __metaItems?: (kind: string) => { id: string; x: number; z: number; rot: number } | null };
    return w.__metaItems ? w.__metaItems(k) : null;
  }, kind)) as { id: string; x: number; z: number; rot: number } | null;
  if (!target) throw new Error(`no ${kind} item`);
  const sx = target.x + Math.sin(target.rot) * 1.2;
  const sz = target.z + Math.cos(target.rot) * 1.2;
  const yaw = target.rot + Math.PI;
  await dbg(page, 'interaction.pose', { x: sx, z: sz, yaw });
  await page.evaluate(([x, z, y]) => (window as unknown as G).__game.teleport(x, z, y), [sx, sz, yaw] as const);
  await sleep(700);
  return { id: target.id };
}

async function pressE(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as G).__game.setInput({ interact: true }));
  await sleep(120);
  await page.evaluate(() => (window as unknown as G).__game.setInput({ interact: false }));
}

try {
  const a = await launchPlayer({ name: 'Ann', baseUrl: srv.base, crew: 'CLNT', query: { autojoin: '1', nobright: '1' } });
  closers.push(() => a.close());
  await freezeVite(a.page);
  await joined(a.page);
  const b = await launchPlayer({ name: 'Bob', baseUrl: srv.base, crew: 'CLNT', query: { autojoin: '1', nobright: '1' }, viewport: { width: 320, height: 180 } });
  closers.push(() => b.close());
  await freezeVite(b.page);
  await joined(b.page);
  for (const p of [a.page, b.page]) {
    await p.evaluate(() => {
      // test-only: expose layout items by kind (read from the client world through the meta test hook's module scope)
      const g = window as unknown as { __metaItems?: unknown; __meta: { layoutItems?: () => { id: string; kind: string; x: number; z: number; rot?: number }[] } };
      g.__metaItems = (k: string) => {
        const list = g.__meta.layoutItems?.() ?? [];
        const it = list.find((i) => i.kind === k);
        return it ? { id: it.id, x: it.x, z: it.z, rot: it.rot ?? 0 } : null;
      };
    });
  }
  await sleep(2500);

  // ---- E at the board -> board screen
  await standAt(a.page, 'board');
  await shot(a.page, 'client-near-board');
  await pressE(a.page);
  await screenIs(a.page, 'board', 6000);
  console.log('E at the board opened the board screen');
  await a.page.keyboard.press('Escape');
  await screenIs(a.page, 'none');

  // ---- mirror: change suit primary -> Bob sees it on the roster (avatars read it)
  await standAt(a.page, 'mirror');
  await pressE(a.page);
  await screenIs(a.page, 'mirror', 6000);
  const target = '#2e86c1';
  await a.page.click(`.m-field:nth-of-type(2) .m-swatch[style*="background: rgb(46, 134, 193)"], .m-swatches .m-swatch[style*="46, 134, 193"]`);
  await sleep(1200);
  const meId = await a.page.evaluate(() => (window as unknown as G).__game.me());
  const bobSees = await b.page.evaluate((id) => (window as unknown as G).__game.state().crew?.players.find((p) => p.id === id)?.profile.suit[0], meId);
  assert.equal(bobSees, target, `Bob sees Ann's new suit (${bobSees})`);
  console.log(`mirror: Ann's suit -> ${target}; Bob's roster shows ${bobSees}`);
  await shot(a.page, 'client-mirror');
  await a.page.keyboard.press('Escape');

  // ---- board via B, pick, HOLD TO DRIVE (3 s) -> drive -> contract
  await a.page.keyboard.press('KeyB');
  await screenIs(a.page, 'board', 4000);
  await a.page.click('.m-order:not(.locked)');
  await sleep(400);
  const box = await a.page.locator('.m-hold').boundingBox();
  if (!box) throw new Error('no hold button');
  await a.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await a.page.mouse.down();
  await sleep(1500);
  const bobBanner = await b.page.evaluate(() => document.querySelector('.m-drive-hold')?.textContent ?? '');
  await sleep(2100);
  await a.page.mouse.up();
  await phase(a.page, 'drive', 6000);
  console.log(`hold-to-drive -> drive (Bob saw: "${bobBanner.trim()}")`);
  assert.ok(/STARTING THE VAN/.test(bobBanner), 'Bob sees the leader holding DRIVE');
  await screenIs(b.page, 'drive', 20000).catch(async (e: Error) => {
    const st = await b.page.evaluate(() => ({ screen: (window as unknown as G).__meta.screen(), phase: (window as unknown as G).__game.state().phase }));
    throw new Error(`Bob: ${e.message} (${JSON.stringify(st)})`);
  });
  console.log('Bob got the drive screen');
  await dbg(a.page, 'meta.skipDrive');
  await phase(a.page, 'contract', 15000);
  await sleep(2500);

  // ---- E at the van console in the facility
  // right after the contract starts ⑤ holds a short spawn lock (stale poses rejected): retry once
  for (let attempt = 1; ; attempt++) {
    await standAt(a.page, 'console');
    await sleep(600);
    if (attempt === 1) await shot(a.page, 'client-near-console');
    await pressE(a.page);
    const ok = await screenIs(a.page, 'console', 5000).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 3) {
      const pose = await dbg(a.page, 'players.pose');
      throw new Error(`console did not open after ${attempt} tries; server pose ${JSON.stringify(pose)}`);
    }
    await sleep(1500);
  }
  await sleep(800);
  await shot(a.page, 'client-console');
  console.log('E at the van console opened the console');
  const errs = a.errors.filter((e) => !/favicon|net::|ERR_|404/.test(e));
  if (errs.length) console.log(`page errors:\n  ${errs.slice(0, 8).join('\n  ')}`);
  console.log('META CLIENT E2E PASS');
} catch (e) {
  code = 1;
  console.error('META CLIENT E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
  console.error(srv.log().split('\n').filter((l) => /meta|ERROR/.test(l)).slice(-15).join('\n'));
} finally {
  for (const c of closers) await c().catch(() => {});
  srv.stop();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
