#!/usr/bin/env node
/**
 * Derive the README badges from the repository's actual state.
 *
 * The badges had drifted three releases behind: version read 1.12.0 while
 * 1.15.0 was on the Marketplace, the VSIX size was 1.9 MB against a 2.02 MB
 * artifact, and a hardcoded `build-passing` asserted a green build while CI was
 * red. A static badge is a claim nobody re-checks, so it decays into a false
 * one — the same failure mode as the docs claiming features that did not exist.
 *
 * Everything here is measured, not typed in:
 *   version   root package.json
 *   i18n      locale files on disk
 *   build     replaced by the live GitHub Actions badge, which reports the real
 *             state instead of a frozen adjective
 *
 * A test-count badge is deliberately absent too. Deriving it honestly meant
 * `vitest list` per package — 26 s for the smallest one, minutes for the whole
 * workspace — which is far too slow for a release gate, and the alternative
 * (typing a number in) is what let the old badge drift 26 tests out. The CI
 * badge already answers the question a count was standing in for: do the tests
 * pass. Every input below is instant to read or genuinely static.
 *
 * The VSIX size is deliberately NOT a badge. The README is packaged INTO the
 * VSIX, so a size badge can only ever describe the previous build: syncing
 * before `vsce package` reads the old artifact, syncing after ships a stale
 * README. It was also the least informative of the set.
 *
 * SECURITY.md's supported-versions table is derived here too, from the same
 * version. It promises fixes to "the latest minor" and was typed by hand, so it
 * still offered support for 1.21.x after 1.22.0 shipped: a security promise
 * about the wrong release, which nothing compared with package.json.
 *
 *   node scripts/sync-readme-badges.mjs           # rewrite both READMEs and SECURITY.md
 *   node scripts/sync-readme-badges.mjs --check   # exit 1 if any of them has drifted
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

const REPO = 'StephaneBerthoz/sandforge';
const MARKETPLACE = `https://marketplace.visualstudio.com/items?itemName=StephaneBerthoz.sandforge`;

/** Markers delimiting the generated block, so the rest of the README is ours to edit. */
const START = '<!-- badges:start -->';
const END = '<!-- badges:end -->';

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** Locale files shipped by the webview. */
function countLanguages() {
  return readdirSync(join(ROOT, 'packages/webview/src/i18n/locales')).filter((f) =>
    f.endsWith('.json'),
  ).length;
}

/** shields.io escapes `-` as `--` inside a label or message. */
const esc = (value) => String(value).replace(/-/g, '--');

function buildBlock({ languages, linkVersion }) {
  const versionBadge = `![Version](https://img.shields.io/badge/version-${esc(version)}-blue)`;
  const lines = [
    linkVersion ? `[${versionBadge}](${MARKETPLACE})` : versionBadge,
    // Live, not asserted: this one goes red on its own when CI does. It is
    // absent from the Marketplace README on purpose — GitHub serves the badge
    // of a private repo only to a signed-in collaborator, so on the listing it
    // renders as a broken image to everyone. `linkVersion` marks that README.
    ...(linkVersion
      ? []
      : [
          `[![CI](https://github.com/${REPO}/actions/workflows/ci.yml/badge.svg)](https://github.com/${REPO}/actions/workflows/ci.yml)`,
        ]),
    `![TypeScript](https://img.shields.io/badge/typescript-strict-blue)`,
    `![License](https://img.shields.io/badge/license-MIT-green)`,
    `![Languages](https://img.shields.io/badge/i18n-${languages}%20languages-orange)`,
  ];
  // Blank lines inside the markers: Prettier requires them around an HTML
  // comment in markdown, and without them every badge sync left the two READMEs
  // failing `format:check` — a generated file that cannot satisfy the repo's own
  // formatter re-breaks the gate on each release.
  return `${START}\n\n${lines.join('\n')}\n\n${END}`;
}

/**
 * Replace the generated block, adopting any legacy badge run that predates the
 * markers (a contiguous set of leading badge lines).
 */
function applyBlock(source, block) {
  if (source.includes(START) && source.includes(END)) {
    const before = source.slice(0, source.indexOf(START));
    const after = source.slice(source.indexOf(END) + END.length);
    return `${before}${block}${after}`;
  }
  const lines = source.split('\n');
  const first = lines.findIndex((l) => l.includes('img.shields.io'));
  if (first === -1) return source;
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].includes('img.shields.io')) last++;
  return [...lines.slice(0, first), block, ...lines.slice(last + 1)].join('\n');
}

const facts = { languages: countLanguages() };
console.log(`measured: version ${version}, ${facts.languages} locales`);

let drifted = false;
for (const [file, linkVersion] of [
  ['README.md', false],
  ['packages/extension/README.md', true],
]) {
  const path = join(ROOT, file);
  const before = readFileSync(path, 'utf8');
  const after = applyBlock(before, buildBlock({ ...facts, linkVersion }));
  if (before === after) {
    console.log(`  ${file}: up to date`);
    continue;
  }
  drifted = true;
  if (CHECK_ONLY) {
    console.error(`  ${file}: STALE — run \`node scripts/sync-readme-badges.mjs\``);
  } else {
    writeFileSync(path, after);
    console.log(`  ${file}: updated`);
  }
}

/**
 * The supported-versions table, laid out the way Prettier writes a markdown
 * table so the rewrite cannot fail `format:check`: every cell padded to its
 * column's widest entry, the rule row as wide as the column.
 */
function securityTable() {
  const minor = version.split('.').slice(0, 2).join('.');
  const rows = [
    ['Version', 'Supported'],
    [`${minor}.x`, 'Yes'],
    [`< ${minor}`, 'No'],
  ];
  const widths = [0, 1].map((col) => Math.max(...rows.map((row) => row[col].length)));
  const line = (cells) => `| ${cells.map((cell, col) => cell.padEnd(widths[col])).join(' | ')} |`;
  return [line(rows[0]), line(widths.map((w) => '-'.repeat(w))), ...rows.slice(1).map(line)].join(
    '\n',
  );
}

/** The table starts at its `| Version` header and runs to the last `|` line. */
const SECURITY_TABLE = /^\| Version +\| Supported +\|\n(?:\|.*\|\n?)+/m;

{
  const file = 'SECURITY.md';
  const path = join(ROOT, file);
  const before = readFileSync(path, 'utf8');
  const match = SECURITY_TABLE.exec(before);
  if (!match) {
    // A table that cannot be found cannot be kept in sync; that is drift too,
    // and write mode must not guess where a replacement belongs.
    drifted = true;
    console.error(`  ${file}: STALE — supported-versions table not found`);
  } else {
    const trailing = match[0].endsWith('\n') ? '\n' : '';
    const after = before.replace(SECURITY_TABLE, `${securityTable()}${trailing}`);
    if (before === after) {
      console.log(`  ${file}: up to date`);
    } else {
      drifted = true;
      if (CHECK_ONLY) {
        console.error(`  ${file}: STALE — run \`node scripts/sync-readme-badges.mjs\``);
      } else {
        writeFileSync(path, after);
        console.log(`  ${file}: updated`);
      }
    }
  }
}

if (CHECK_ONLY && drifted) process.exit(1);
