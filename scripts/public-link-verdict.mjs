/**
 * Whether a public URL reaches an anonymous reader: the verdict
 * `check-public-links.mjs` gives each URL the listing exposes.
 *
 * Kept apart from the script so the rule can be tested without the network:
 * the script runs its checks as it is loaded. So is the rule that names the
 * file a link into the repository's own branch points at.
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
 * A HEAD answered "ask again later" is asked again too, waiting longer. A URL
 * that got nothing but such answers is unverified, not broken: on 2026-10-13
 * GitHub answered 503 to the GET and the HEAD of four documentation pages on
 * its own runner, failing the release's packaging, while each answered 200 to
 * the same requests minutes later. A missing file or a private repository
 * answers 404, never 503, so such a URL passes with `unverified` set and the
 * script names it. A HEAD that cannot connect still fails: no answer at all
 * says nothing about the server.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetchImpl - The fetch to ask with.
 * @param {(ms: number) => Promise<void>} deps.wait - The wait between tries.
 * @param {() => number} deps.budgetLeft - Milliseconds left to the whole pass.
 * @returns {(url: string) => Promise<{ ok: boolean, status: number | string, unverified?: true }>}
 */
export function createFetchVerdict({ fetchImpl, wait, budgetLeft }) {
  /** A HEAD, for a URL the GET kept answering "ask again later". */
  async function headVerdict(url, getStatus, attempt = 0) {
    try {
      const response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
      if (response.ok) return { ok: true, status: response.status };
      const status = `${getStatus} on GET, ${response.status} on HEAD`;
      if (!RETRYABLE.has(response.status)) return { ok: false, status };
      const backoff = 4000 * 2 ** attempt;
      if (attempt < 2 && backoff < budgetLeft()) {
        await wait(backoff);
        return headVerdict(url, getStatus, attempt + 1);
      }
      return { ok: true, status, unverified: true };
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

/**
 * The path a URL names in one branch of a GitHub repository, or null when it
 * names anything else.
 *
 * Reads the four addresses of a file or folder of `repository` (`owner/name`)
 * on `branch`: `blob/` and `tree/` and `raw/` on github.com, and
 * raw.githubusercontent.com. The anchor and query are dropped and each segment
 * is decoded; a segment that decodes to a slash or to `.` or `..` names no
 * path, so the result never leaves the tree it is joined to.
 *
 * @param {string} url
 * @param {string} repository - `owner/name`, compared in any case as GitHub does.
 * @param {string} branch
 * @returns {string | null}
 */
export function pathOnBranch(url, repository, branch) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const [owner, name] = repository.toLowerCase().split('/');
  const segments = parsed.pathname.split('/').slice(1);
  let rest;
  if (parsed.hostname === 'github.com') {
    const [o, n, kind, ...after] = segments;
    if (!['blob', 'tree', 'raw'].includes(kind)) return null;
    if (o?.toLowerCase() !== owner || n?.toLowerCase() !== name) return null;
    rest = after;
  } else if (parsed.hostname === 'raw.githubusercontent.com') {
    const [o, n, ...after] = segments;
    if (o?.toLowerCase() !== owner || n?.toLowerCase() !== name) return null;
    rest = after;
  } else {
    return null;
  }

  // A folder's address may end in a slash.
  if (rest.at(-1) === '') rest = rest.slice(0, -1);
  const branchSegments = branch.split('/');
  if (rest.slice(0, branchSegments.length).join('/') !== branch) return null;
  let path;
  try {
    path = rest.slice(branchSegments.length).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (path.length === 0) return null;
  const unsafe = (segment) =>
    segment === '' || segment === '.' || segment === '..' || /[/\\]/.test(segment);
  return path.some(unsafe) ? null : path.join('/');
}
