/** The codes a connection failure the user can act on is named by. */
export type OrgConnectionErrorCode =
  | 'ORG_AUTH_EXPIRED'
  | 'ORG_TEMPORARILY_UNREACHABLE'
  /** A scratch org past its expiration date: Salesforce deleted it, and no reconnect brings it back. */
  | 'SCRATCH_ORG_EXPIRED';

/**
 * A connection that failed in a way the user can act on, named by a code and
 * the org it is about: the panels word the code in the user's language and
 * offer Reconnect where it failed, and the message starts with the code, as a
 * Salesforce refusal does, for whatever reads the text alone.
 *
 * The two cases used to be English sentences only, which sent the user to "the
 * Orgs page (SFDX import)", by names the UI does not use, or to a terminal
 * command, and told them a "circuit breaker" was open.
 */
export class OrgConnectionError extends Error {
  /**
   * @param code - What failed.
   * @param orgId - The org it failed for.
   * @param detail - What the user reads after the code.
   */
  constructor(
    readonly code: OrgConnectionErrorCode,
    readonly orgId: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'OrgConnectionError';
  }
}
