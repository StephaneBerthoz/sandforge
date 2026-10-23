/**
 * What an org says it is when asked live, and how many requests a connection
 * sends it.
 *
 * The rule is the panel's (`orgTypeOf`, `orgTypeToGuardTier`): a sandbox, a
 * scratch org and a Developer Edition org are development orgs, any other a
 * production org, and so is one that will not say. The command lines read it
 * from the org itself before they write, since an alias left pointing at a
 * production org in a CI job is not one the registry ever saw; a checkpoint
 * reads it from the org as well as from the registry, and refuses unless both
 * say development. Both live here, where the extension can reach them: `cli/`
 * re-exports them, and nothing under `src/` may import from `cli/`.
 */

import type { Connection } from 'jsforce';
import { orgTypeOf, orgTypeToGuardTier } from '@sandforge/shared';

/** An org as a live read types it: a sandbox, or not and its edition. */
export interface TypedTarget {
  /** `Organization.Id`. */
  id: string;
  sandbox: boolean;
  /** `Organization.OrganizationType`, read only for an org that is not a sandbox. */
  edition?: string;
}

/** What the org says it is. `IsSandbox` false and no edition is a production org's. */
export async function typeTarget(conn: Pick<Connection, 'query'>): Promise<TypedTarget> {
  const answer = await conn.query<{ Id?: string; IsSandbox?: boolean }>(
    'SELECT Id, IsSandbox FROM Organization LIMIT 1',
  );
  const row = answer.records[0];
  if (typeof row?.Id !== 'string') {
    throw new Error('The org gave no Organization record: whether it is a sandbox cannot be told.');
  }
  if (row.IsSandbox === true) return { id: row.Id, sandbox: true };
  try {
    const typed = await conn.query<{ OrganizationType?: string }>(
      'SELECT OrganizationType FROM Organization LIMIT 1',
    );
    const edition = typed.records[0]?.OrganizationType;
    return typeof edition === 'string' && edition !== ''
      ? { id: row.Id, sandbox: false, edition }
      : { id: row.Id, sandbox: false };
  } catch {
    return { id: row.Id, sandbox: false };
  }
}

/** Whether the panel's guard takes an org typed so for a production org. */
export function isProductionTarget(org: TypedTarget): boolean {
  const orgType = orgTypeOf({ isSandbox: org.sandbox, edition: org.edition });
  return orgTypeToGuardTier(orgType, org.edition) === 'production';
}

/** The path of a SOAP endpoint: the partner API's, the Metadata API's, any other. */
const SOAP_ENDPOINT = /\/services\/Soap\//;

/** The path of a Bulk API 2.0 job's endpoint: an ingest or a query job, and each of its parts. */
const BULK_JOB_ENDPOINT = /\/services\/data\/v\d+\.\d+\/jobs\/(?:ingest|query)(?:[/?]|$)/;

/** The same path as `request` takes it from the API's version root, which it puts before it. */
const BULK_JOB_FROM_VERSION_ROOT = /^\/jobs\/(?:ingest|query)(?:[/?]|$)/;

/** Whether the URL a call of the connection's `request` names, as a string or as a request's, is a job's. */
function isBulkJobCall(request: Parameters<Connection['request']>[0] | undefined): boolean {
  const url = typeof request === 'string' ? request : (request?.url ?? '');
  return BULK_JOB_ENDPOINT.test(url) || BULK_JOB_FROM_VERSION_ROOT.test(url);
}

/**
 * Count each request `conn` sends from now on, and return what reads the count.
 *
 * A query and each further page of it, a describe the connection does not
 * already hold, a write of up to 200 records, a file read or written: each
 * goes out through the connection's `request`, and is counted there, the same
 * requests whichever method sent them.
 *
 * SOAP calls do not. jsforce's SOAP class sends each one through an HTTP
 * client of its own, straight to the connection's transport, so the org's
 * clock (`getServerTimestamp`) and every undelete of up to 200 records went
 * uncounted: a live run made 17 such calls that the count never showed,
 * though each counts against the org's daily requests as any other call
 * does. Nor do the calls of a Bulk API 2.0 job, which jsforce's Bulk class
 * sends the same way: asked live, a job of 200 deletes cost five of the
 * day's requests — opened, its CSV sent, closed, its state read twice — the
 * records none. Both are counted at the transport, by their endpoint, once
 * per call sent; a job's call sent through `request` is counted there alone,
 * never twice. A connection with no transport of its own, as a test's
 * stand-in has, counts its `request` alone.
 */
export function countRequests(conn: Connection): () => number {
  let sent = 0;
  const transport: Connection['_transport'] | undefined = conn._transport;
  const send = conn.request.bind(conn) as Connection['request'];
  conn.request = <R>(...args: Parameters<Connection['request']>) => {
    if (transport === undefined || !isBulkJobCall(args[0])) sent++;
    return send<R>(...args);
  };
  if (transport !== undefined) {
    const carry = transport.httpRequest.bind(transport);
    transport.httpRequest = (...args: Parameters<Connection['_transport']['httpRequest']>) => {
      const url = args[0].url;
      if (SOAP_ENDPOINT.test(url) || BULK_JOB_ENDPOINT.test(url)) sent++;
      return carry(...args);
    };
  }
  return () => sent;
}
