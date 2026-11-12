/**
 * The data API's `/composite` call over a fake connection's own `query`, for
 * the tests of the panel's hosts whose fake target answers SOQL one call a
 * query: each query subrequest of a composite answered as that query answers
 * it, `queryAll` reading the recycle bin, and the size of every composite
 * counted. A subrequest the fake refuses answers as the org answers one it
 * refuses, with its error, while the call answers 200.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

/** What a subrequest of a composite asks. */
interface Subrequest {
  url: string;
  referenceId: string;
}

/** The composite part of a jsforce connection, and what was sent through it. */
export interface CompositeOver {
  version: string;
  request(request: { method?: string; url: string; body?: string }): Promise<unknown>;
  /** The subrequests of each composite sent, in their order. */
  calls: number[];
}

/**
 * A `/composite` over `query`.
 *
 * @param query - The fake's own query, as `conn.query(soql, { scanAll })`.
 */
export function compositeOver(
  query: (soql: string, options?: { scanAll?: boolean }) => Promise<unknown>,
): CompositeOver {
  const calls: number[] = [];
  return {
    version: '66.0',
    calls,
    request: async (request) => {
      if (request.url !== '/composite') throw new Error(`unexpected request: ${request.url}`);
      const { compositeRequest } = JSON.parse(request.body ?? '{}') as {
        compositeRequest: Subrequest[];
      };
      calls.push(compositeRequest.length);
      return {
        compositeResponse: await Promise.all(
          compositeRequest.map(async (sub) => {
            const asked = /\/(query|queryAll)\?q=(.*)$/.exec(sub.url);
            if (!asked) throw new Error(`unexpected subrequest: ${sub.url}`);
            try {
              const body = await query(decodeURIComponent(asked[2]), {
                scanAll: asked[1] === 'queryAll',
              });
              return { referenceId: sub.referenceId, httpStatusCode: 200, body };
            } catch (err: unknown) {
              return {
                referenceId: sub.referenceId,
                httpStatusCode: 400,
                body: [
                  {
                    errorCode: 'MALFORMED_QUERY',
                    message: err instanceof Error ? err.message : String(err),
                  },
                ],
              };
            }
          }),
        ),
      };
    },
  };
}
