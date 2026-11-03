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

import { seedDependencies, type SeedTemplate } from '@sandforge/shared';
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

/**
 * The template a seed's storage gate and its fit count: without its optional
 * objects the org takes no record of, nor the objects that hang from them,
 * which the run skips. Counted, an org without Knowledge had the fit cut its
 * other objects to make room for a hundred articles it would never hold, and
 * name them in its table. Reads the org only for a template that has one; a
 * read that fails tells nothing, and the object is counted.
 */
export async function templateTheOrgTakes<T extends Pick<SeedTemplate, 'objects' | 'relations'>>(
  template: T,
  access: (objectApiName: string) => Promise<SeedObjectAccess>,
): Promise<T> {
  const closed = new Set<string>();
  for (const { objectApiName, optional } of template.objects) {
    if (optional !== true) continue;
    try {
      if ((await access(objectApiName)).access !== 'createable') closed.add(objectApiName);
    } catch {
      // Nothing can tell: the run asks the org the same, and goes on the same.
    }
  }
  if (closed.size === 0) return template;
  // What hangs from a closed object is skipped with it, as the run skips an
  // object whose parents wrote nothing (`seedDependencies`), and what hangs
  // from that in turn. Kept, a campaign's members lost only their relation:
  // counted as a root, the gate refused a seed that fit, and the fit cut the
  // other objects for members the run never wrote.
  for (let grew = true; grew;) {
    grew = false;
    for (const object of template.objects) {
      if (closed.has(object.objectApiName)) continue;
      if (seedDependencies(object, template.relations).some((name) => closed.has(name))) {
        closed.add(object.objectApiName);
        grew = true;
      }
    }
  }
  return {
    ...template,
    objects: template.objects.filter((object) => !closed.has(object.objectApiName)),
    ...(template.relations
      ? {
          relations: template.relations.filter(
            ({ childObject, parentObject }) =>
              !closed.has(childObject) && !closed.has(parentObject),
          ),
        }
      : {}),
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
