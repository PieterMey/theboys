// Fixed-step accumulator at 30 Hz, woken by setTimeout(1)
const DURATION = Number(process.argv[2] || 10000);
const STEP = 1000/30; let acc = 0; let steps = 0; const t0 = performance.now(); let last = t0; let wakes = 0; const lag = [];
let nextDue = t0 + STEP;
function loop() {
  const now = performance.now(); wakes++;
  acc += now - last; last = now;
  while (acc >= STEP) { acc -= STEP; steps++; lag.push(now - nextDue); nextDue += STEP; }
  if (now - t0 < DURATION) setTimeout(loop, 1);
  else {
    lag.sort((a,b)=>a-b);
    console.log(JSON.stringify({test:'accumulator+setTimeout(1)', steps, hz:+(steps/((now-t0)/1000)).toFixed(2), wakesPerSec:+(wakes/((now-t0)/1000)).toFixed(1), stepLateness_p50_ms:+lag[Math.floor(lag.length*0.5)].toFixed(2), p99:+lag[Math.floor(lag.length*0.99)].toFixed(2), max:+lag[lag.length-1].toFixed(2)}));
  }
}
setTimeout(loop, 1);
