#!/usr/bin/env node
/**
 * Verify every public URL the listing exposes actually reaches a reader.
 *
 * This started life as an image-only check, written after all six screenshots
 * shipped broken: they pointed at raw.githubusercontent.com on a private repo,
 * the Marketplace fetches anonymously, and every file sat present and correct
 * on disk while the listing showed six broken images.
 *
 * The reasoning was never carried across to the links, and the same failure
 * was sitting one line below the whole time. At v1.17.0 the listing carried
 * twenty-four dead public URLs: thirteen documentation links, Releases,
 * Issues, Discussions, LICENSE and SECURITY in the Marketplace README, plus
 * `repository`, `homepage`, `bugs`, `qna` and the CI badge — image and href
 * both — in the manifest. Every one a 404 to anyone but the author. A
 * visitor who clicks "Repository" and lands on a 404 concludes the project is
 * abandoned, which costs more installs than any bug in it.
 *
 * So this checks what a stranger sees, not what the maintainer sees: images
 * AND links, in the README the Marketplace renders AND in the manifest fields
 * it turns into sidebar links.
 *
 *   node scripts/check-public-links.mjs           # report and exit 1 on failure
 *   node scripts/check-public-links.mjs --local   # skip the network checks
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ONLY = process.argv.includes('--local');

/**
 * READMEs to scan, with the directory their relative links resolve against.
 *
 * Both are checked anonymously since v1.18.0: the repository is public, so
 * "a signed-in collaborator can see it" is no longer an excuse for either.
 */
const TARGETS = [
  { file: 'README.md', base: ROOT },
  { file: 'packages/extension/README.md', base: join(ROOT, 'packages', 'extension') },
];

/** Manifest fields the Marketplace turns into links on the listing page. */
const MANIFEST = 'packages/extension/package.json';

/** Every markdown image reference in a document. */
function extractImages(markdown) {
  const images = [];
  const pattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) images.push(match[1]);
  return images;
}

/**
 * Every markdown link target that is not an image.
 *
 * `[text](url)` not preceded by `!`. Badge links wrap an image in a link, so
 * the href is a link and the src is an image; both get checked, separately.
 */
function extractLinks(markdown) {
  const links = [];
  const pattern = /(^|[^!])\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) links.push(match[2]);
  return links;
}

/** URL-bearing fields of the extension manifest, as `label → url`. */
function manifestUrls() {
  const pkg = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf-8'));
  const found = [];
  const push = (label, value) => {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) found.push([label, value]);
  };
  push('repository.url', pkg.repository?.url);
  push('homepage', pkg.homepage);
  push('bugs.url', pkg.bugs?.url);
  push('qna', pkg.qna);
  push('sponsor.url', pkg.sponsor?.url);
  for (const [i, badge] of (pkg.badges ?? []).entries()) {
    push(`badges[${i}].url`, badge.url);
    push(`badges[${i}].href`, badge.href);
  }
  return found;
}

/** Statuses that say "ask again later", not "this URL is wrong". */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is this URL reachable without credentials?
 *
 * Retries on rate limiting and transient server errors rather than failing the
 * release on them. raw.githubusercontent.com answers 429 to a burst of
 * requests, and a release gate that turns a rate limit into "this image is
 * broken" is the kind of gate this repository has been removing: it fails for
 * a reason that has nothing to do with what it is checking, and the next
 * person learns to ignore it.
 */
async function isReachable(url, attempt = 0) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow' });
    if (RETRYABLE.has(response.status) && attempt < 3) {
      await wait(1000 * 2 ** attempt);
      return isReachable(url, attempt + 1);
    }
    return { ok: response.ok, status: response.status };
  } catch (error) {
    if (attempt < 3) {
      await wait(1000 * 2 ** attempt);
      return isReachable(url, attempt + 1);
    }
    return { ok: false, status: error instanceof Error ? error.message : 'fetch failed' };
  }
}

const failures = [];
let checked = 0;

/** Anchors and mailto: are not fetchable; data: URIs carry their own payload. */
const unfetchable = (url) =>
  url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('data:');

for (const { file, base } of TARGETS) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;
  const markdown = readFileSync(path, 'utf-8');

  for (const [kind, urls] of [
    ['image', extractImages(markdown)],
    ['link', extractLinks(markdown)],
  ]) {
    for (const url of urls) {
      if (unfetchable(url)) continue;
      checked += 1;

      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (LOCAL_ONLY) continue;
        await wait(120); // 61 URLs at full speed is what earns the 429
        const { ok, status } = await isReachable(url);
        if (!ok) {
          failures.push(
            `${file}: ${url} → ${status} (a visitor sees a broken ${kind === 'image' ? 'image' : 'link'})`,
          );
        }
        continue;
      }

      // Everything else is a path that must exist on disk.
      if (!existsSync(resolve(base, url.split('#')[0]))) {
        failures.push(`${file}: ${url} → file not found`);
      }
    }
  }
}

if (!LOCAL_ONLY) {
  for (const [label, url] of manifestUrls()) {
    checked += 1;
    await wait(120);
    const { ok, status } = await isReachable(url);
    if (!ok) {
      failures.push(`${MANIFEST} ${label}: ${url} → ${status} (dead link on the listing sidebar)`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Public URLs: ${failures.length} of ${checked} unreachable\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    '\nThe Marketplace renders the README on its own site and fetches everything\n' +
      'anonymously over the public internet — it cannot read the VSIX and it has\n' +
      'no GitHub session. A URL that only resolves for someone signed in is a\n' +
      'broken link on the listing.',
  );
  process.exit(1);
}

console.log(`Public URLs: ${checked} reachable`);
