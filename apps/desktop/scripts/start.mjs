// Dev launcher: `npm start -w @dead-air/desktop` (repo root) / `npm start` (apps/desktop). Runs the shell from source
// with the installed Electron; extra arguments pass through (e.g. -- --server=http://127.0.0.1:3601 --devtools).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const DESKTOP = resolve(import.meta.dirname, '..');
const require = createRequire(join(DESKTOP, 'package.json'));
const exe = join(resolve(require.resolve('electron/package.json'), '..'), 'dist/electron.exe');
if (!existsSync(exe)) {
  console.error('Electron binary missing: run `node node_modules/electron/install.js` once (Electron 44 has no postinstall).');
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // VS Code terminals set it; electron.exe would start as plain Node
const child = spawn(exe, [DESKTOP, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
