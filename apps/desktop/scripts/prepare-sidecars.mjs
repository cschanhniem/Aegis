#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
// Cross-platform sidecar staging for the AEGIS desktop bundle.
//
// Same job as the older prepare-sidecars.sh: build Cockpit standalone,
// build the gateway, install the gateway's prod deps with a real
// (non-symlink) copy of @agentguard/core-schema, and stage a portable
// Node runtime alongside both — all into apps/desktop/sidecar-stage/.
//
// What's new: rewritten in Node so it runs on Windows (where bash is
// available via Git Bash but cp -R, tar -xzf, and curl behave subtly
// differently) without forking.
//
// Called by tauri.conf.json#beforeBuildCommand and by every CI job.
// ─────────────────────────────────────────────────────────────────

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT    = path.resolve(DESKTOP_ROOT, '..', '..');
const STAGE        = path.join(DESKTOP_ROOT, 'sidecar-stage');
const NODE_CACHE   = path.join(DESKTOP_ROOT, '.node-cache');

// ── tiny logger ────────────────────────────────────────────────────
const GREEN = process.stdout.isTTY ? '\x1b[0;32m' : '';
const YEL   = process.stdout.isTTY ? '\x1b[0;33m' : '';
const RESET = process.stdout.isTTY ? '\x1b[0m'    : '';
const log  = (msg) => console.log(`${GREEN}▸${RESET} ${msg}`);
const warn = (msg) => console.warn(`${YEL}!${RESET} ${msg}`);
const die  = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

// ── shell helpers ──────────────────────────────────────────────────
function run(cmd, cwd, env) {
  // Node 20+ on Windows refuses to spawnSync .cmd/.bat shims without
  // shell: true (CVE-2024-27980 hardening). npm on Windows is npm.cmd,
  // so we need the shell for it to work at all. Other platforms keep
  // shell: false to avoid the cost + quoting surprises.
  const needsShell = process.platform === 'win32';
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: needsShell,
  });
  if (res.error) die(`${cmd.join(' ')}: ${res.error.message}`);
  if (res.status !== 0) die(`${cmd.join(' ')} exited with ${res.status}`);
}

function rimraf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: false });
}

function copyFile(src, dst) {
  fs.copyFileSync(src, dst);
}

// Pick the host-appropriate npm binary. On Windows it's `npm.cmd`.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ── 0. clean stage ─────────────────────────────────────────────────
rimraf(STAGE);
mkdirp(STAGE);
mkdirp(NODE_CACHE);

// ── 1. Cockpit standalone ──────────────────────────────────────────
log('Building Cockpit standalone');
run([NPM, 'run', 'build'], path.join(REPO_ROOT, 'apps', 'compliance-cockpit'));

log('Staging Cockpit');
const cockpitDst = path.join(STAGE, 'cockpit-static');
mkdirp(cockpitDst);
copyDir(
  path.join(REPO_ROOT, 'apps', 'compliance-cockpit', '.next', 'standalone'),
  cockpitDst,
);
// Standalone omits public/ and .next/static/ — copy them in by hand.
copyDir(
  path.join(REPO_ROOT, 'apps', 'compliance-cockpit', 'public'),
  path.join(cockpitDst, 'apps', 'compliance-cockpit', 'public'),
);
copyDir(
  path.join(REPO_ROOT, 'apps', 'compliance-cockpit', '.next', 'static'),
  path.join(cockpitDst, 'apps', 'compliance-cockpit', '.next', 'static'),
);

// ── 2. core-schema (gateway's workspace dep) ───────────────────────
log('Building core-schema (workspace dep of gateway)');
run([NPM, 'run', 'build'], path.join(REPO_ROOT, 'packages', 'core-schema'));

log('Staging core-schema as a local package next to gateway-bin/');
const coreStage = path.join(STAGE, 'core-schema');
mkdirp(coreStage);
copyDir(
  path.join(REPO_ROOT, 'packages', 'core-schema', 'dist'),
  path.join(coreStage, 'dist'),
);
copyFile(
  path.join(REPO_ROOT, 'packages', 'core-schema', 'package.json'),
  path.join(coreStage, 'package.json'),
);

// ── 3. gateway ─────────────────────────────────────────────────────
log('Building gateway');
run([NPM, 'run', 'build'], path.join(REPO_ROOT, 'packages', 'gateway-mcp'));

log('Staging gateway');
const gwDst = path.join(STAGE, 'gateway-bin');
mkdirp(gwDst);
copyDir(
  path.join(REPO_ROOT, 'packages', 'gateway-mcp', 'dist'),
  gwDst,
);
copyFile(
  path.join(REPO_ROOT, 'packages', 'gateway-mcp', 'package.json'),
  path.join(gwDst, 'package.json'),
);

// --install-links turns each file: dep (i.e. @agentguard/core-schema)
// into a real directory rather than a workspace symlink. Without this
// the Tauri bundler can't follow it and the build fails.
log('Installing gateway production deps (--install-links)');
run(
  [NPM, 'install', '--omit=dev', '--install-links', '--no-audit', '--no-fund', '--silent'],
  gwDst,
);

log('Cleaning staged core-schema (no longer needed after install)');
rimraf(coreStage);

// ── 4. portable Node runtime ───────────────────────────────────────
const NODE_VERSION = process.version.replace(/^v/, '');
const archMap = { x64: 'x64', arm64: 'arm64' };
const arch = archMap[process.arch];
if (!arch) die(`unsupported arch ${process.arch}`);

let nodeArch;
let archiveFormat;
switch (process.platform) {
  case 'darwin':
    nodeArch = `darwin-${arch}`;
    archiveFormat = 'tar.gz';
    break;
  case 'linux':
    nodeArch = `linux-${arch}`;
    archiveFormat = 'tar.gz';
    break;
  case 'win32':
    // Node ships Windows builds as a .zip (no -arm64-win, only -x64
    // and -arm64-win — both call it `win` not `windows`).
    nodeArch = `win-${arch}`;
    archiveFormat = 'zip';
    break;
  default:
    die(`unsupported platform ${process.platform}`);
}

const tarballName = `node-v${NODE_VERSION}-${nodeArch}.${archiveFormat}`;
const tarballUrl  = `https://nodejs.org/dist/v${NODE_VERSION}/${tarballName}`;
const tarballPath = path.join(NODE_CACHE, tarballName);

async function download(url, dst) {
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dst);
    const get = (u, attempt = 0) => {
      https.get(u, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          if (attempt > 5) return reject(new Error(`too many redirects for ${url}`));
          return get(res.headers.location, attempt + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${u}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    get(url);
  });
}

if (!fs.existsSync(tarballPath)) {
  log(`Downloading Node v${NODE_VERSION} (${nodeArch})`);
  await download(tarballUrl, tarballPath);
} else {
  log(`Using cached Node v${NODE_VERSION} tarball`);
}

const runtimeDst = path.join(STAGE, 'node-runtime');
mkdirp(runtimeDst);

if (archiveFormat === 'tar.gz') {
  // tar is built into Linux, macOS, and Windows 10+ — no Node-side
  // streaming decoder required.
  run(['tar', '-xzf', tarballPath, '-C', runtimeDst, '--strip-components=1']);
} else {
  // Windows .zip — use built-in tar (Win10+ supports zip via tar -xf),
  // fall back to PowerShell Expand-Archive.
  const tarRes = spawnSync('tar', ['-xf', tarballPath, '-C', runtimeDst, '--strip-components=1'], {
    stdio: 'inherit',
    shell: false,
  });
  if (tarRes.status !== 0) {
    warn('built-in tar failed on .zip, falling back to PowerShell');
    // Expand-Archive places contents under a versioned subdir; flatten it.
    const tmp = path.join(NODE_CACHE, `extract-${Date.now()}`);
    mkdirp(tmp);
    run(['powershell', '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath "${tarballPath}" -DestinationPath "${tmp}" -Force`]);
    const inner = fs.readdirSync(tmp)[0];
    if (!inner) die(`zip extraction produced no top-level directory`);
    copyDir(path.join(tmp, inner), runtimeDst);
    rimraf(tmp);
  }
}

// Verify node binary actually runs.
const nodeBin = process.platform === 'win32'
  ? path.join(runtimeDst, 'node.exe')
  : path.join(runtimeDst, 'bin', 'node');
if (!fs.existsSync(nodeBin)) {
  die(`Node binary missing after extraction: ${nodeBin}`);
}
const version = execSync(`"${nodeBin}" --version`).toString().trim();
log(`Staged Node ${version}`);

log(`Sidecars staged under ${STAGE}`);
