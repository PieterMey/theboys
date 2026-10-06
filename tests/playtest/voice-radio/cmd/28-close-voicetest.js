await h.close('Shouter');
await h.close('Tone2');
await h.close('Relay');
const p = await h.launch('Phone', 'callsign_boiler.wav', { path: '/voicetest', viewport: { width: 390, height: 844 } });
await h.sleep(4000);
const s0 = await h.shot(p.page, '28-voicetest-phone-initial');
// real UI: type the crew code, tap JOIN VOICE
const input = p.page.locator('input[type=text]').first();
await input.click();
await p.page.keyboard.type('VRAD', { delay: 60 });
await p.page.getByRole('button', { name: /JOIN VOICE/ }).click();
await h.sleep(9000);
const s1 = await h.shot(p.page, '28-voicetest-phone-joined');
const txt = await p.page.evaluate(() => document.body.innerText);
const pr = await h.peers(p.page);
return { s0, s1, txt, peers: Object.fromEntries(Object.entries(pr).map(([k, v]) => [k, `${v.state}/${v.candidate} rx ${v.bytesReceived} rms ${v.rmsL.toFixed(3)}`])), errors: p.console.filter((l) => !/\[voice\]/.test(l)).slice(-8) };
