import type { SalesforceOrg } from '@sandforge/shared';
import { isDevelopmentOrg } from '@sandforge/shared';

/** The fields of an org this rule reads: the launcher holds orgs as the extension sends them. */
type OrgFacts = Pick<SalesforceOrg, 'id' | 'status' | 'orgType'> & {
  metadata?: { edition?: unknown };
};

/**
 * Whether an org is one a one-click seed may fill: connected, and a sandbox,
 * a scratch org or a Developer Edition by the rule every guard reads.
 */
export function canFill(org: OrgFacts): boolean {
  return org.status === 'connected' && isDevelopmentOrg(org);
}

/**
 * The org "Fill it with demo data" fills: the selected org when it is one to
 * fill, otherwise the first connected org that is. None when every connected
 * org is a production org, or none is connected: no call to action offers to
 * seed a production org.
 *
 * @param orgs - The orgs the panel knows.
 * @param selectedOrgId - The org selected in the panel, if any.
 */
export function orgToFill<T extends OrgFacts>(
  orgs: readonly T[],
  selectedOrgId: string | null | undefined,
): T | undefined {
  const selected = orgs.find((org) => org.id === selectedOrgId);
  if (selected && canFill(selected)) return selected;
  return orgs.find(canFill);
}
