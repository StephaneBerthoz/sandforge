/**
 * The requests this process sends checking connections: each new
 * connection's identity call (`getJsforceConnection`) — the API's version
 * root, then the identity URL —, the one of a connection rebuilt on a
 * refreshed token, and an org's check as it is connected
 * (`AuthProvider.validateConnection`), its Organization record read beside.
 *
 * None of them is any act's own, and the org counts each against its day: a
 * command line that says what it sent an org counts them with what its act
 * sent (`cli/panelHost.ts`), where its count left out the five that connect
 * an org and check the connection its act reads through.
 */

import type { Connection } from 'jsforce';
import { countRequests } from '../precheck/orgKindLive.js';

let checkRequests = 0;

/** The requests this process's connection checks have sent so far. */
export function connectionCheckRequests(): number {
  return checkRequests;
}

/**
 * `check` of `conn`, the requests it sends through it counted with the
 * checks' ({@link connectionCheckRequests}), whether it answers or fails.
 */
export async function connectionCheck<T>(conn: Connection, check: () => Promise<T>): Promise<T> {
  const sent = countRequests(conn);
  try {
    return await check();
  } finally {
    checkRequests += sent();
  }
}
