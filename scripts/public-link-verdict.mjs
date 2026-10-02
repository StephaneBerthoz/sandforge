/**
 * Whether a public URL reaches an anonymous reader: the verdict
 * `check-public-links.mjs` gives each URL the listing exposes.
 *
 * Kept apart from the script so the rule can be tested without the network:
 * the script runs its checks as it is loaded.
 */

/** Statuses that say "ask again later", not "this URL is wrong". */
export const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * The verdict function, over the fetch, the wait and the time budget it is
 * given.
 *
 * Backs off on rate limiting and transient server errors rather than failing
 * the release on them — a gate that turns a 429 into "this image is broken"
 * fails for a reason unrelated to what it checks, and the next person learns
 * to ignore it. Bounded twice: two retries, and the shared budget.
 *
 * A URL still answered "ask again later" once the retries are spent is asked
 * once more with HEAD, and HEAD's answer stands. GitHub answers the anonymous
 * GET of a file's page 503 once a few dozen of them come from one address in a
 * row: on 2026-10-02 every release check failed so, a dozen documentation
 * links out of sixty-five, on the maintainer's machine and on GitHub's own
 * runners alike, while each page answered 200 to a HEAD and to a browser. A
 * HEAD tells the same thing as the GET for what the check is about — a file
 * that is not there, or a repository a stranger may not read, answers 404 to
 * both — and is not counted against that limit.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetchImpl - The fetch to ask with.
 * @param {(ms: number) => Promise<void>} deps.wait - The wait between tries.
 * @param {() => number} deps.budgetLeft - Milliseconds left to the whole pass.
 * @returns {(url: string) => Promise<{ ok: boolean, status: number | string }>}
 */
export function createFetchVerdict({ fetchImpl, wait, budgetLeft }) {
  /** One HEAD, for a URL the GET kept answering "ask again later". */
  async function headVerdict(url, getStatus) {
    try {
      const response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
      return response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: `${getStatus} on GET, ${response.status} on HEAD` };
    } catch (error) {
      const why = error instanceof Error ? error.message : 'fetch failed';
      return { ok: false, status: `${getStatus} on GET, ${why} on HEAD` };
    }
  }

  async function fetchVerdict(url, attempt = 0) {
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
      if (RETRYABLE.has(response.status)) {
        const backoff = 1000 * 2 ** attempt;
        if (attempt < 2 && backoff < budgetLeft()) {
          await wait(backoff);
          return fetchVerdict(url, attempt + 1);
        }
        return headVerdict(url, response.status);
      }
      return { ok: response.ok, status: response.status };
    } catch (error) {
      const backoff = 1000 * 2 ** attempt;
      if (attempt < 2 && backoff < budgetLeft()) {
        await wait(backoff);
        return fetchVerdict(url, attempt + 1);
      }
      return headVerdict(url, error instanceof Error ? error.message : 'fetch failed');
    }
  }

  return (url) => fetchVerdict(url);
}
