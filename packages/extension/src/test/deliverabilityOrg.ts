/**
 * What an org answers the read of whether it delivers the emails of its
 * automation (`readEmailDeliverability`), for the fake connections of the
 * tests of a run: the answers a Developer Edition switched through Setup >
 * Deliverability's three levels gave its one line of anonymous Apex, and the
 * Send Email of the user it reads as, which the read asks only after a
 * refusal. Every other request goes on to the fake's own answer, and each
 * read is counted.
 */

import { DELIVERABILITY_APEX, EMAIL_NOT_PERMITTED } from '../modules/forge/targetDeliverability.js';

/** A level of Setup > Deliverability as the read tells it: All email, or System email only and No access. */
export type DeliverabilityLevel = 'all' | 'withheld';

/** What the Tooling API answered `Messaging.reserveSingleEmailCapacity(1);` with, by level. */
export const ANONYMOUS_ANSWERS: Readonly<Record<DeliverabilityLevel, unknown>> = {
  all: {
    compiled: true,
    success: true,
    compileProblem: null,
    exceptionStackTrace: null,
    exceptionMessage: null,
  },
  withheld: {
    compiled: true,
    success: false,
    compileProblem: null,
    exceptionStackTrace: 'AnonymousBlock: line 1, column 1',
    exceptionMessage: EMAIL_NOT_PERMITTED,
  },
};

/** A request as jsforce's `request` takes it: a URL, or a method and a URL. */
type AnyRequest = string | { method?: string; url: string };

/** The URL of a request. */
function urlOf(request: AnyRequest): string {
  return typeof request === 'string' ? request : request.url;
}

/**
 * The fake's `request`, answering the read of its deliverability at `level`
 * and handing anything else to `otherwise`. `asked` counts the reads' own
 * requests: the Apex and, after a refusal, the user's Send Email.
 *
 * @param asked - Where the requests are counted: one list for every
 *   connection a test makes to the org, when given.
 */
export function answeringDeliverability(
  level: DeliverabilityLevel,
  otherwise: (request: AnyRequest) => Promise<unknown>,
  asked: string[] = [],
): { request: (request: AnyRequest) => Promise<unknown>; asked: string[] } {
  const request = async (req: AnyRequest): Promise<unknown> => {
    const url = urlOf(req);
    if (url.includes('?anonymousBody=')) {
      const body = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('anonymousBody');
      if (body !== DELIVERABILITY_APEX) throw new Error(`Not the read's Apex: ${String(body)}`);
      asked.push('apex');
      return ANONYMOUS_ANSWERS[level];
    }
    if (url.startsWith('/query') && url.includes('UserPermissionAccess')) {
      asked.push('sendEmail');
      return { totalSize: 1, done: true, records: [{ PermissionsEmailSingle: true }] };
    }
    return otherwise(req);
  };
  return { request, asked };
}
