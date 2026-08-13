#!/usr/bin/env node
/**
 * Publish the README images to the public assets repository.
 *
 * The product repo is private, and the Marketplace fetches README images
 * anonymously over the public internet — it cannot read the VSIX and has no
 * GitHub session. So the images it renders have to live somewhere public,
 * which is what StephaneBerthoz/sand-forge-assets is for.
 *
 * That split is exactly the kind of thing that silently drifts: regenerate a
 * screenshot here, forget to push it there, and the listing keeps showing last
 * quarter's UI while the file on disk is correct. This script makes the push a
 * command instead of a memory, and `--check` makes the drift a release failure
 * — it compares bytes, not just reachability, so an outdated remote copy fails
 * just as loudly as a missing one.
 *
 *   node scripts/sync-assets-repo.mjs           # push changed images
 *   node scripts/sync-assets-repo.mjs --check   # exit 1 if remote is stale
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

const ASSETS_REPO = 'StephaneBerthoz/sand-forge-assets';
const ASSETS_BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${ASSETS_REPO}/${ASSETS_BRANCH}`;
const LOCAL_DIR = join(ROOT, 'assets', 'screenshots');

/** sha256 of a buffer, hex. */
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Images the Marketplace listing renders, newest state on disk. */
function localAssets() {
  return readdirSync(LOCAL_DIR)
    .filter((name) => /\.(png|gif|jpe?g|webp)$/i.test(name))
    .sort();
}

/** Compare every local image against the copy the Marketplace would fetch. */
async function check() {
  const stale = [];

  for (const name of localAssets()) {
    const local = readFileSync(join(LOCAL_DIR, name));
    let remote;
    try {
      const response = await fetch(`${RAW_BASE}/${name}`);
      if (!response.ok) {
        stale.push(`${name} → HTTP ${response.status} (never published)`);
        continue;
      }
      remote = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      stale.push(`${name} → ${error instanceof Error ? error.message : 'fetch failed'}`);
      continue;
    }

    if (digest(local) !== digest(remote)) {
      stale.push(`${name} → published copy differs from the file on disk`);
    }
  }

  if (stale.length > 0) {
    console.error(`Assets repo out of date (${stale.length}):\n`);
    for (const entry of stale) console.error(`  ✗ ${entry}`);
    console.error(`\nRun 'pnpm sync:assets' to publish them to ${ASSETS_REPO}.`);
    process.exit(1);
  }

  console.log(`Assets repo in sync: ${localAssets().length} image(s) match ${ASSETS_REPO}`);
}

/** Copy the local images into a clone of the assets repo and push. */
function push() {
  const workdir = mkdtempSync(join(tmpdir(), 'sf-assets-'));
  const git = (...args) =>
    execFileSync('git', ['-C', workdir, ...args], { encoding: 'utf-8', stdio: 'pipe' });

  try {
    execFileSync(
      'git',
      ['clone', '--depth', '1', `https://github.com/${ASSETS_REPO}.git`, workdir],
      { stdio: 'pipe' },
    );

    for (const name of localAssets()) {
      copyFileSync(join(LOCAL_DIR, name), join(workdir, name));
    }

    if (git('status', '--porcelain').trim() === '') {
      console.log(`Assets repo already up to date (${ASSETS_REPO}).`);
      return;
    }

    git('add', '-A');
    git('commit', '-m', 'chore(assets): sync screenshots from sand-forge');
    git('push', 'origin', ASSETS_BRANCH);
    console.log(`Pushed ${localAssets().length} image(s) to ${ASSETS_REPO}.`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

if (CHECK_ONLY) {
  await check();
} else {
  push();
}
