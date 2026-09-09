#!/usr/bin/env node
/**
 * Fail the release when the shipped screenshots are older than the code that
 * produces them.
 *
 * `packages/webview/e2e/screenshots.spec.ts:17` has told readers since v1.16.0
 * that this file "fails the release if what ships no longer matches what this
 * file produces", and the v1.16.0 changelog repeated the promise. The file did
 * not exist. That is the sharpest instance of the pattern this repo keeps
 * hitting: the gate is written down, described as blocking, and never built —
 * so nothing was watching when `forge-flow.gif`, the first image on the
 * Marketplace listing, went on showing a navigation sidebar deleted in 1.10 and
 * a status bar reading "SandForge v0.0.0-e2e".
 *
 * Byte-comparing against a fresh Playwright run would need browsers and a
 * display, which a release check cannot assume. Staleness is the property that
 * actually matters and git already records it: if the generator changed after
 * an image was last written, that image was produced by a generator that no
 * longer exists.
 *
 *   node scripts/check-screenshots.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = 'packages/webview/e2e/screenshots.spec.ts';
const SHOTS_DIR = 'assets/screenshots';

/** SHA of the last commit touching `path`, or null if untracked. */
function lastCommit(path) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%H', '--', path], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/**
 * Is `ancestor` the same commit as `descendant`, or earlier in its history?
 *
 * Wall-clock comparison was the obvious first cut and it is wrong: images and
 * the generator that produces them are normally committed together, seconds
 * apart in either order, which made every release look stale. What actually
 * says "this image predates the current generator" is commit reachability.
 */
function isAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Screenshots the two READMEs actually render, as repo-relative paths. */
function referencedShots() {
  const found = new Set();
  for (const readme of ['README.md', 'packages/extension/README.md']) {
    const path = join(ROOT, readme);
    if (!existsSync(path)) continue;
    const markdown = readFileSync(path, 'utf-8');
    for (const [, url] of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      const name = url.split('/').pop();
      if (name && /\.(png|gif|jpe?g|webp)$/i.test(name)) found.add(`${SHOTS_DIR}/${name}`);
    }
  }
  return [...found].sort();
}

const failures = [];
const shots = referencedShots();

if (shots.length === 0) {
  failures.push('no screenshot is referenced by either README — the listing has lost its proof');
}

if (!existsSync(join(ROOT, GENERATOR))) {
  failures.push(`${GENERATOR} is gone; this gate is aimed at nothing`);
}

const generatorCommit = lastCommit(GENERATOR);

for (const shot of shots) {
  const abs = join(ROOT, shot);

  if (!existsSync(abs)) {
    failures.push(`${shot} is referenced by a README and is not on disk`);
    continue;
  }
  if (statSync(abs).size === 0) {
    failures.push(`${shot} is a zero-byte file`);
    continue;
  }

  const shotCommit = lastCommit(shot);
  if (shotCommit === null) continue; // never committed yet — this run is producing it
  if (generatorCommit !== null && !isAncestor(generatorCommit, shotCommit)) {
    failures.push(
      `${shot} was last written before ${relative('.', GENERATOR)} last changed ` +
        `(${generatorCommit.slice(0, 8)} is not reachable from ${shotCommit.slice(0, 8)}) — ` +
        `it was produced by a generator that no longer exists`,
    );
  }
}

if (failures.length > 0) {
  console.error(`Screenshots: ${failures.length} problem(s)\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    '\nRegenerate them, then commit the images with the change that moved the generator:\n' +
      '  cd packages/webview && SCREENSHOTS=1 npx playwright test screenshots.spec.ts',
  );
  process.exit(1);
}

console.log(`Screenshots: ${shots.length} referenced, all present and newer than the generator`);
