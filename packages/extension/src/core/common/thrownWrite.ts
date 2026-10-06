/**
 * What a write call that threw, in place of an answer, left in the target.
 *
 * Forge writes through REST sObject Collections with `allOrNone` false: each
 * row of a call is committed on its own, and the answer says which went in. A
 * call that throws has no answer, and what it threw is all there is to tell
 * whether the target got it:
 *
 * - it never reached the target — no connection (`ECONNREFUSED`), no address
 *   for the host (`ENOTFOUND`, `EAI_AGAIN`), the edge answering for the org
 *   that it is unavailable (503) or that the call came too soon (429): the
 *   target holds none of its rows, and sent again they cannot be written twice;
 * - the target answered and refused the call whole — an error code of its own,
 *   the edge refusing the request (4xx) — or the call threw before any request
 *   went out: nothing was written;
 * - the target refused it for its API request limit (`REQUEST_LIMIT_EXCEEDED`):
 *   nothing was written, and no retry gets past it;
 * - the request went out and its answer never came back — a timeout, a
 *   connection reset or broken once the request was out, the edge saying the
 *   org failed it (502, 504, another 5xx): the target may have written any of
 *   its rows, and which of them is unknown. Sent again, those it wrote would be
 *   written twice.
 *
 * A 502 is not taken to prove the target never had the call: the edge gives it
 * when it cannot connect to the org, and also when the org drops a connection
 * it held the request on — after the commit as much as before it.
 *
 * jsforce 3.10.14 throws what node-fetch throws for a socket (`FetchError`,
 * with the system error's `code`), an `AbortError` once its 30-minute timeout
 * cuts a request, and an `HttpApiError` for an HTTP error: its `errorCode` is
 * Salesforce's own when the body was an API error, and `ERROR_HTTP_<status>`
 * when it was not — a page from the edge. It sends a POST or a PATCH once:
 * its own retries are for the methods that can be repeated.
 */

import { extractErrorMessage } from './extractErrorMessage.js';

/** What a write call that threw left in the target: see the module's header. */
export type ThrownWrite = 'not-received' | 'not-written' | 'request-limit' | 'may-have-written';

/** The code a call is refused with for the org's API request limit. */
const REQUEST_LIMIT = 'REQUEST_LIMIT_EXCEEDED';

/**
 * System error codes of a connection never made: the org refused it, or no
 * address was found for its host. A reset, a timeout or a broken pipe can come
 * once the request is out, and so can an unreachable host or network, which a
 * route lost in the middle of a call gives too.
 */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
]);

/** The same codes, as a message alone says them. */
const NEVER_CONNECTED_RE = /\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EAI_FAIL)\b/;

/**
 * What says, in a message alone, that a call broke once it was out — or that
 * it failed with nothing to say where: undici's `fetch failed` hands the
 * system error over on `cause`, read before the message.
 */
const BROKEN_ONCE_OUT_RE =
  /\b(?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|ECONNABORTED|socket hang up|timed? ?out|aborted|fetch failed)\b/i;

/**
 * HTTP statuses the edge answers in place of an org that never had the call:
 * unavailable, or asked too soon.
 */
const NOT_RECEIVED_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/** jsforce's code for an HTTP error whose body was not an API error. */
const EDGE_STATUS_RE = /^ERROR_HTTP_(\d{3})$/;

/** An API error code, as jsforce puts it on `errorCode`. */
const API_CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Names jsforce's transport gives an error that cut a request once it was out. */
const CUT_ONCE_OUT: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError', 'FetchError']);

/** The parts of a thrown value that say where the call broke, each read only when it is a string. */
function partsOf(err: unknown): {
  errorCode?: string;
  code?: string;
  name?: string;
  cause?: unknown;
} {
  if (typeof err !== 'object' || err === null) return {};
  const { errorCode, code, name, cause } = err as {
    errorCode?: unknown;
    code?: unknown;
    name?: unknown;
    cause?: unknown;
  };
  return {
    ...(typeof errorCode === 'string' ? { errorCode } : {}),
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
}

/**
 * What the write call that threw `err` left in the target. A system error of
 * a code read nowhere here broke the call where it may have been out, and is
 * taken so: reported as written when it was not, a row is only said to be
 * uncertain; reported as not written when it was, it is in the target and in
 * no count of the run's, nor in what its removal takes back.
 */
export function whatTheWriteLeft(err: unknown): ThrownWrite {
  const { errorCode, code, name, cause } = partsOf(err);
  if (errorCode !== undefined) {
    if (errorCode === REQUEST_LIMIT) return 'request-limit';
    const status = EDGE_STATUS_RE.exec(errorCode)?.[1];
    if (status !== undefined) {
      const answered = Number(status);
      if (NOT_RECEIVED_STATUSES.has(answered)) return 'not-received';
      return answered < 500 ? 'not-written' : 'may-have-written';
    }
    if (API_CODE_RE.test(errorCode)) return 'not-written';
  }
  if (code !== undefined) return NEVER_CONNECTED.has(code) ? 'not-received' : 'may-have-written';
  if (cause !== undefined) {
    const underneath = whatTheWriteLeft(cause);
    if (underneath !== 'not-written') return underneath;
  }
  if (name !== undefined && CUT_ONCE_OUT.has(name)) return 'may-have-written';
  const message = extractErrorMessage(err);
  if (message.startsWith(REQUEST_LIMIT)) return 'request-limit';
  if (NEVER_CONNECTED_RE.test(message)) return 'not-received';
  if (BROKEN_ONCE_OUT_RE.test(message)) return 'may-have-written';
  return 'not-written';
}
