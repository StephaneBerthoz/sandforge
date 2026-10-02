import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchVerdict } from './public-link-verdict.mjs';

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
