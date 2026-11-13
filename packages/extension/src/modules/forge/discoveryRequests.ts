/**
 * The API requests a discovery of the panel sends each org, counted as its
 * reads send them.
 *
 * The panel's connections are shared: a discovery, Review's reads of the
 * target and a run of another panel go through the same ones, and a count
 * kept on a connection counts them all. Each read of a discovery that sends
 * a request — a describe not held already, a count, a list of the org's
 * objects — says so here, and the request is counted for the discovery it
 * was sent for, the one in whose course it went: a describe another
 * discovery or a run had already sent, or held, is none of its own.
 *
 * The command line counts its own connections (`countRequests`), and said
 * what discovery sent each org; the panel said nothing of it, though a
 * discovery of a whole org on a scratch org sent the source 246 requests.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** What a discovery under way has sent so far, by org id. */
const discoveries = new AsyncLocalStorage<Map<string, number>>();

/**
 * Run `discover`, every request its reads send counted
 * ({@link discoveryRequestSent}).
 *
 * @returns What it answered, and what it sent each org, by org id.
 */
export async function countingDiscovery<T>(
  discover: () => Promise<T>,
): Promise<{ result: T; sent: ReadonlyMap<string, number> }> {
  const sent = new Map<string, number>();
  const result = await discoveries.run(sent, discover);
  return { result, sent };
}

/**
 * Note `requests` sent `orgId` by a read: counted for the discovery in whose
 * course the read went, if any.
 */
export function discoveryRequestSent(orgId: string, requests = 1): void {
  const sent = discoveries.getStore();
  if (!sent || requests <= 0) return;
  sent.set(orgId, (sent.get(orgId) ?? 0) + requests);
}

/**
 * What a discovery sent the run's two orgs, as the graph it answered with
 * carries it to Review (`ForgeGraph.discoveryRequests`); undefined when it
 * sent nothing — a graph the session's cache served.
 */
export function discoveryRequestsOf(
  sent: ReadonlyMap<string, number>,
  orgs: { sourceOrgId: string; targetOrgId: string },
): { source: number; target: number } | undefined {
  const source = sent.get(orgs.sourceOrgId) ?? 0;
  const target = orgs.targetOrgId === orgs.sourceOrgId ? 0 : (sent.get(orgs.targetOrgId) ?? 0);
  return source + target > 0 ? { source, target } : undefined;
}
