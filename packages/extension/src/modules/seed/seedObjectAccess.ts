/**
 * What an org lets a seed do with each object it names: create its records,
 * or not, and why — the panel and the command line read it the same way.
 *
 * A built-in template wrote a hundred Knowledge articles into orgs without
 * Knowledge, where `Knowledge__kav` does not exist: every insert was refused
 * and the run ended partial on objects nobody could have written. A campaign
 * is the same for a user without the Marketing User box, which a template
 * cannot assume: the org's describe lists the object, its insert refuses the
 * user.
 */

import type { SeedObjectAccess } from './SeedOrchestrator.js';

/** The part of a connection the reader needs. */
export interface ObjectAccessConnection {
  describeGlobal(): Promise<{ sobjects: Array<{ name: string; createable?: boolean }> }>;
  query(soql: string): PromiseLike<{ records: Array<Record<string, unknown>> }>;
  identity(): Promise<{ user_id: string }>;
}

/** An article version of Salesforce Knowledge, `Knowledge__kav` and its kind. */
const ARTICLE_OBJECT = /__kav$/i;

const CAMPAIGN = 'Campaign';

/** What the org lacks when it has no such object, for the objects a feature brings. */
function featureOf(objectApiName: string): string | undefined {
  return ARTICLE_OBJECT.test(objectApiName)
    ? 'Salesforce Knowledge is not turned on in it'
    : undefined;
}

const MARKETING_USER =
  'a campaign needs the Marketing User box ticked on the user, in Setup > Users';

/** A user id as the identity call gives it, before it becomes query text. */
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/**
 * A reader of what the org lets a seed do with an object, reading the org's
 * object list once, and the running user's Marketing User box once, when a
 * campaign is asked about. A read that fails tells nothing: the object is
 * taken for createable, and the platform answers the insert.
 */
export function seedObjectAccess(
  conn: ObjectAccessConnection,
): (objectApiName: string) => Promise<SeedObjectAccess> {
  let objects: Promise<Map<string, boolean>> | undefined;
  let marketingUser: Promise<boolean> | undefined;
  return async (objectApiName) => {
    objects ??= conn
      .describeGlobal()
      .then(
        (answer) =>
          new Map(answer.sobjects.map((s) => [s.name.toLowerCase(), s.createable === true])),
      );
    const createable = (await objects).get(objectApiName.toLowerCase());
    if (createable === undefined) {
      const reason = featureOf(objectApiName);
      return { access: 'absent', ...(reason ? { reason } : {}) };
    }
    if (objectApiName === CAMPAIGN) {
      marketingUser ??= isMarketingUser(conn);
      if (!createable || !(await marketingUser)) {
        return { access: 'readOnly', reason: MARKETING_USER };
      }
    }
    return createable ? { access: 'createable' } : { access: 'readOnly' };
  };
}

/** Whether the running user may work with campaigns; yes when the org will not say. */
async function isMarketingUser(conn: ObjectAccessConnection): Promise<boolean> {
  try {
    const { user_id: userId } = await conn.identity();
    if (!USER_ID.test(userId)) return true;
    const answer = await conn.query(
      `SELECT UserPermissionsMarketingUser FROM User WHERE Id = '${userId}'`,
    );
    return answer.records[0]?.['UserPermissionsMarketingUser'] !== false;
  } catch {
    return true;
  }
}
