// Track ⑤ Players E2E: first-person view (view-model flashlight, head bob while walking, crouch eye height)
// in a facility; screenshots tests/artifacts/players/fp_*.png.   node tests/players/firstperson.e2e.ts
import { screenshot } from '../lib/launch.ts';
import { OUT, assert, joinPlayer, local, testLevel } from './lib.ts';

const p = await joinPlayer('Eyes', 'PFPV');
const page = p.page;
try {
  await testLevel(page, 'fp-e2e', 2);
  await page.waitForTimeout(1200);
  const wall = await page.evaluate(() => window.__players!.findWall());
  assert(wall, 'wall');
  // stand 2 m from a wall, look at it
  await page.evaluate((w) => { window.__game!.teleport(w.cx - 1.2, w.cz + 0.5, Math.PI / 2); window.__game!.look(Math.PI / 2, -0.12); }, wall);
  await page.waitForTimeout(1500);
  await screenshot(page, `${OUT}/fp_idle.png`);
  await page.evaluate(() => window.__game!.setInput({ forward: 0, right: 1 }));
  await page.waitForTimeout(450);
  await screenshot(page, `${OUT}/fp_walk.png`);
  await page.evaluate(() => window.__game!.setInput({ right: 0, crouch: true }));
  await page.waitForTimeout(700);
  const c = await local(page);
  await screenshot(page, `${OUT}/fp_crouch.png`);
  await page.evaluate(() => window.__game!.setInput({ crouch: false, flashlight: true }));
  await page.waitForTimeout(500);
  await screenshot(page, `${OUT}/fp_dark.png`);
  console.log(JSON.stringify({ eyeCrouch: c.eye, errors: (await page.evaluate(() => window.__game!.errors())).slice(0, 5) }));
  console.log('PASS players/firstperson');
} finally {
  await p.close();
}
