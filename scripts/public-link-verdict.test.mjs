import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchVerdict, pathOnBranch } from './public-link-verdict.mjs';

/**
 * A fetch that answers each call with the next status of `script`, by
 * method, and records the calls it was asked.
 */
function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push(method);
    const next = script[method]?.shift();
    if (next instanceof Error) throw next;
    const status = next ?? 500;
    return { ok: status >= 200 && status < 300, status };
  };
  return { fetchImpl, calls };
}

const verdictOver = (script) => {
  const { fetchImpl, calls } = scriptedFetch(script);
  const verdict = createFetchVerdict({
    fetchImpl,
    wait: async () => {},
    budgetLeft: () => 60_000,
  });
  return { verdict, calls };
};

test('takes a URL a GET reaches, and asks nothing more', async () => {
  const { verdict, calls } = verdictOver({ GET: [200] });

  assert.deepEqual(await verdict('https://example.test/doc.md'), { ok: true, status: 200 });
  assert.deepEqual(calls, ['GET']);
});

test('takes a page GitHub keeps answering 503 to a GET when a HEAD reaches it', async () => {
  // The anonymous GET of a file's page, throttled once a few dozen come from
  // one address; the HEAD of the same page, answered.
  const { verdict, calls } = verdictOver({ GET: [503, 503, 503], HEAD: [200] });

  assert.deepEqual(await verdict('https://github.com/o/r/blob/main/docs/faq.md'), {
    ok: true,
    status: 200,
  });
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'HEAD']);
});

test('fails a URL a HEAD does not reach either, saying both answers', async () => {
  const { verdict } = verdictOver({ GET: [429, 429, 429], HEAD: [404] });

  assert.deepEqual(await verdict('https://github.com/o/private/blob/main/x.md'), {
    ok: false,
    status: '429 on GET, 404 on HEAD',
  });
});

test('asks a HEAD answered 503 again, and takes the page once it answers', async () => {
  const { verdict, calls } = verdictOver({ GET: [503, 503, 503], HEAD: [503, 200] });

  assert.deepEqual(await verdict('https://github.com/o/r/blob/main/docs/seed.md'), {
    ok: true,
    status: 200,
  });
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'HEAD', 'HEAD']);
});

test('passes a page that only ever answered 503 as unverified, saying both answers', async () => {
  // GitHub's runner on 2026-10-13: four documentation pages answered 503 to
  // every GET and HEAD, then 200 minutes later. A 503 never means missing.
  const { verdict, calls } = verdictOver({ GET: [503, 503, 503], HEAD: [503, 503, 503] });

  assert.deepEqual(await verdict('https://github.com/o/r/blob/main/docs/seed.md'), {
    ok: true,
    status: '503 on GET, 503 on HEAD',
    unverified: true,
  });
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'HEAD', 'HEAD', 'HEAD']);
});

test('still fails a page whose HEAD says it is not there after a 503', async () => {
  const { verdict } = verdictOver({ GET: [503, 503, 503], HEAD: [503, 404] });

  assert.deepEqual(await verdict('https://github.com/o/r/blob/main/gone.md'), {
    ok: false,
    status: '503 on GET, 404 on HEAD',
  });
});

test('fails a URL a GET says is not there, without a HEAD', async () => {
  // A 404 is the answer the check exists for: nothing to ask again.
  const { verdict, calls } = verdictOver({ GET: [404], HEAD: [200] });

  assert.deepEqual(await verdict('https://github.com/o/r/blob/main/gone.md'), {
    ok: false,
    status: 404,
  });
  assert.deepEqual(calls, ['GET']);
});

test('asks a HEAD once a GET kept failing to connect', async () => {
  const offline = new Error('connect ECONNRESET');
  const { verdict, calls } = verdictOver({ GET: [offline, offline, offline], HEAD: [200] });

  assert.deepEqual(await verdict('https://example.test/doc.md'), { ok: true, status: 200 });
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'HEAD']);
});

test('asks the HEAD at once when the budget leaves no time to wait', async () => {
  const { fetchImpl, calls } = scriptedFetch({ GET: [503], HEAD: [200] });
  const verdict = createFetchVerdict({ fetchImpl, wait: async () => {}, budgetLeft: () => 0 });

  assert.deepEqual(await verdict('https://example.test/doc.md'), { ok: true, status: 200 });
  assert.deepEqual(calls, ['GET', 'HEAD']);
});

test('names the path a link into a branch of the repository points at, in each of its forms', () => {
  const on = (url) => pathOnBranch(url, 'Owner/repo', 'master');

  assert.equal(on('https://github.com/Owner/repo/blob/master/docs/faq.md'), 'docs/faq.md');
  assert.equal(on('https://github.com/Owner/repo/tree/master/ci-examples'), 'ci-examples');
  assert.equal(on('https://github.com/Owner/repo/tree/master/ci-examples/'), 'ci-examples');
  assert.equal(
    on('https://raw.githubusercontent.com/Owner/repo/master/assets/screenshots/forge.png'),
    'assets/screenshots/forge.png',
  );
  assert.equal(on('https://github.com/Owner/repo/raw/master/assets/icon.png'), 'assets/icon.png');
});

test('reads the path without its anchor or query, decoded, and the owner in any case', () => {
  const on = (url) => pathOnBranch(url, 'Owner/repo', 'master');

  assert.equal(on('https://github.com/Owner/repo/blob/master/docs/faq.md#undo'), 'docs/faq.md');
  assert.equal(on('https://github.com/Owner/repo/blob/master/docs/faq.md?plain=1'), 'docs/faq.md');
  assert.equal(on('https://github.com/Owner/repo/blob/master/docs/a%20b.md'), 'docs/a b.md');
  assert.equal(on('https://github.com/owner/REPO/blob/master/docs/faq.md'), 'docs/faq.md');
});

test('names no path for another branch, another repository, or a page that is not a file', () => {
  const on = (url) => pathOnBranch(url, 'Owner/repo', 'master');

  assert.equal(on('https://github.com/Owner/repo/blob/release/docs/faq.md'), null);
  assert.equal(on('https://github.com/Owner/repo/blob/master-old/docs/faq.md'), null);
  assert.equal(on('https://github.com/Other/repo/blob/master/docs/faq.md'), null);
  assert.equal(on('https://github.com/Owner/repository/blob/master/docs/faq.md'), null);
  assert.equal(on('https://github.com/Owner/repo/issues'), null);
  assert.equal(on('https://github.com/Owner/repo/blob/master/'), null);
  assert.equal(on('https://example.test/Owner/repo/blob/master/docs/faq.md'), null);
  assert.equal(on('https://github.com/Owner/repo/blob/master/docs/%2E%2E/%2E%2E/x.md'), null);
  assert.equal(on('https://github.com/Owner/repo/blob/master/docs/..%2F..%2Fx.md'), null);
});

test('reads a base branch whose name holds a slash', () => {
  const url = 'https://github.com/Owner/repo/blob/release/1.x/docs/faq.md';
  assert.equal(pathOnBranch(url, 'Owner/repo', 'release/1.x'), 'docs/faq.md');
});
