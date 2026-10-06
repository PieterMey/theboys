// Track ⑤ Players E2E: avatar variants (body m/f x helmet dome/box/diver, suit colours, visor glyphs, badges)
// as local dummies; screenshots lit by a test lamp and by the flashlight only. Look at them!
//   node tests/players/variants.e2e.ts   (dev server on PORT, default 3005)
import { screenshot } from '../lib/launch.ts';
import { OUT, assert, joinPlayer } from './lib.ts';

const p = await joinPlayer('Viewer', 'PVAR', { viewport: { width: 1280, height: 720 } });
const page = p.page;
try {
  await page.waitForFunction(() => window.__players!.rigReady(), undefined, { timeout: 20_000 }).catch(() => console.log('rig not ready: placeholders'));
  const profiles = [
    { name: 'Ann', body: 'f', suit: ['#d4a017', '#2c3e50'], helmet: 'dome', visor: { glyphs: 'A', color: '#7dfcff' }, badge: 117 },
    { name: 'Bo', body: 'm', suit: ['#c0392b', '#ecf0f1'], helmet: 'box', visor: { glyphs: 'B0', color: '#ff4d4d' }, badge: 204 },
    { name: 'Cy', body: 'm', suit: ['#2e86c1', '#e67e22'], helmet: 'diver', visor: { glyphs: 'C', color: '#ffd84d' }, badge: 381 },
    { name: 'Dee', body: 'f', suit: ['#27ae60', '#7f8c8d'], helmet: 'box', visor: { glyphs: 'XYZ', color: '#9dff6b' }, badge: 452 },
    { name: 'Eli', body: 'm', suit: ['#8e44ad', '#1abc9c'], helmet: 'dome', visor: { glyphs: ':)', color: '#ff7df3' }, badge: 569 },
    { name: 'Fay', body: 'f', suit: ['#7f8c8d', '#d4a017'], helmet: 'diver', visor: { glyphs: 'F', color: '#ffffff' }, badge: 690 },
  ];
  const me = await page.evaluate(() => window.__players!.local());
  const [x0, , z0] = me.p;
  await page.evaluate(({ profiles, x0, z0 }) => {
    profiles.forEach((pr, i) => window.__players!.dummy(`d${i}`, [x0 - 2.5 + i * 1.0, 0, z0 + 3.2], Math.PI, pr, { anim: 0 }));
    window.__players!.setCamera([x0, 1.45, z0 + 0.2], [x0, 1.15, z0 + 3.2]);
  }, { profiles, x0, z0 });
  await page.waitForTimeout(1500);
  await screenshot(page, `${OUT}/variants_flashlight.png`);
  await page.evaluate(({ x0, z0 }) => {
    window.__players!.testLight([x0, 2.7, z0 + 1.8], 9);
    window.__players!.testLight([x0 + 2.5, 2.2, z0 + 1.5], 4, '#a8c8ff');
  }, { x0, z0 });
  await page.waitForTimeout(1500);
  await screenshot(page, `${OUT}/variants_lit.png`);
  // close-up: helmets + visor glyphs
  await page.evaluate(({ x0, z0 }) => window.__players!.setCamera([x0 - 1.0, 1.62, z0 + 1.7], [x0 - 1.0, 1.5, z0 + 3.2]), { x0, z0 });
  await page.waitForTimeout(800);
  await screenshot(page, `${OUT}/variants_closeup.png`);
  // walking / crouch / emote anims
  await page.evaluate(({ x0, z0 }) => {
    window.__players!.dummy('d0', [x0 - 2.5, 0, z0 + 3.2], Math.PI, { name: 'Ann', body: 'f', suit: ['#d4a017', '#2c3e50'], helmet: 'dome', visor: { glyphs: 'A', color: '#7dfcff' }, badge: 117 }, { anim: 14 });
    window.__players!.dummy('d1', [x0 - 1.5, 0, z0 + 3.2], Math.PI, { name: 'Bo', body: 'm', suit: ['#c0392b', '#ecf0f1'], helmet: 'box', visor: { glyphs: 'B0', color: '#ff4d4d' }, badge: 204 }, { anim: 4, stance: 1 });
    window.__players!.dummy('d2', [x0 - 0.5, 0, z0 + 3.2], Math.PI * 0.75, { name: 'Cy', body: 'm', suit: ['#2e86c1', '#e67e22'], helmet: 'diver', visor: { glyphs: 'C', color: '#ffd84d' }, badge: 381 }, { anim: 3 });
    window.__players!.dummy('d3', [x0 + 0.5, 0, z0 + 3.2], Math.PI, { name: 'Dee', body: 'f', suit: ['#27ae60', '#7f8c8d'], helmet: 'box', visor: { glyphs: 'XYZ', color: '#9dff6b' }, badge: 452 }, { anim: 17 });
    window.__players!.dummy('d4', [x0 + 1.5, 0, z0 + 3.2], Math.PI, { name: 'Eli', body: 'm', suit: ['#8e44ad', '#1abc9c'], helmet: 'dome', visor: { glyphs: ':)', color: '#ff7df3' }, badge: 569 }, { anim: 12, stance: 4 });
    window.__players!.setCamera([x0, 1.45, z0 + 0.2], [x0, 1.0, z0 + 3.2]);
  }, { x0, z0 });
  await page.waitForTimeout(1200);
  await screenshot(page, `${OUT}/variants_anims.png`);
  const av = await page.evaluate(() => window.__players!.avatars());
  console.log(JSON.stringify(av.map((a) => ({ id: a.id, rig: a.rig, anim: a.anim }))));
  assert(av.length >= 6, 'six dummies built');
  const errs = await page.evaluate(() => window.__game!.errors());
  console.log('errors:', errs.slice(0, 6));
  console.log('PASS players/variants');
} finally {
  await p.close();
}
