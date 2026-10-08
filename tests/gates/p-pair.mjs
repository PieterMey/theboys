#!/usr/bin/env node
// Gate P (integrator): run several probe commands at once inside ONE gpu-guard slot (e.g. the v1.1 and v1.2 clients
// side by side, each its own browser). Commands are separated by '::'; exit code = the worst child exit code.
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/gates/p-pair.mjs node a.ts --x 1 :: node b.ts --y 2
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const cmds = [];
let cur = [];
for (const a of argv) { if (a === '::') { if (cur.length) cmds.push(cur); cur = []; } else cur.push(a); }
if (cur.length) cmds.push(cur);
if (!cmds.length) { console.error('usage: p-pair.mjs <cmd...> :: <cmd...>'); process.exit(2); }
const codes = await Promise.all(cmds.map((c) => new Promise((res) => {
  const ch = spawn(c[0] === 'node' ? process.execPath : c[0], c.slice(1), { stdio: 'inherit', env: process.env });
  ch.on('exit', (code) => res(code ?? 1));
  ch.on('error', () => res(1));
})));
process.exit(Math.max(...codes));
