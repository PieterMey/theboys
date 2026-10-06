// Track ⑤ Players E2E: movement speeds (walk/crouch/sprint), stamina, collision (walk into a wall: no penetration),
// server footstep noise, flashlight toggle. Run: PORT=3005 npm run dev; node tests/players/move.e2e.ts
import { MOVE, PLAYER } from '../../packages/shared/src/constants.ts';
import { screenshot } from '../lib/launch.ts';
import { OUT, assert, joinPlayer, local, testLevel } from './lib.ts';

const crew = `PM${Date.now().toString(36).slice(-3).toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ]/g, 'K')}`;
const p = await joinPlayer('Mover', crew);
const page = p.page;
const results: Record<string, unknown> = {};
try {
  const lv = await testLevel(page, 'move-e2e', 2);
  results.level = lv;
  await page.waitForTimeout(1500); // let spawn corrections settle
  const start = await local(page);
  results.spawn = start.p;

  // ---- speeds: measure displacement over 1.2 s after 0.4 s acceleration ----
  const measure = async (input: Record<string, unknown>, label: string) => {
    await page.evaluate(() => { const w = window.__players!.findWall(); void w; });
    // open area: teleport to the spawn and face the van side (spawns are in the open lot)
    await page.evaluate((s) => { window.__game!.teleport(s[0], s[2], 0); window.__game!.look(0, 0); }, start.p);
    await page.waitForTimeout(150);
    await page.evaluate((i) => window.__game!.setInput(i), input);
    await page.waitForTimeout(400);
    const a = await local(page);
    const t0 = Date.now();
    await page.waitForTimeout(1000);
    const b = await local(page);
    const dt = (Date.now() - t0) / 1000;
    await page.evaluate(() => window.__game!.setInput({ forward: 0, right: 0, sprint: false, crouch: false }));
    // controller speed (simulation time) is robust to frame stalls on a busy GPU; wall-clock speed for info
    const wall = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]) / dt;
    const v = b.speed;
    results[`speed_${label}`] = Math.round(v * 100) / 100;
    results[`wallclock_${label}`] = Math.round(wall * 100) / 100;
    await page.waitForTimeout(300);
    return { v, b };
  };
  // in-lot movement: face away from the van (yaw 0 = +Z is where?) -> use right strafe if blocked
  const crouch = await measure({ forward: 1, crouch: true }, 'crouch');
  const sprint = await measure({ forward: 1, sprint: true }, 'sprint');
  const walk = await measure({ forward: 1 }, 'walk');
  results.corrections = await page.evaluate(() => (window as unknown as { __netDebug?: { stat(): { corrections: number } } }).__netDebug?.stat().corrections);
  results.stance_crouch_eye = crouch.b.eye;
  results.stamina_after_sprint = sprint.b.stamina;

  // ---- collision: walk into a wall for 1.5 s ----
  const wall = await page.evaluate(() => window.__players!.findWall());
  assert(wall, 'found a wall cell');
  await page.evaluate((w) => { window.__game!.teleport(w.cx + 0.5, w.cz + 0.5, Math.PI / 2); window.__game!.look(Math.PI / 2, 0); }, wall);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__game!.setInput({ forward: 1, sprint: true }));
  let maxX = -Infinity;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(100);
    const l = await local(page);
    maxX = Math.max(maxX, l.p[0]);
  }
  await page.evaluate(() => window.__game!.setInput({ forward: 0, sprint: false }));
  results.wall = { ...wall, maxX: Math.round(maxX * 1000) / 1000, limit: wall.wallX - PLAYER.radius };
  await page.evaluate(() => window.__game!.look(Math.PI / 2 + 0.5, -0.1));
  await page.waitForTimeout(400);
  await screenshot(page, `${OUT}/wall.png`);

  // ---- server noise from pose deltas ----
  await page.evaluate((w) => { window.__game!.teleport(w.cx + 0.5, w.cz + 0.5, -Math.PI / 2); window.__game!.look(-Math.PI / 2, 0); }, wall);
  await page.evaluate(() => window.__game!.setInput({ forward: 1 }));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__game!.setInput({ forward: 0 }));
  const noise = (await page.evaluate(() => window.__game!.dbg('players.noise'))) as { kind: string; radiusM: number }[];
  results.noise = noise.slice(-4).map((n) => `${n.kind}:${n.radiusM}`);

  // ---- flashlight toggle ----
  const l0 = (await local(page)).light;
  await page.evaluate(() => window.__game!.setInput({ flashlight: true }));
  await page.waitForTimeout(100);
  const l1 = (await local(page)).light;
  await page.evaluate(() => window.__game!.setInput({ flashlight: true }));
  results.flashlight = { before: l0, toggled: l1 };

  console.log(JSON.stringify(results, null, 1));
  assert(Math.abs(walk.v - MOVE.walk) < 0.45, `walk speed ${walk.v} ~ ${MOVE.walk}`);
  assert(Math.abs(crouch.v - MOVE.crouch) < 0.35, `crouch speed ${crouch.v} ~ ${MOVE.crouch}`);
  assert(Math.abs(sprint.v - MOVE.sprint) < 0.7, `sprint speed ${sprint.v} ~ ${MOVE.sprint}`);
  assert(crouch.b.eye < 1.3, `crouch eye lowered (${crouch.b.eye})`);
  assert(sprint.b.stamina < 0.95, 'sprint drains stamina');
  assert(maxX <= wall.wallX - PLAYER.radius + 0.01, `no wall penetration (maxX ${maxX} limit ${wall.wallX - PLAYER.radius})`);
  assert(noise.some((n) => n.kind === 'walkStep'), 'server emitted walkStep noise');
  assert(l1 !== l0, 'F toggles the flashlight');
  const errs = (await page.evaluate(() => window.__game!.errors())).filter((e) => !/voice|mic|stt|turn/i.test(e));
  if (errs.length) console.log('client errors:', errs.slice(0, 8));
  console.log('PASS players/move');
} finally {
  await p.close();
}
