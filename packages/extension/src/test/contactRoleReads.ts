/**
 * How a test's target answers the read of the contact roles of some
 * opportunities (`contactRolesSoql`), as a real org answers it: each role
 * held under one of them, with the relationship field of its opportunity —
 * when and by whom it was made — filled from the opportunity's record, or
 * null where the target holds no such record.
 *
 * In the order the roles are held, whatever order the read asks. A scratch
 * org answered the same read, asked with no order, with a role made by hand
 * four seconds after the platform's first, once in five: a test that holds
 * the later role first shows the run tells the platform's by its dates, and
 * not by the order the org answers in.
 *
 * A target writes the platform's role as it takes the opportunity, dated
 * {@link WENT_IN} by {@link RUN_USER}, as both: in a real org they were dated
 * to the second alike, by the user the run writes as.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

/** The user a test's run writes as, in the target. */
export const RUN_USER = '005TGT000000001AAA';

/** When a test's target dates what the run writes, as the org answers a date. */
export const WENT_IN = '2026-11-09T11:47:00.000+0000';

/** What a target stamps on an opportunity it takes, and on the role it writes with it. */
export const MADE_BY_THE_RUN: Readonly<{ CreatedDate: string; CreatedById: string }> = {
  CreatedDate: WENT_IN,
  CreatedById: RUN_USER,
};

/** `seconds` after {@link WENT_IN}, as the org answers a date. */
export function secondsAfterItWentIn(seconds: number): string {
  return new Date(Date.parse(WENT_IN) + seconds * 1000).toISOString().replace('Z', '+0000');
}

const ROLES_READ =
  /^SELECT .+? FROM OpportunityContactRole WHERE OpportunityId IN \(([^)]*)\)(?: ORDER BY [\w, ]+)?$/;

/**
 * The rows a target answers `soql` with, when it is a read of the contact
 * roles of some opportunities; undefined for any other statement.
 *
 * @param roles - The roles the target holds, in the order it answers them.
 * @param opportunityOf - The target's record of an opportunity, by its id.
 */
export function answerContactRoles(
  soql: string,
  roles: Iterable<Readonly<Record<string, unknown>>>,
  opportunityOf: (id: string) => Readonly<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  const asked = ROLES_READ.exec(soql);
  if (!asked) return undefined;
  const ids = new Set([...asked[1].matchAll(/'([^']*)'/g)].map(([, id]) => id.slice(0, 15)));
  return [...roles]
    .filter((role) => typeof role['OpportunityId'] === 'string')
    .filter((role) => ids.has(String(role['OpportunityId']).slice(0, 15)))
    .map((role) => {
      const opportunity = opportunityOf(String(role['OpportunityId']));
      return {
        ...role,
        Opportunity: opportunity
          ? {
              CreatedDate: opportunity['CreatedDate'] ?? null,
              CreatedById: opportunity['CreatedById'] ?? null,
            }
          : null,
      };
    });
}
