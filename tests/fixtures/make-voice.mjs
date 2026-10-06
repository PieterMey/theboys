#!/usr/bin/env node
// Generates the fake-mic fixtures in tests/fixtures/voice/ (16-bit PCM mono 48 kHz):
// SAPI speech (make-voice.ps1) scaled to target speech-active RMS levels, plus silence and sine tones.
//   node tests/fixtures/make-voice.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const OUT = join(HERE, 'voice');
const SR = 48000;
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'deadair-voice-'));

function say(text, rate = 0) {
  const out = join(tmp, `s${Math.abs(hash(text + rate))}.wav`);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'make-voice.ps1'), '-Text', text, '-Out', out, '-Rate', String(rate)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`SAPI failed for "${text}": ${r.stderr || r.stdout}`);
  if (!say.voice) say.voice = (r.stdout.match(/voice=(.*)/) ?? [])[1]?.trim();
  return readWav(out);
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

function readWav(path) {
  const b = readFileSync(path);
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt || fmt.ch !== 1 || fmt.bits !== 16 || fmt.sr !== SR) throw new Error(`unexpected wav format ${JSON.stringify(fmt)}`);
      const n = size >> 1;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return f;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

function writeWav(path, f) {
  const n = f.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))), 44 + i * 2);
  writeFileSync(path, b);
}

const silence = (sec) => new Float32Array(Math.round(sec * SR));
function concat(parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** trim leading/trailing near-silence */
function trim(f) {
  let a = 0, b = f.length - 1;
  while (a < b && Math.abs(f[a]) < 0.003) a++;
  while (b > a && Math.abs(f[b]) < 0.003) b--;
  return f.slice(Math.max(0, a - 480), Math.min(f.length, b + 480));
}
/** RMS (dBFS, sine-referenced to full-scale RMS of 1.0) over 20 ms frames within 30 dB of the loudest frame */
function activeRmsDb(f) {
  const F = 960;
  const frames = [];
  for (let i = 0; i + F <= f.length; i += F) {
    let s = 0;
    for (let j = 0; j < F; j++) s += f[i + j] * f[i + j];
    frames.push(s / F);
  }
  const max = Math.max(...frames);
  const act = frames.filter((e) => e > max / 1000);
  const mean = act.reduce((s, e) => s + e, 0) / Math.max(1, act.length);
  return 10 * Math.log10(mean || 1e-12);
}
/** soft limiter above 0.8 so loud targets don't hard-clip */
const limit = (x) => (Math.abs(x) <= 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((Math.abs(x) - 0.8) / 0.2)));
function toLevel(f, targetDb) {
  let g = 10 ** ((targetDb - activeRmsDb(f)) / 20);
  let out = f;
  for (let it = 0; it < 6; it++) {
    out = f.map((x) => limit(x * g));
    const err = targetDb - activeRmsDb(out);
    if (Math.abs(err) < 0.25) break;
    g *= 10 ** (err / 20);
  }
  return out;
}
function tone(hz, sec, db) {
  const amp = 10 ** (db / 20) * Math.SQRT2;
  const f = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < f.length; i++) f[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return f;
}

const PHRASES = ['meet me in the boiler room', 'go to the chapel', 'the code is four seven one nine'];
const chatter = concat(PHRASES.flatMap((p) => [trim(say(p)), silence(0.45)]));
const padTo = (f, sec) => (f.length >= sec * SR ? f : concat([f, silence(sec - f.length / SR)]));
const talkBase = padTo(concat([silence(0.3), chatter]), 6);

const files = {
  'talk_en.wav': toLevel(talkBase, -20),
  'whisper.wav': toLevel(talkBase, -34),
  'shout.wav': toLevel(talkBase, -8),
  'callsign_boiler.wav': toLevel(padTo(concat([silence(0.3), trim(say('boiler, meet in boiler')), silence(0.6)]), 3), -20),
  'silence.wav': silence(5),
  'tone440.wav': tone(440, 5, -20),
  'tone880.wav': tone(880, 5, -20),
};
for (const [name, f] of Object.entries(files)) {
  writeWav(join(OUT, name), f);
  const db = name.startsWith('silence') ? -Infinity : activeRmsDb(f);
  console.log(`${name.padEnd(22)} ${(f.length / SR).toFixed(2)} s  active RMS ${db.toFixed(1)} dBFS`);
}
console.log(`SAPI voice: ${say.voice ?? 'default'}`);
rmSync(tmp, { recursive: true, force: true });
