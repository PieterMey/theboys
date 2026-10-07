// Packs the DEAD AIR desktop shell for Windows x64 into apps/desktop/out/win-unpacked/ (DeadAir.exe + resources):
// the folder you upload as the Steam depot (see docs/STEAM.md). Nothing here touches apps/client/dist.
//
//   node apps/desktop/scripts/pack.mjs [options]
//     --server-url URL     default server baked into the packaged config.json (e.g. https://play.example.com)
//     --bundled            ship the client build inside the app (mode "bundled"); default: remote
//     --client-dist DIR    with --bundled: copy this existing client build (e.g. apps/client/dist, the build the
//                          server serves, so build ids match) instead of building one into a temp folder
//     --app-id N           Steam app id baked into config.json (default: config.json's, 480 = Spacewar for dev)
//     --no-steam           steam.enabled=false in the packaged config
//     --overlay            steam.overlay=true in the packaged config (in-process GPU; see docs/STEAM.md)
//     --keep-stage         keep the staged app folder (%TEMP%\deadair-desktop-stage) for inspection
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const DESKTOP = resolve(import.meta.dirname, '..');
const REPO = resolve(DESKTOP, '../..');
const OUT = join(DESKTOP, 'out');
// staged OUTSIDE the repo: inside the npm workspace electron-builder falls back to the workspace root's
// node_modules and packs every server dependency into app.asar (measured: 178 MB asar instead of ~2 MB)
const STAGE = join(tmpdir(), 'deadair-desktop-stage');
const require = createRequire(join(DESKTOP, 'package.json'));

const argv = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => argv.includes(`--${name}`);
/** @param {string} name */
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
};

const t0 = Date.now();
const step = (/** @type {string} */ m) => console.log(`[pack ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ---------------------------------------------------------------- config for the packaged app
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
const baseCfg = JSON.parse(readFileSync(join(DESKTOP, 'config.json'), 'utf8'));
const cfg = structuredClone(baseCfg);
const serverUrl = opt('server-url');
if (serverUrl) {
  const u = new URL(/^[a-z]+:\/\//i.test(serverUrl) ? serverUrl : `https://${serverUrl}`);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`--server-url must be http(s): ${serverUrl}`);
  cfg.serverUrl = u.origin;
}
const bundled = flag('bundled');
cfg.mode = bundled ? 'bundled' : 'remote';
const appId = opt('app-id');
if (appId) {
  if (!/^\d+$/.test(appId)) throw new Error(`--app-id must be a number: ${appId}`);
  cfg.steam.appId = Number(appId);
}
if (flag('no-steam')) cfg.steam.enabled = false;
if (flag('overlay')) cfg.steam.overlay = true;

// ---------------------------------------------------------------- icons
step('icons');
execFileSync(process.execPath, [join(DESKTOP, 'scripts/make-icons.mjs'), '--if-missing'], { stdio: 'inherit' });

// ---------------------------------------------------------------- stage the app folder
step(`stage ${STAGE}`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(join(DESKTOP, 'src'), join(STAGE, 'src'), { recursive: true });
cpSync(join(DESKTOP, 'static'), join(STAGE, 'static'), { recursive: true });
mkdirSync(join(STAGE, 'build'), { recursive: true });
cpSync(join(DESKTOP, 'build/icon.png'), join(STAGE, 'build/icon.png'));
writeFileSync(join(STAGE, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
// shell build id = hash of the shell's code + pages + packaged config (main.cjs logs it: tells builds apart in
// desktop.log without bumping the version)
{
  const h = createHash('sha256');
  /** @param {string} d */
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${relative(STAGE, p).split('\\').join('/')}\0`).update(readFileSync(p));
    }
  };
  walk(join(STAGE, 'src'));
  walk(join(STAGE, 'static'));
  h.update(readFileSync(join(STAGE, 'config.json')));
  const build = h.digest('hex').slice(0, 12);
  writeFileSync(join(STAGE, 'shell-build.json'), `${JSON.stringify({ build, packedAt: new Date().toISOString() }, null, 2)}\n`);
  step(`shell build ${build}`);
}
writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify({
  name: 'dead-air',
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  private: true,
  type: 'commonjs',
  main: 'src/main.cjs',
}, null, 2)}\n`);

// steamworks.js: a trimmed copy (win64 binary + steam_api64.dll side by side; asar-unpacked below)
const swDir = resolve(require.resolve('steamworks.js/package.json'), '..');
const swPkg = JSON.parse(readFileSync(join(swDir, 'package.json'), 'utf8'));
const vend = join(STAGE, 'vendor/steamworks.js');
mkdirSync(join(vend, 'dist/win64'), { recursive: true });
writeFileSync(join(vend, 'package.json'), `${JSON.stringify({ name: swPkg.name, version: swPkg.version, main: swPkg.main, license: swPkg.license }, null, 2)}\n`);
for (const f of ['index.js', 'LICENSE']) cpSync(join(swDir, f), join(vend, f));
for (const f of ['steamworksjs.win32-x64-msvc.node', 'steam_api64.dll']) cpSync(join(swDir, 'dist/win64', f), join(vend, 'dist/win64', f));

// bundled client
if (bundled) {
  let src = opt('client-dist') ? resolve(opt('client-dist') ?? '') : '';
  let tmp = '';
  if (!src) {
    tmp = mkdtempSync(join(tmpdir(), 'deadair-client-'));
    step(`vite build -> ${tmp}`);
    execFileSync(process.execPath, [join(REPO, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'apps/client/vite.config.ts', '--outDir', tmp, '--emptyOutDir'], { cwd: REPO, stdio: 'inherit' });
    src = tmp;
  }
  if (!existsSync(join(src, 'index.html'))) throw new Error(`no client build at ${src}`);
  step(`client ${src} -> stage/client (without source maps)`);
  cpSync(src, join(STAGE, 'client'), {
    recursive: true,
    filter: (f) => !f.endsWith('.map') && !/voicetest\.html$/.test(f),
  });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  const b = JSON.parse(readFileSync(join(STAGE, 'client/build.json'), 'utf8'));
  step(`bundled client build ${b.build}`);
}

// ---------------------------------------------------------------- electron-builder (win, dir target)
const electronDir = resolve(require.resolve('electron/package.json'), '..');
const electronVersion = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version;
if (!existsSync(join(electronDir, 'dist/electron.exe'))) {
  throw new Error('Electron binary missing: run `node node_modules/electron/install.js` once (Electron 44 has no postinstall)');
}
const { build, Platform, Arch } = require('electron-builder');
step(`electron-builder (electron ${electronVersion}, win x64 dir)`);
rmSync(join(OUT, 'win-unpacked'), { recursive: true, force: true });
await build({
  projectDir: STAGE,
  targets: Platform.WINDOWS.createTarget('dir', Arch.x64),
  publish: 'never',
  config: {
    appId: 'com.deadair.game',
    productName: pkg.productName,
    executableName: 'DeadAir',
    copyright: `Copyright © ${new Date().getFullYear()} DEAD AIR`,
    electronVersion,
    electronDist: join(electronDir, 'dist'),
    directories: { output: OUT, buildResources: join(DESKTOP, 'build') },
    files: ['**/*'],
    asar: true,
    asarUnpack: ['vendor/steamworks.js/dist/win64/**'],
    npmRebuild: false,
    nodeGypRebuild: false,
    electronLanguages: ['en-US'],
    includePdb: false,
    removePackageScripts: true,
    win: {
      target: [{ target: 'dir', arch: ['x64'] }],
      icon: join(DESKTOP, 'build/icon.ico'),
      signExecutable: false, // no code signing (Steam does not need it); icon + version info are still written
      legalTrademarks: 'DEAD AIR',
    },
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    },
  },
});

// ---------------------------------------------------------------- summary
const appOut = join(OUT, 'win-unpacked');
const exe = join(appOut, 'DeadAir.exe');
if (!existsSync(exe)) throw new Error(`build finished but ${exe} is missing`);
// the unpacked Electron dist carries Electron's sample app; never ship it
rmSync(join(appOut, 'resources/default_app.asar'), { force: true });
const asarList = require('@electron/asar').listPackage(join(appOut, 'resources/app.asar'), {});
const stray = asarList.filter((/** @type {string} */ f) => /^[\\/]node_modules[\\/]/.test(f));
if (stray.length) throw new Error(`app.asar contains node_modules (${stray.length} entries, e.g. ${stray[0]}): the stage leaked into the workspace`);
/** @param {string} d @returns {{ bytes: number, files: number }} */
const du = (d) => {
  let bytes = 0;
  let files = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) {
      const s = du(p);
      bytes += s.bytes;
      files += s.files;
    } else {
      bytes += statSync(p).size;
      files++;
    }
  }
  return { bytes, files };
};
const size = du(appOut);
const unpackedSw = join(appOut, 'resources/app.asar.unpacked/vendor/steamworks.js/dist/win64');
if (!existsSync(join(unpackedSw, 'steam_api64.dll')) || !existsSync(join(unpackedSw, 'steamworksjs.win32-x64-msvc.node'))) {
  throw new Error(`steamworks.js native files are not unpacked next to each other in ${unpackedSw}`);
}
const shellBuild = JSON.parse(readFileSync(join(STAGE, 'shell-build.json'), 'utf8')).build;
if (!flag('keep-stage')) rmSync(STAGE, { recursive: true, force: true });
step(`done: ${exe}`);
console.log(JSON.stringify({ exe, dir: appOut, shellBuild, mode: cfg.mode, serverUrl: cfg.serverUrl, steamAppId: cfg.steam.appId, steam: cfg.steam.enabled, overlay: cfg.steam.overlay, files: size.files, mb: Math.round(size.bytes / 1e5) / 10 }, null, 2));
