#!/usr/bin/env node
/**
 * Verify every image the READMEs reference actually reaches a reader.
 *
 * Two independent ways this breaks, both of which shipped:
 *
 *  1. The file is gone or was never committed. The GitHub README uses relative
 *     paths, so a missing file renders as a broken-image icon.
 *
 *  2. The URL is unreachable to an anonymous visitor. The Marketplace renders
 *     `packages/extension/README.md` on its own site and fetches images over the
 *     public internet — it has no access to the VSIX contents and no GitHub
 *     session. Every screenshot pointed at raw.githubusercontent.com on a
 *     PRIVATE repo, so all six returned 404 and the listing showed six broken
 *     images. Nothing in the build noticed, because the files were all present
 *     on disk.
 *
 * Local paths are checked against the filesystem. Remote URLs are fetched
 * anonymously — the same view a Marketplace visitor gets, not the maintainer's.
 *
 *   node scripts/check-readme-images.mjs           # report and exit 1 on failure
 *   node scripts/check-readme-images.mjs --local   # skip the network checks
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ONLY = process.argv.includes('--local');

/** READMEs to scan, with the directory their relative links resolve against. */
const TARGETS = [
  // GitHub renders this one to signed-in collaborators of a private repo, so a
  // link only they can resolve is fine here; the files still have to exist.
  { file: 'README.md', base: ROOT, anonymous: false },
  // The Marketplace renders this one on its own site to the whole internet.
  { file: 'packages/extension/README.md', base: join(ROOT, 'packages', 'extension'), anonymous: true },
];

/** Every markdown image reference in a document. */
function extractImages(markdown) {
  const images = [];
  const pattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    images.push(match[1]);
  }
  return images;
}

/** Is this URL reachable without credentials? */
async function isReachable(url) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow' });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : 'fetch failed' };
  }
}

const failures = [];
let checked = 0;

for (const { file, base, anonymous } of TARGETS) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;

  for (const url of extractImages(readFileSync(path, 'utf-8'))) {
    checked += 1;

    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (LOCAL_ONLY || !anonymous) continue;
      const { ok, status } = await isReachable(url);
      if (!ok) {
        failures.push(`${file}: ${url} → ${status} (a Marketplace visitor sees a broken image)`);
      }
      continue;
    }

    // Shields.io-style badges and data URIs are out of scope; everything else
    // is a path that must exist on disk.
    if (url.startsWith('data:')) continue;
    if (!existsSync(resolve(base, url))) {
      failures.push(`${file}: ${url} → file not found`);
    }
  }
}

if (failures.length > 0) {
  console.error(`README images: ${failures.length} of ${checked} unreachable\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    '\nThe Marketplace fetches these anonymously over the public internet. If the\n' +
      'repository is private, either publish the images somewhere public or make\n' +
      'the repository public — shipping them inside the VSIX does not help, the\n' +
      'Marketplace renders the README on its own site.',
  );
  process.exit(1);
}

console.log(`README images: ${checked} reachable`);
