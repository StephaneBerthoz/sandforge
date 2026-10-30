#!/usr/bin/env node
/**
 * Write each module's "How to" into its docs page, from the webview's English.
 *
 * The how-to is shown at the top of each module's page and in its Help
 * section, from the `howTo.<module>` keys of the locale files. Its docs page
 * carries the same steps, so that the page, the Help and the docs never say
 * two different things: en.json is the source, and the block between
 * `<!-- how-to:start` and `<!-- how-to:end -->` in each docs page is derived
 * from it. Edit the steps in the locale files, then run this script.
 *
 *   node scripts/sync-module-howto.mjs           # write every docs page
 *   node scripts/sync-module-howto.mjs --check   # exit 1 if one has drifted
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const EN_CATALOGUE = 'packages/webview/src/i18n/locales/en.json';

/** Module → the docs page its how-to is written into, repository-relative. */
export const HOW_TO_DOCS = {
  forge: 'docs/forge-quickstart.md',
  seed: 'docs/modules/seed.md',
  checkpoint: 'docs/modules/checkpoint.md',
  sync: 'docs/modules/sync.md',
  autopilot: 'docs/modules/autopilot.md',
  frozen: 'docs/modules/frozen-dataset.md',
  compare: 'docs/modules/compare.md',
  dataops: 'docs/modules/dataops.md',
  monitor: 'docs/modules/monitor.md',
  automation: 'docs/modules/automation.md',
  migration: 'docs/modules/migration.md',
  reports: 'docs/modules/reports.md',
  grappe: 'docs/modules/grappe.md',
  ai: 'docs/modules/ai-assistant.md',
};

export const START = '<!-- how-to:start';
export const END = '<!-- how-to:end -->';

/**
 * The steps and tip of `module` in a catalogue's `howTo` section: `step1` to
 * `stepN` in order, with no gap, and `tip`.
 */
export function howToOf(howTo, module) {
  const entry = howTo?.[module];
  if (!entry || typeof entry !== 'object') throw new Error(`en.json has no howTo.${module}`);
  const numbers = Object.keys(entry)
    .filter((key) => key !== 'tip')
    .map((key) => {
      const match = /^step([1-9]\d*)$/.exec(key);
      if (!match) throw new Error(`howTo.${module}.${key} is neither a step nor the tip`);
      return Number(match[1]);
    })
    .sort((a, b) => a - b);
  numbers.forEach((number, index) => {
    if (number !== index + 1) throw new Error(`howTo.${module} has no step${index + 1}`);
  });
  if (typeof entry.tip !== 'string') throw new Error(`howTo.${module} has no tip`);
  return { steps: numbers.map((number) => entry[`step${number}`]), tip: entry.tip };
}

/** The docs block of `module`, markers included. */
export function howToBlock(module, { steps, tip }, { title, tipLabel }) {
  return [
    `${START}: written by scripts/sync-module-howto.mjs from howTo.${module} in ${EN_CATALOGUE} -->`,
    '',
    `## ${title}`,
    '',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    `**${tipLabel}** ${tip}`,
    '',
    END,
  ].join('\n');
}

/** `doc` with its how-to block replaced by `block`; a page with no block, or two, is an error. */
export function withHowTo(doc, block, path) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${path} has no how-to block: put "${START} -->" and "${END}" where it goes`);
  }
  if (doc.indexOf(START, start + 1) !== -1) throw new Error(`${path} has two how-to blocks`);
  return doc.slice(0, start) + block + doc.slice(end + END.length);
}

/** Every docs page as it should read: [path, current, expected]. */
export function howToPages(root = ROOT) {
  const { howTo } = JSON.parse(readFileSync(join(root, EN_CATALOGUE), 'utf8'));
  const labels = { title: howTo.title, tipLabel: howTo.tipLabel };
  return Object.entries(HOW_TO_DOCS).map(([module, path]) => {
    const current = readFileSync(join(root, path), 'utf8');
    const expected = withHowTo(current, howToBlock(module, howToOf(howTo, module), labels), path);
    return [path, current, expected];
  });
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const drifted = [];
  for (const [path, current, expected] of howToPages()) {
    if (current === expected) continue;
    drifted.push(path);
    if (!checkOnly) writeFileSync(join(ROOT, path), expected);
  }
  if (checkOnly && drifted.length > 0) {
    console.error(
      `The how-to of ${drifted.join(', ')} differs from en.json: run node scripts/sync-module-howto.mjs`,
    );
    process.exit(1);
  }
  console.log(
    drifted.length > 0
      ? `Wrote the how-to of ${drifted.join(', ')}`
      : 'Every how-to matches en.json',
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
