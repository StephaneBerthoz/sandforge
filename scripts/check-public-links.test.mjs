/**
 * Tests for check-public-links.mjs, run as `pnpm package` and the release
 * check run it: the script itself, over a repository of its own, with GitHub's
 * answers given by a stand-in for `fetch`.
 *
 * The Package job of CI went red on the pull request that added a
 * documentation page and green once it was on master: the listing links the
 * page at its `blob/master` address, and GitHub answers 404 for it until the
 * pull request merges.
 *
 * Run: node --test scripts/check-public-links.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'check-public-links-'));
after(() => rmSync(work, { recursive: true, force: true }));

const REPOSITORY = 'https://github.com/owner/repo';
const ADDED = `${REPOSITORY}/blob/master/docs/added.md`;
const REMOVED = `${REPOSITORY}/blob/master/docs/removed.md`;
const ELSEWHERE = 'https://github.com/other/repo/blob/master/docs/added.md';

/**
 * A `fetch` answering each URL the status `STUB_STATUSES` gives it, 200
 * otherwise, and logging every URL it was asked to `STUB_LOG`.
 */
const STUB = `
import { appendFileSync } from 'node:fs';
const statuses = JSON.parse(process.env.STUB_STATUSES ?? '{}');
globalThis.fetch = async (url) => {
  appendFileSync(process.env.STUB_LOG, url + '\\n');
  const status = statuses[url] ?? 200;
  return { ok: status >= 200 && status < 300, status };
};
`;

let runs = 0;

/**
 * Run the gate over a repository whose README links `links`, whose tree holds
 * `files`, on a pull request into `base` or, with no base, outside one.
 */
function runGate({ links, files, statuses = {}, base = '' }) {
  runs += 1;
  const root = join(work, `repo-${runs}`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages', 'extension'), { recursive: true });
  for (const name of ['check-public-links.mjs', 'public-link-verdict.mjs']) {
    copyFileSync(join(scriptsDir, name), join(root, 'scripts', name));
  }
  writeFileSync(
    join(root, 'packages', 'extension', 'package.json'),
    JSON.stringify({ repository: { type: 'git', url: REPOSITORY } }),
  );
  writeFileSync(join(root, 'README.md'), links.map((url) => `- [page](${url})`).join('\n'));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '# page\n');
  }
  const stub = join(root, 'stub-fetch.mjs');
  writeFileSync(stub, STUB);
  const log = join(root, 'asked.log');
  writeFileSync(log, '');

  const run = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(stub).href, join(root, 'scripts', 'check-public-links.mjs')],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_BASE_REF: base,
        STUB_STATUSES: JSON.stringify(statuses),
        STUB_LOG: log,
      },
    },
  );
  const asked = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { ...run, output: run.stdout + run.stderr, asked };
}

test('on a pull request, a page it adds passes while GitHub still answers 404 for it', () => {
  const run = runGate({
    links: [ADDED],
    files: ['docs/added.md'],
    statuses: { [ADDED]: 404 },
    base: 'master',
  });

  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /1 link into master read in this pull request's tree/);
  assert.ok(!run.asked.includes(ADDED), 'the page was asked of GitHub');
});

test('on a pull request, a page it removes fails while GitHub still serves it', () => {
  const run = runGate({ links: [REMOVED], files: [], base: 'master' });

  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /docs\/removed\.md → not in this pull request's tree/);
});

test('outside a pull request, the page is asked of GitHub: a release cannot link one not yet pushed', () => {
  const run = runGate({ links: [ADDED], files: ['docs/added.md'], statuses: { [ADDED]: 404 } });

  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /docs\/added\.md → 404/);
  assert.ok(run.asked.includes(ADDED), 'the page was not asked of GitHub');
});

test("on a pull request, another repository's page is still asked of GitHub", () => {
  const run = runGate({
    links: [ELSEWHERE],
    files: ['docs/added.md'],
    statuses: { [ELSEWHERE]: 404 },
    base: 'master',
  });

  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /other\/repo\/blob\/master\/docs\/added\.md → 404/);
});

test("on a pull request into another branch, master's pages are still asked of GitHub", () => {
  const run = runGate({
    links: [ADDED],
    files: ['docs/added.md'],
    statuses: { [ADDED]: 404 },
    base: 'release/1.x',
  });

  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /docs\/added\.md → 404/);
});
