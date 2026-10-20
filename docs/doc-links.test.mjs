/**
 * Every relative link of the published pages lands: the file is there, and
 * so is the heading or the named anchor after its `#`.
 *
 * The Forge quickstart sent a reader to sections of its own by anchor, and
 * the module pages, the FAQ and both READMEs sent readers into it. When its
 * reference moved to a page of its own, every one of those links had to follow
 * by hand, and nothing would have said which did not: GitHub renders a link to
 * a missing anchor as the top of the page, and a missing file as a 404 the
 * maintainer never sees. The Marketplace README is left out: the generator
 * rewrites its links to absolute GitHub addresses from the root README's,
 * which this reads.
 *
 *   node --test docs/doc-links.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');

/** Markdown files under a directory, the archive of withdrawn pages left out. */
function markdownUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'archive') markdownUnder(full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** The pages a reader follows links from. */
const PAGES = () => [
  join(repoRoot, 'README.md'),
  join(repoRoot, 'ci-examples', 'README.md'),
  ...markdownUnder(docsDir),
  ...markdownUnder(join(repoRoot, 'packages', 'extension', 'walkthrough')),
];

/** A page's text with its fenced and inline code removed: a link there is an example. */
const prose = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/`[^`\n]*`/g, '');

/**
 * The anchor GitHub gives a heading: its text as rendered — emphasis, code
 * marks and link targets gone — in lower case, every character but letters,
 * digits, spaces, hyphens and underscores dropped, spaces turned to hyphens.
 */
function slugOf(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** The anchors a page offers: its headings' slugs, numbered as GitHub numbers repeats, and its named anchors. */
function anchorsOf(file) {
  const text = readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^```[\s\S]*?^```/gm, '');
  const anchors = new Set();
  const seen = new Map();
  for (const [, heading] of text.matchAll(/^#{1,6} +(.+?) *#*$/gm)) {
    const slug = slugOf(heading);
    const count = seen.get(slug) ?? 0;
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    seen.set(slug, count + 1);
  }
  for (const [, name] of text.matchAll(/<a (?:name|id)="([^"]+)"/g)) anchors.add(name);
  return anchors;
}

/** Each relative link of a page, as `{ target, anchor }`. */
function linksOf(file) {
  const links = [];
  for (const [, url] of prose(readFileSync(file, 'utf8')).matchAll(
    /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
  )) {
    if (/^(?:[a-z][a-z+.-]*:|\/\/)/i.test(url)) continue;
    const [path, anchor] = url.split('#');
    links.push({
      url,
      target: path ? resolve(dirname(file), decodeURIComponent(path)) : file,
      anchor,
    });
  }
  return links;
}

test('the anchor of a heading is the one GitHub gives it', () => {
  assert.equal(slugOf("The run's audit entry"), 'the-runs-audit-entry');
  assert.equal(slugOf('Load Flow (Replayable)'), 'load-flow-replayable');
  assert.equal(slugOf('One empty org? Fill it in a minute'), 'one-empty-org-fill-it-in-a-minute');
  assert.equal(slugOf('Generate data (Seed Wizard)'), 'generate-data-seed-wizard');
  assert.equal(slugOf('`sandforge.forge.graphView`'), 'sandforgeforgegraphview');
  assert.equal(slugOf('**Seed** and [Sync](sync.md)'), 'seed-and-sync');
});

test('every relative link of the published pages reaches its file and its anchor', () => {
  const pages = PAGES();
  // Positive control: the walk reads the pages and their links.
  assert.ok(pages.length > 20, `only ${pages.length} pages read — re-point this gate`);
  const anchors = new Map();
  const broken = [];
  let followed = 0;
  for (const page of pages) {
    for (const { url, target, anchor } of linksOf(page)) {
      followed += 1;
      const where = `${relative(repoRoot, page)} → ${url}`;
      if (!existsSync(target)) {
        broken.push(`${where}: no such file`);
        continue;
      }
      if (!anchor || statSync(target).isDirectory() || !target.endsWith('.md')) continue;
      if (!anchors.has(target)) anchors.set(target, anchorsOf(target));
      if (!anchors.get(target).has(anchor)) broken.push(`${where}: no such heading or anchor`);
    }
  }
  assert.ok(followed > 100, `only ${followed} links followed — the walk reads no link`);
  assert.deepEqual(broken, [], `links that land nowhere:\n  ${broken.join('\n  ')}`);
});
