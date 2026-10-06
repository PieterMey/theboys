const A = P.A.page;
await A.getByRole('button', { name: 'Settings' }).click();
await h.sleep(800);
await h.shot(A, '26-A-settings');
const read = () => A.evaluate(() => {
  const svc = (n) => { try { return window.__render ? null : null; } catch { return null; } };
  const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/settings|render|exposure|player/i.test(k)) ls[k] = localStorage.getItem(k).slice(0, 300); }
  const r = window.__render;
  let exp = null, preset = null;
  try { exp = r?.exposure?.() ?? r?.three?.()?.renderer?.toneMappingExposure ?? null; } catch {}
  try { preset = r?.preset?.() ?? r?.state?.()?.preset ?? null; } catch {}
  const badge = document.querySelector('[class*=render-badge], .render-hud, [data-testid*=render]')?.textContent ?? [...document.querySelectorAll('div')].find(d => /^RENDER WEBGPU/.test(d.textContent ?? '') && d.children.length === 0)?.textContent;
  return { exp, preset, ls, badge, rkeys: r ? Object.keys(r) : null };
});
const before = await read();
// change via the real controls
const sel = A.locator('.m-set select').first();
await sel.selectOption({ index: 0 });
await h.sleep(2500);
const ranges = A.locator('.m-set input[type=range]');
const n = await ranges.count();
const setRange = async (i, v) => { await ranges.nth(i).evaluate((el, val) => { el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); }, v); };
await setRange(0, 1.8); // exposure
await setRange(1, 0.5); // master
await setRange(n - 1, 0.004); // sensitivity
await h.sleep(800);
const after = await read();
const sens = await A.evaluate(() => { try { return JSON.parse(localStorage.getItem('deadair.playerSettings') ?? 'null'); } catch { return null; } });
await h.shot(A, '27-A-settings-changed');
return { n, before, after, sens };
