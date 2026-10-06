#!/usr/bin/env node
// Fails (exit 1) if any literal secret value from .env, or a known key prefix, appears in
// the files tracked by git (or in the given paths). Prints file names only, never values.
// Usage: node tools/check-secrets.mjs            -> scans `git ls-files` + staged files
//        node tools/check-secrets.mjs dir1 dir2  -> scans those directories recursively
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const envPath = join(root, '.env');
const secrets = [];
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (v.length >= 12) secrets.push({ name: m[1], value: v });
  }
}
const prefixRe = /(sk-ant-[A-Za-z0-9_-]{20,}|apikey_[A-Za-z0-9_-]{20,}|sk_[a-f0-9]{40,})/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.venv') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.size < 20 * 1024 * 1024) out.push(p);
  }
}

let files = [];
const args = process.argv.slice(2);
if (args.length) {
  for (const a of args) {
    const p = resolve(a);
    if (!existsSync(p)) continue;
    statSync(p).isDirectory() ? walk(p, files) : files.push(p);
  }
} else {
  const list = execSync('git ls-files --cached --others --exclude-standard', { cwd: root, encoding: 'utf8' });
  files = list.split('\n').filter(Boolean).map((f) => join(root, f));
}

const hits = [];
for (const f of files) {
  if (resolve(f) === envPath) { hits.push(`${f}  (.env itself is tracked!)`); continue; }
  let text;
  try { text = readFileSync(f, 'latin1'); } catch { continue; }
  for (const s of secrets) if (text.includes(s.value)) hits.push(`${f}  (contains value of ${s.name})`);
  if (prefixRe.test(text)) hits.push(`${f}  (matches a key-prefix pattern)`);
}
if (hits.length) {
  console.error('SECRET CHECK FAILED:\n' + [...new Set(hits)].join('\n'));
  process.exit(1);
}
console.log(`secret check ok (${files.length} files, ${secrets.length} secret values checked)`);
