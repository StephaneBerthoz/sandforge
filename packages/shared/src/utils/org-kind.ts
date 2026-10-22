/**
 * What kind of org an org is: the one rule every guard, badge, banner and
 * confirmation reads.
 *
 * A Developer Edition org — a Trailhead playground is one — says
 * `IsSandbox` false, as a production org does, and was registered as one: a
 * red PROD badge, a production question before every Seed, Sync or Autopilot
 * run, a DataOps cleanup refused as a delete in production. It holds nobody's
 * business, and those who try SandForge on the org Salesforce gives them for
 * free had nowhere to work. Forge, Frozen and the removals each read the
 * edition to tell it apart; everything else read the type alone. The rule
 * now lives here, and every way of connecting an org, every guard and every
 * badge reads it:
 *
 * - a scratch org, and a sandbox, are what they say they are;
 * - an org that is neither and says it is a Developer Edition is a
 *   development org, typed `Developer`;
 * - any other org is a production org, with every guard a production org has
 *   — and so is an org whose edition was never read, or whose stored type is
 *   none of these: nothing then shows it holds nobody's business.
 */

import { OrgSafetyTier } from '../types/org.types.js';
import type { OrgType } from '../types/org.types.js';

/** The tier Production Guard judges an operation on an org by. */
export type GuardTier = 'production' | 'staging' | 'development' | 'scratch';

/** What Salesforce says of an org, as each way of connecting one reads it. */
export interface OrgFacts {
  /** `Organization.IsSandbox`, or the CLI's `isSandbox`. A scratch org says true. */
  isSandbox?: boolean;
  /** Whether the CLI lists the org as a scratch org. */
  isScratch?: boolean;
  /** `Organization.OrganizationType` ("Developer Edition"), or the CLI's `orgEdition`. */
  edition?: unknown;
}

/** An org as the registry, a picker or a guard holds it: its type and the edition kept with it. */
export interface OrgTypeAndEdition {
  orgType?: string;
  metadata?: { edition?: unknown };
}

/**
 * Whether an edition, as `Organization.OrganizationType` gives it, is a
 * Developer Edition org's. A Trailhead playground is one.
 */
export function isDeveloperEdition(edition: unknown): boolean {
  return typeof edition === 'string' && edition.trim().toLowerCase() === 'developer edition';
}

/**
 * The type an org is registered with, from what Salesforce says of it.
 *
 * @param facts - Whether it is a scratch org or a sandbox, and its edition.
 */
export function orgTypeOf(facts: OrgFacts): OrgType {
  if (facts.isScratch === true) return 'Scratch';
  if (facts.isSandbox === true) return 'Sandbox';
  return isDeveloperEdition(facts.edition) ? 'Developer' : 'Production';
}

/** The guard's tier of each type an org is registered with. */
const GUARD_TIERS: Readonly<Record<string, GuardTier>> = {
  Production: 'production',
  Sandbox: 'development',
  Scratch: 'scratch',
  Developer: 'development',
};

/** The guard's tier of a type alone; own keys only, any other type is production. */
function tierOfType(orgType: string): GuardTier {
  return Object.prototype.hasOwnProperty.call(GUARD_TIERS, orgType)
    ? GUARD_TIERS[orgType]
    : 'production';
}

/**
 * The type a registered org is read with. Builds before this rule registered
 * a Developer Edition org as `Production`, its edition kept beside the type:
 * such an org is read as the `Developer` org it is, and so is one whose type
 * the guard does not know — no production org says it is a Developer
 * Edition, a sandbox says the edition of the org it was made from. Any other
 * type is read as stored.
 *
 * @param orgType - The type it was registered with.
 * @param edition - Its edition, as kept when it was connected.
 */
export function registeredOrgType(orgType: string, edition: unknown): string {
  return tierOfType(orgType) === 'production' && isDeveloperEdition(edition)
    ? 'Developer'
    : orgType;
}

/**
 * Maps an org's type, and its edition, to a ProductionGuard safety tier.
 * This maps to the guard-level tiers (production/staging/development/scratch),
 * NOT to the UX-level `OrgSafetyTier` enum (critical/high/medium/low).
 *
 * A Developer Edition org registered as `Production` is read as the
 * development org it is ({@link registeredOrgType}); handed no edition, the
 * type alone decides.
 *
 * A type the map does not list gets 'production', the most restrictive tier.
 * Callers pass '' for an org the registry does not know, and a stored type
 * can fall outside `OrgType`: nothing then shows the org is a sandbox. The
 * former 'development' default let a write to such an org skip the production
 * confirmation and a delete skip the production block. Own keys only, for the
 * same reason: a stored type is data, and 'constructor' must not come back as
 * a tier.
 *
 * @param orgType - The type the org was registered with.
 * @param edition - Its edition, as kept when it was connected.
 */
export function orgTypeToGuardTier(orgType: string, edition?: unknown): GuardTier {
  return tierOfType(registeredOrgType(orgType, edition));
}

/**
 * The guard's tier of an org as the registry holds it: {@link orgTypeToGuardTier}
 * of its type and edition. An org the registry does not know is a production org.
 */
export function guardTierOf(org: OrgTypeAndEdition | undefined): GuardTier {
  return orgTypeToGuardTier(org?.orgType ?? '', org?.metadata?.edition);
}

/**
 * Whether an org is one SandForge fills without a production org's guards: a
 * sandbox, a scratch org or a Developer Edition org.
 */
export function isDevelopmentOrg(org: OrgTypeAndEdition | undefined): boolean {
  return guardTierOf(org) !== 'production';
}

/** The colour an org takes until the user picks one: red for production, blue otherwise. */
export const PRODUCTION_ORG_COLOR = '#e74c3c';

/** The colour of every org that is not a production org, until the user picks one. */
export const DEVELOPMENT_ORG_COLOR = '#4a9eff';

/**
 * What an org of a type is registered with beside it: the safety tier its
 * badge is coloured by, and the colour it takes until the user picks one.
 * Production orgs are critical; sandboxes may hold production-shaped data so
 * they sit one tier above scratch and Developer Edition orgs (medium vs low).
 * A type none of these is a production org's.
 */
export function orgRegistrationOf(orgType: string): {
  safetyTier: OrgSafetyTier;
  color: string;
} {
  switch (orgType) {
    case 'Sandbox':
      return { safetyTier: OrgSafetyTier.MEDIUM, color: DEVELOPMENT_ORG_COLOR };
    case 'Scratch':
    case 'Developer':
      return { safetyTier: OrgSafetyTier.LOW, color: DEVELOPMENT_ORG_COLOR };
    default:
      return { safetyTier: OrgSafetyTier.CRITICAL, color: PRODUCTION_ORG_COLOR };
  }
}

/**
 * The expiration date of a scratch org that is past it, or undefined.
 *
 * Such an org is deleted: its token is refused, and the CLI it would be
 * refreshed through no longer holds a session for it either. Checking it cost
 * an identity call and an `sf org display` in every window, each time a window
 * opened, for an org that stays expired until the user removes or replaces it.
 *
 * @param today - The current day, `YYYY-MM-DD`.
 */
export function expiredScratchDate(
  org: { orgType: string; metadata?: { expirationDate?: string } },
  today: string,
): string | undefined {
  const expires = org.metadata?.expirationDate;
  if (org.orgType !== 'Scratch' || typeof expires !== 'string') return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(expires) && expires < today ? expires : undefined;
}
