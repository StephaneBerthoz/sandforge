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
import { isAuthError } from '../common/isAuthError.js';
import { isNetworkError } from '../common/isNetworkError.js';

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

/**
 * Whether the org refused its Organization record to the user the session
 * signs in as: no access to the object, or an object the user's profile does
 * not show at all. Reading it takes View Setup and Configuration.
 */
export function organizationRefused(err: unknown): boolean {
  const { errorCode, statusCode } = (typeof err === 'object' && err !== null ? err : {}) as {
    errorCode?: unknown;
    statusCode?: unknown;
  };
  const message = err instanceof Error ? err.message : String(err);
  return (
    statusCode === 403 ||
    (typeof errorCode === 'string' && /^INSUFFICIENT_ACCESS/.test(errorCode)) ||
    /\bINSUFFICIENT_ACCESS/.test(message) ||
    ((errorCode === 'INVALID_TYPE' || /\bINVALID_TYPE\b/.test(message)) &&
      /\bOrganization\b/.test(message))
  );
}

/**
 * Why an org could not be typed, where something lifts it: the session was
 * refused, the org did not answer, or its user may not read the Organization
 * record. Undefined for an org that answered and said nothing of itself,
 * which is taken for a production org.
 */
export type UntypedCause = 'auth' | 'network' | 'organizationRefused';

/** The cause of a failed {@link typeTarget}, when one lifts it. */
export function untypedCauseOf(err: unknown): UntypedCause | undefined {
  if (isAuthError(err)) return 'auth';
  if (isNetworkError(err)) return 'network';
  if (organizationRefused(err)) return 'organizationRefused';
  return undefined;
}

/**
 * What lets an org that could not be typed be typed, in words the page and a
 * command line both read: a guard that said "a production org, or cannot be
 * told from one … nothing lifts this" of an expired session sent the person
 * looking for a production org that was not there.
 */
export function untypedWords(orgName: string, err: unknown, cause: UntypedCause): string {
  const why = err instanceof Error ? err.message : String(err);
  switch (cause) {
    case 'auth':
      return (
        `${orgName} refused the session SandForge holds for it (${why}): reconnect it — ` +
        `Reconnect on the Organizations page, or "sf org login web --alias ${orgName}" for a ` +
        'command line — then try again.'
      );
    case 'network':
      return `${orgName} did not answer (${why}): try again once it answers.`;
    case 'organizationRefused':
      return (
        `${orgName} would not show its Organization record (${why}): reading it takes the View ` +
        'Setup and Configuration permission, which the user SandForge connects as lacks: give ' +
        'it to them, or connect as a user who has it.'
      );
  }
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
 * stand-in has, counts its `request` alone; one with no `request` either
 * sends nothing through it, and counts nothing.
 */
export function countRequests(conn: Connection): () => number {
  let sent = 0;
  if (typeof (conn as Partial<Connection>).request !== 'function') return () => sent;
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
