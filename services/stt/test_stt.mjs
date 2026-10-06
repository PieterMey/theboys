#!/usr/bin/env node
// Smoke + latency test for the STT sidecar (services/stt/server.py). Free: runs locally on the GPU.
//
//   node services/stt/test_stt.mjs [--wav <file>] [--runs 8] [--no-spawn] [--write-bench]
//
// - Talks to STT_URL (default http://127.0.0.1:3100). If nothing answers there it starts the
//   sidecar itself (services/stt/.venv python server.py) and stops it again at the end.
// - Speech input: --wav, else tests/fixtures/voice/talk_en.wav, else services/stt/test.wav
//   (synthesised with Windows SAPI at 16 kHz when missing). Any PCM/float WAV is converted to the
//   wire format: raw PCM16LE mono 16 kHz.
// - Checks: the speech is transcribed (word recall >= 0.7 for the synthesised sentence), English
//   wins the en/nl detection, 2 s of silence returns empty text, 2 s of noise is reported.
// - --write-bench writes the numbers (no transcripts of real people) to docs/bench/stt-bench.md.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';

const here = import.meta.dirname;
const root = resolve(here, '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const RUNS = Math.max(1, Number(opt('--runs', '8')));
const STT_URL = (process.env.STT_URL || `http://127.0.0.1:${process.env.STT_PORT || 3100}`).replace(/\/$/, '');
const SAPI_TEXT = 'Bravo six, the generator is in the basement. Turn off your flashlight and hide.';
const HOTWORDS = ['Bravo Six', 'generator', 'Listener'];

// ---------------------------------------------------------------- WAV -> PCM16LE mono 16 kHz
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = buf.readUInt16LE(body + 24); // EXTENSIBLE
    } else if (id === 'data') {
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      data = buf.subarray(body, body + size);
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data chunk');
  const { format, channels, rate, bits } = fmt;
  const step = bits / 8;
  const frames = Math.floor(data.length / (step * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * step;
      if (format === 3 && bits === 32) acc += data.readFloatLE(p);
      else if (format === 1 && bits === 16) acc += data.readInt16LE(p) / 32768;
      else if (format === 1 && bits === 24) acc += data.readIntLE(p, 3) / 8388608;
      else if (format === 1 && bits === 32) acc += data.readInt32LE(p) / 2147483648;
      else if (format === 1 && bits === 8) acc += (data[p] - 128) / 128;
      else throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`);
    }
    out[i] = acc / channels;
  }
  return { samples: out, rate };
}

// Windowed-sinc (Hann, 16 zero crossings) resampler; low-passes when downsampling.
function resample(x, from, to) {
  if (from === to) return x;
  const ratio = to / from;
  const cutoff = Math.min(1, ratio);
  const half = 16;
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const center = i / ratio;
    const lo = Math.max(0, Math.ceil(center - half / cutoff));
    const hi = Math.min(x.length - 1, Math.floor(center + half / cutoff));
    let acc = 0;
    let wsum = 0;
    for (let j = lo; j <= hi; j++) {
      const t = (j - center) * cutoff;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const k = sinc * (0.5 + 0.5 * Math.cos((Math.PI * t) / half));
      acc += x[j] * k;
      wsum += k;
    }
    out[i] = wsum ? acc / wsum : 0;
  }
  return out;
}

function toPcm16(f32) {
  const b = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    b.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return b;
}

function synthesizeSapi(outPath, text) {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "try { $s.SelectVoice('Microsoft Zira Desktop') } catch {}",
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${outPath.replace(/'/g, "''")}', $f)`,
    `$s.Speak('${text.replace(/'/g, "''")}')`,
    '$s.SetOutputToNull(); $s.Dispose()',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(outPath)) throw new Error(`SAPI synthesis failed: ${r.stderr || r.stdout}`);
}

// ---------------------------------------------------------------- sidecar process
async function getHealth(timeoutMs = 1500) {
  try {
    const r = await fetch(`${STT_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

let child = null;
function stopChild() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}
process.on('exit', stopChild);

async function ensureServer() {
  let h = await getHealth();
  if (!h) {
    if (flag('--no-spawn')) throw new Error(`no STT sidecar at ${STT_URL} (start it with services/stt/run.ps1)`);
    const py = join(here, '.venv', 'Scripts', 'python.exe');
    if (!existsSync(py)) throw new Error('services/stt/.venv missing: run services/stt/setup.ps1');
    const port = new URL(STT_URL).port || '3100';
    console.log(`[test] no sidecar at ${STT_URL}; starting one (port ${port})`);
    child = spawn(py, ['-u', join(here, 'server.py')], {
      env: { ...process.env, STT_PORT: port, HF_HOME: join(here, 'models') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const echo = (d) => process.stdout.write(String(d).replace(/^/gm, '  | '));
    child.stdout.on('data', echo);
    child.stderr.on('data', echo);
  }
  const t0 = performance.now();
  while (!(h && h.warm)) {
    if (h && !h.loading && h.error) throw new Error(`sidecar failed to load: ${h.error}`);
    if (child && child.exitCode !== null) throw new Error(`sidecar exited with code ${child.exitCode}`);
    if (performance.now() - t0 > 180_000) throw new Error('sidecar not warm after 180 s');
    await new Promise((r) => setTimeout(r, 300));
    h = await getHealth();
  }
  return { health: h, readyMs: Math.round(performance.now() - t0), spawned: !!child };
}

async function transcribe(pcm, { langs = 'en,nl', hotwords = HOTWORDS } = {}) {
  const q = new URLSearchParams({ langs });
  if (hotwords && hotwords.length) q.set('hotwords', hotwords.join(','));
  const t0 = performance.now();
  const r = await fetch(`${STT_URL}/transcribe?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: pcm,
  });
  const json = await r.json();
  const clientMs = performance.now() - t0;
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(json)}`);
  return { ...json, clientMs };
}

// ---------------------------------------------------------------- helpers
const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
function recall(ref, hyp) {
  const h = new Set(words(hyp));
  const r = words(ref);
  return r.length ? r.filter((w) => h.has(w)).length / r.length : 0;
}
function pct(v, p) {
  const s = [...v].sort((a, b) => a - b);
  const k = (s.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}
const r1 = (x) => Math.round(x * 10) / 10;
function stats(v) {
  return { p50: r1(pct(v, 0.5)), p90: r1(pct(v, 0.9)), min: r1(Math.min(...v)), max: r1(Math.max(...v)), n: v.length };
}

// ---------------------------------------------------------------- main
const checks = [];
const check = (name, ok, detail, hard = true) => {
  checks.push({ name, ok, detail, hard });
  console.log(`${ok ? 'PASS' : hard ? 'FAIL' : 'WARN'}  ${name}${detail ? `  (${detail})` : ''}`);
};

try {
  // 1. input audio
  let wavPath = opt('--wav', null);
  let known = null;
  if (!wavPath) {
    const fixture = join(root, 'tests', 'fixtures', 'voice', 'talk_en.wav');
    if (existsSync(fixture)) wavPath = fixture;
    else {
      wavPath = join(here, 'test.wav');
      if (!existsSync(wavPath)) {
        console.log('[test] synthesising services/stt/test.wav with Windows SAPI (16 kHz mono)');
        synthesizeSapi(wavPath, SAPI_TEXT);
      }
      known = SAPI_TEXT;
    }
  }
  const wav = parseWav(readFileSync(wavPath));
  const speech16k = resample(wav.samples, wav.rate, 16000);
  const pcm = toPcm16(speech16k);
  const audioS = speech16k.length / 16000;
  console.log(`[test] input ${relative(root, wavPath)}: ${wav.rate} Hz -> 16 kHz, ${audioS.toFixed(2)} s`);

  // 2. server
  const { health, readyMs, spawned } = await ensureServer();
  console.log(
    `[test] sidecar ready: device=${health.device} compute=${health.compute} model=${health.model}` +
      (spawned ? ` (started by test; load ${health.loadMs} ms, warm-up ${health.warmMs} ms, ready after ${readyMs} ms)` : ''),
  );
  check('sidecar on CUDA float16', health.device === 'cuda' && health.compute === 'float16', `${health.device}/${health.compute}`, false);
  // Other processes (the game's renderer, other agents' tests) share the GPU; record how busy it was.
  const gpuLoad = () => {
    const q = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu,power.draw', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
    const [util, watts] = (q.stdout || '').trim().split(/,\s*/);
    return q.status === 0 && util ? `${util}% util, ${Math.round(Number(watts))} W` : 'unknown';
  };
  const gpuBefore = gpuLoad();
  console.log(`[test] GPU load before timing (other processes): ${gpuBefore}`);

  // 3. first request (cold path after warm-up), then timed runs
  const first = await transcribe(pcm);
  console.log(`[test] first request: ${r1(first.clientMs)} ms client, ${first.ms} ms server -> "${first.text}" [${first.lang} p=${first.langProb}]`);
  const det = [];
  for (let i = 0; i < RUNS; i++) det.push(await transcribe(pcm));
  const fixed = [];
  for (let i = 0; i < RUNS; i++) fixed.push(await transcribe(pcm, { langs: 'en' }));
  const last = det[det.length - 1];
  console.log(`[test] transcript: "${last.text}"`);
  console.log(`[test] lang=${last.lang} langProb=${last.langProb} probs=${JSON.stringify(last.langProbs)} avgLogprob=${last.avgLogprob}`);
  console.log(`[test] stages (last): ${JSON.stringify(last.stages)} speechMs=${last.speechMs}`);
  const sDetC = stats(det.map((r) => r.clientMs));
  const sDetS = stats(det.map((r) => r.ms));
  const sFixC = stats(fixed.map((r) => r.clientMs));
  const sFixS = stats(fixed.map((r) => r.ms));
  console.log(`[test] latency langs=en,nl (detect): client p50 ${sDetC.p50} / p90 ${sDetC.p90} ms; server p50 ${sDetS.p50} / p90 ${sDetS.p90} ms`);
  console.log(`[test] latency langs=en (fixed):     client p50 ${sFixC.p50} / p90 ${sFixC.p90} ms; server p50 ${sFixS.p50} / p90 ${sFixS.p90} ms`);

  check('speech transcribed', last.text.length > 0, `${last.text.length} chars`);
  if (known) check('word recall >= 0.7', recall(known, last.text) >= 0.7, `recall ${recall(known, last.text).toFixed(2)}`);
  check('English wins en/nl detection', last.lang === 'en', `lang=${last.lang} p=${last.langProb}`);
  check('fixed-language run agrees', words(fixed[0].text).join(' ') === words(last.text).join(' ') || recall(last.text, fixed[0].text) >= 0.9, fixed[0].text);
  const h2 = await getHealth();
  check('detection encoder pass reused', (h2?.encoderReuseHits ?? 0) >= RUNS, `${h2?.encoderReuseHits} hits`, false);

  // 4. silence and noise must not hallucinate
  const silence = Buffer.alloc(2 * 16000 * 2);
  const sil = await transcribe(silence);
  check('2 s silence -> empty text', sil.text === '', `"${sil.text}" in ${sil.ms} ms`);
  let seed = 12345;
  const noise = new Float32Array(2 * 16000);
  for (let i = 0; i < noise.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise[i] = ((seed / 4294967296) * 2 - 1) * 0.08;
  }
  const noi = await transcribe(toPcm16(noise));
  check('2 s white noise -> empty text', noi.text === '', `"${noi.text}" speechMs=${noi.speechMs} in ${noi.ms} ms`, false);

  // 5. report
  const failed = checks.filter((c) => !c.ok && c.hard);
  if (flag('--write-bench')) {
    const out = join(root, 'docs', 'bench', 'stt-bench.md');
    mkdirSync(join(root, 'docs', 'bench'), { recursive: true });
    const md = [
      '# STT sidecar benchmark',
      '',
      `Measured ${new Date().toISOString()} by \`node services/stt/test_stt.mjs --write-bench\` on this host (RTX 5090).`,
      '',
      `- Model: faster-whisper \`${health.model}\`, device \`${health.device}\`, compute \`${health.compute}\` (faster-whisper ${health.versions?.fasterWhisper}, ctranslate2 ${health.versions?.ctranslate2}).`,
      `- Startup: model load ${health.loadMs ?? 'n/a'} ms, warm-up ${health.warmMs ?? 'n/a'} ms.`,
      `- Clip: ${audioS.toFixed(2)} s of synthetic speech (${known ? 'Windows SAPI' : relative(root, wavPath)}), sent as raw PCM16LE 16 kHz over HTTP on localhost, ${RUNS} sequential runs each.`,
      `- GPU load from other processes just before timing: ${gpuBefore}. Encoder reuse hits: ${h2?.encoderReuseHits ?? 0}.`,
      '',
      '| Mode | client p50 ms | client p90 ms | server p50 ms | server p90 ms | min-max client ms |',
      '|---|---|---|---|---|---|',
      `| langs=en,nl (VAD + restricted detection + greedy) | ${sDetC.p50} | ${sDetC.p90} | ${sDetS.p50} | ${sDetS.p90} | ${sDetC.min}-${sDetC.max} |`,
      `| langs=en (fixed language) | ${sFixC.p50} | ${sFixC.p90} | ${sFixS.p50} | ${sFixS.p90} | ${sFixC.min}-${sFixC.max} |`,
      '',
      `- Stages of the last en,nl run: VAD ${last.stages.vadMs} ms, language ${last.stages.langMs} ms, decode ${last.stages.asrMs} ms.`,
      `- First request after warm-up: ${r1(first.clientMs)} ms client.`,
      `- Detection on the English clip: lang=${last.lang}, restricted probability ${last.langProb}.`,
      `- 2 s silence: text ${sil.text === '' ? 'empty' : 'NOT empty'} in ${sil.ms} ms. 2 s white noise: text ${noi.text === '' ? 'empty' : 'NOT empty'} in ${noi.ms} ms.`,
      `- Checks: ${checks.filter((c) => c.ok).length}/${checks.length} passed${failed.length ? `, FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}.`,
      '',
    ].join('\n');
    writeFileSync(out, md);
    console.log(`[test] wrote ${relative(root, out)}`);
  }
  console.log(failed.length ? `\nSTT TEST FAILED (${failed.length} hard check(s))` : '\nSTT TEST OK');
  stopChild();
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error(`STT TEST ERROR: ${e.message}`);
  stopChild();
  process.exit(1);
}
