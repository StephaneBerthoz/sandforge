#!/usr/bin/env node
/**
 * Write the Marketplace README and changelog from the repository's own.
 *
 * The Marketplace renders `packages/extension/README.md` and shows
 * `packages/extension/CHANGELOG.md` under its Changelog tab. Both were kept by
 * hand next to `README.md` and `changelog.md`, and the READMEs drifted: the
 * listing carried an FAQ, a walkthrough pointer and a corrected first step the
 * GitHub page lacked, and the GitHub page a Migration row the listing had
 * corrected. Two hand-kept copies of one page are two pages. So the root files
 * are the source, and this script derives the other two.
 *
 * What changes on the way to the listing:
 *
 *   - a block between `<!-- github-only:start -->` and `<!-- github-only:end -->`
 *     is dropped: the logo the listing header already shows, and what only a
 *     contributor needs (building from source, the architecture, the commands);
 *   - in the badge block `sync-readme-badges.mjs` writes into the root README,
 *     the CI badge is dropped and the version badge links to the listing;
 *   - a relative image becomes a raw.githubusercontent.com URL, and a relative
 *     link a github.com `blob/` URL for a file or `tree/` URL for a directory:
 *     the Marketplace resolves a relative path against packages/extension/,
 *     where none of them exists, and fetches anonymously, so only an absolute
 *     public URL reaches a visitor (`check-public-links.mjs` checks they do);
 *   - the result is formatted by Prettier with the repository's config, since a
 *     longer URL widens the table column it sits in, and a generated file that
 *     fails `format:check` would re-break the gate on every run.
 *
 * The changelog is copied byte for byte.
 *
 * Run after `sync-readme-badges.mjs`, which writes the badges into the root
 * README that this script reads.
 *
 *   node scripts/sync-extension-readme.mjs           # write both files
 *   node scripts/sync-extension-readme.mjs --check   # exit 1 if either has drifted
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REPO = 'StephaneBerthoz/sandforge';
export const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/master/`;
export const BLOB_BASE = `https://github.com/${REPO}/blob/master/`;
export const TREE_BASE = `https://github.com/${REPO}/tree/master/`;
export const MARKETPLACE =
  'https://marketplace.visualstudio.com/items?itemName=StephaneBerthoz.sandforge';

export const GITHUB_ONLY_START = '<!-- github-only:start -->';
export const GITHUB_ONLY_END = '<!-- github-only:end -->';

const BADGES_START = '<!-- badges:start -->';
const BADGES_END = '<!-- badges:end -->';

/** The first lines of the Marketplace README, which no visitor sees. */
export const GENERATED_NOTICE =
  '<!-- Generated from README.md by scripts/sync-extension-readme.mjs: edit README.md, then run it. -->';

/** Source → generated file, repository-relative. */
export const FILES = {
  readme: ['README.md', 'packages/extension/README.md'],
  changelog: ['changelog.md', 'packages/extension/CHANGELOG.md'],
};

/**
 * Drop every github-only block, markers included. A marker left unpaired is an
 * error, not a guess: a missing end would drop the rest of the page, a missing
 * start would publish what was meant to stay on GitHub.
 */
export function dropGithubOnly(markdown) {
  const out = [];
  let open = null;
  markdown.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === GITHUB_ONLY_START) {
      if (open !== null) {
        throw new Error(
          `line ${index + 1}: github-only block opened inside the one opened on line ${open}`,
        );
      }
      open = index + 1;
      return;
    }
    if (trimmed === GITHUB_ONLY_END) {
      if (open === null) throw new Error(`line ${index + 1}: github-only end with no start`);
      open = null;
      return;
    }
    if (open === null) out.push(line);
  });
  if (open !== null) throw new Error(`line ${open}: github-only block never closed`);
  return out.join('\n');
}

/**
 * The badge block as the listing shows it. The CI badge is left out: it reports
 * the repository's build, which is a contributor's question, while the listing
 * describes the release a visitor installs — and the listing shows a broken
 * image whenever GitHub does not serve the badge anonymously. The version badge
 * links to the listing itself. Nothing outside the block is touched.
 */
export function marketplaceBadges(markdown) {
  const start = markdown.indexOf(BADGES_START);
  const end = markdown.indexOf(BADGES_END);
  if (start === -1 || end === -1 || end < start) return markdown;
  const block = markdown
    .slice(start, end)
    .split('\n')
    .filter((line) => !/^\[!\[CI\]\(/.test(line.trim()))
    .map((line) => {
      const version = /^!\[Version\]\(([^)\s]+)\)$/.exec(line.trim());
      return version ? `[![Version](${version[1]})](${MARKETPLACE})` : line;
    })
    .join('\n');
  return markdown.slice(0, start) + block + markdown.slice(end);
}

/** A URL the Marketplace would resolve against packages/extension/. */
function isRelative(url) {
  return !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url);
}

/** `docs/./x.md#y` → `{ path: 'docs/x.md', hash: '#y' }`; a path out of the repository throws. */
function splitPath(url) {
  const hashAt = url.indexOf('#');
  const raw = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const trailingSlash = raw.endsWith('/');
  const path = posix.normalize(raw.replace(/^\/+/, ''));
  if (path === '..' || path.startsWith('../')) {
    throw new Error(`${url} points outside the repository`);
  }
  return { path: path.replace(/\/$/, ''), hash, trailingSlash };
}

/** Whether a repository-relative path is a directory of the checkout at `root`. */
const directoryIn = (root) => (path) => {
  const abs = join(root, path);
  return existsSync(abs) && statSync(abs).isDirectory();
};

/**
 * Rewrite one relative URL. An image goes to raw.githubusercontent.com, which
 * serves the bytes; a link goes to the page GitHub renders for it.
 */
function absolute(url, { image, isDirectory }) {
  if (!isRelative(url)) return url;
  const { path, hash, trailingSlash } = splitPath(url);
  if (image) return `${RAW_BASE}${path}${hash}`;
  const base = trailingSlash || isDirectory(path) ? TREE_BASE : BLOB_BASE;
  return `${base}${path}${hash}`;
}

const IMAGE_EXTENSION = /\.(?:png|gif|jpe?g|webp|svg)$/i;

/** Rewrite the URLs of one stretch of prose, inline code excluded. */
function rewriteProse(text, options) {
  return (
    text
      // Images first, so the link pass below finds only absolute image URLs.
      .replace(
        /!\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
        (_, alt, url, title) => `![${alt}](${absolute(url, { ...options, image: true })}${title})`,
      )
      .replace(
        /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
        (_, url, title) => `](${absolute(url, { ...options, image: false })}${title})`,
      )
      // HTML: `src` and `srcset` load an image, `href` opens a page.
      .replace(
        /\b(src|srcset|href)="([^"]+)"/g,
        (_, attribute, url) =>
          `${attribute}="${absolute(url, { ...options, image: attribute !== 'href' })}"`,
      )
  );
}

/**
 * Every relative URL of a markdown page made absolute, outside fenced and
 * inline code, where a bracket is text and not a link.
 */
export function rewriteRelativeUrls(markdown, { isDirectory = directoryIn(ROOT) } = {}) {
  let fence = null;
  return markdown
    .split('\n')
    .map((line) => {
      const opener = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
        return line;
      }
      if (opener) {
        fence = opener[1];
        return line;
      }
      // A reference definition: `[label]: path`.
      const definition = /^(\s{0,3}\[[^\]]+\]:\s*)(\S+)(.*)$/.exec(line);
      if (definition) {
        const [, head, url, tail] = definition;
        return `${head}${absolute(url, { isDirectory, image: IMAGE_EXTENSION.test(url) })}${tail}`;
      }
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 === 1 ? part : rewriteProse(part, { isDirectory })))
        .join('');
    })
    .join('\n');
}

/** Format markdown as `format:check` expects it. */
async function prettierMarkdown(markdown, root) {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(join(root, FILES.readme[1]))) ?? {};
  return prettier.format(markdown, { ...config, parser: 'markdown' });
}

/**
 * The Marketplace README for a root README: github-only blocks dropped, the
 * listing's badges, absolute URLs, the generated notice, formatted.
 */
export async function marketplaceReadme(
  rootReadme,
  { root = ROOT, isDirectory = directoryIn(root) } = {},
) {
  const body = rewriteRelativeUrls(marketplaceBadges(dropGithubOnly(rootReadme)), {
    isDirectory,
  });
  return prettierMarkdown(`${GENERATED_NOTICE}\n\n${body.replace(/^\s+/, '')}`, root);
}

/** What each generated file should hold, from the sources under `root`. */
export async function expectedFiles(root = ROOT) {
  const read = (relative) => readFileSync(join(root, relative), 'utf8');
  return {
    [FILES.readme[1]]: await marketplaceReadme(read(FILES.readme[0]), { root }),
    [FILES.changelog[1]]: read(FILES.changelog[0]),
  };
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  let drifted = false;
  for (const [file, content] of Object.entries(await expectedFiles(ROOT))) {
    const path = join(ROOT, file);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (before === content) {
      console.log(`  ${file}: up to date`);
      continue;
    }
    drifted = true;
    if (checkOnly) {
      console.error(`  ${file}: STALE — run \`node scripts/sync-extension-readme.mjs\``);
    } else {
      writeFileSync(path, content);
      console.log(`  ${file}: updated`);
    }
  }
  if (checkOnly && drifted) process.exit(1);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
