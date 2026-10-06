await h.close('Talker');
const [a, b, c] = await Promise.all([
  h.launch('FreshTalk', 'talk_en.wav', { path: '/voicetest', crew: 'VFRS', query: { autojoin: '1' }, viewport: { width: 390, height: 844 } }),
  h.launch('FreshWhisper', 'whisper.wav', { path: '/voicetest', crew: 'VFRS', query: { autojoin: '1' }, viewport: { width: 390, height: 844 } }),
  h.launch('FreshShout', 'shout.wav', { path: '/voicetest', crew: 'VFRS', query: { autojoin: '1' }, viewport: { width: 390, height: 844 } }),
]);
// wait for each mic to go live, then record the band every 100 ms for 40 s
const rec = async (p) => {
  for (let i = 0; i < 100; i++) { const ok = await h.ev(p.page, () => !!(window.__voiceDebug && window.__voiceDebug.level && window.__voiceDebug.level())); if (ok) break; await h.sleep(200); }
  return h.ev(p.page, async () => {
    const names = ['silent', 'whisper', 'talk', 'shout', 'scream'];
    const out = [];
    for (let s = 0; s < 8; s++) {
      const hist = {};
      const t0 = performance.now();
      while (performance.now() - t0 < 5000) { const b = window.__voiceDebug.band(); hist[names[b]] = (hist[names[b]] || 0) + 1; await new Promise((r) => setTimeout(r, 100)); }
      out.push(`${s * 5}-${s * 5 + 5}s base ${window.__voiceDebug.level().base.toFixed(1)}: ${Object.entries(hist).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    return out;
  });
};
const [ra, rb, rc] = await Promise.all([rec(a), rec(b), rec(c)]);
return { talk_en: ra, whisper: rb, shout: rc };
