#!/usr/bin/env node
/**
 * Fail the release when a tracked file names a client or carries a real
 * Salesforce identifier.
 *
 * The repository and the VSIX are both public — the VSIX ships `changelog.md`
 * as the Marketplace "Changelog" tab — so the whole tracked tree is scanned,
 * this file included.
 *
 * Client names live outside the repository, in an untracked
 * `.confidential-names`: one extended regular expression per line, `#` for a
 * comment. Without that file only the identifier patterns run, which is all a
 * CI checkout can do. A name is reported by file and line, never by the text
 * that matched: this output lands in logs.
 *
 * The identifier pattern used to be `00D[A-Za-z0-9]{12,15}`, case-insensitive.
 * It matched 59 places and not one of them was an org: fixtures counting up
 * from `00D000000000001`, placeholders made of one repeated letter, the example
 * Id from Salesforce's documentation, eighteen characters in the middle of a
 * lockfile integrity hash, and its own definition. A check that fails on every
 * run hides the one failure that matters among the ones everybody expects. An
 * org Id is now a token standing on its own, and the shapes that are not an org
 * are named below rather than matched.
 *
 *   node scripts/check-confidential.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMES_FILE = '.confidential-names';

/**
 * An org Id: `00D`, twelve characters, then an optional three-character
 * suffix. Salesforce Ids are case-sensitive, and so is this. A letter or digit
 * on either side means the run belongs to a longer token — a digest, a longer
 * Id — and is not one.
 */
const ORG_ID = /(?<![A-Za-z0-9])00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?(?![A-Za-z0-9])/g;

/**
 * The start of Case Ids copied out of an org into Forge fixtures and a recipe
 * tool in April 2026, removed since. Written in two pieces so that its own
 * definition does not match it.
 */
const CASE_PREFIX = '500' + 'AP0000';
const CASE_ID = new RegExp(`(?<![A-Za-z0-9])${CASE_PREFIX}[A-Za-z0-9]*`, 'g');

/**
 * Shapes that are visibly not an org: the pod written `xx`, as in the example
 * Id Salesforce's documentation uses; one character repeated; a counter padded
 * with zeros.
 */
export function isSyntheticOrgId(id) {
  const body = id.slice(3);
  return /^xx/i.test(body) || /^(.)\1*$/.test(body) || /^0{9,}[0-9]{1,3}$/.test(body.slice(0, 12));
}

/** Every identifier on one line of text that could belong to a real org. */
export function identifiersIn(line) {
  const orgIds = [...line.matchAll(ORG_ID)].map((m) => m[0]).filter((id) => !isSyntheticOrgId(id));
  const caseIds = [...line.matchAll(CASE_ID)].map((m) => m[0]);
  return [...orgIds, ...caseIds];
}

/** Enough of an identifier to find it, not enough to copy it into another log. */
export function masked(id) {
  return `${id.slice(0, 5)}…`;
}

/** Output lines of `git grep` over the tracked tree, or none when nothing matched. */
function gitGrep(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', 'grep', ...args, '--', '.'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`git grep ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

/** `path:line` and the text after it, from one `git grep -n` line. */
function located(grepLine) {
  const match = /^(.*?):(\d+):/.exec(grepLine);
  return match && { where: `${match[1]}:${match[2]}`, text: grepLine.slice(match[0].length) };
}

function scan(root) {
  const findings = [];

  // Binary files are left out of the identifier scan: a run of letters and
  // digits inside compressed bytes is noise, and an Id drawn into an image is
  // not text either way.
  for (const line of gitGrep(root, ['-nIE', `00D[A-Za-z0-9]{12}|${CASE_PREFIX}`])) {
    const at = located(line);
    if (!at) continue;
    for (const id of identifiersIn(at.text))
      findings.push(`${at.where} — identifier ${masked(id)}`);
  }

  const namesPath = join(root, NAMES_FILE);
  const names = existsSync(namesPath)
    ? readFileSync(namesPath, 'utf8')
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .filter((line) => !/^\s*(#|$)/.test(line))
    : [];

  // Binary files are scanned for names: a client name inside a packaged asset
  // ships all the same.
  if (names.length > 0) {
    for (const line of gitGrep(root, ['-niE', names.join('|')])) {
      const binary = /^Binary file (.*) matches$/.exec(line);
      const where = binary ? binary[1] : located(line)?.where;
      if (where) findings.push(`${where} — a name listed in ${NAMES_FILE}`);
    }
  }

  return { findings, namesChecked: names.length > 0 };
}

function main() {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) {
    console.error('Confidentiality: not inside a git repository');
    process.exit(1);
  }
  const root = top.stdout.trim();
  const tracked = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .stdout.split('\0')
    .filter(Boolean).length;

  let result;
  try {
    result = scan(root);
  } catch (error) {
    console.error(`Confidentiality: ${error.message}`);
    process.exit(1);
  }

  if (result.findings.length > 0) {
    console.error(`Confidentiality: ${result.findings.length} finding(s)\n`);
    for (const finding of result.findings) console.error(`  ✗ ${finding}`);
    console.error(
      '\nRemove them before publishing. A fixture stands in for an org with 00D000000000001, ' +
        'never with an Id copied from one.',
    );
    process.exit(1);
  }

  if (!result.namesChecked) {
    console.error(`WARN: ${NAMES_FILE} absent — identifiers checked, client names not.`);
  }
  const files = `${tracked} tracked file${tracked === 1 ? '' : 's'}`;
  const scope = result.namesChecked
    ? 'no real org identifier and no client name'
    : 'no real org identifier';
  console.log(`Confidentiality: ${scope} in ${files}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
