import type { SalesforceOrg } from '@sandforge/shared';

/** An org this machine no longer holds, of which nothing but its id is known. */
export interface OrgRibbonNotHeld {
  notHeld: string;
}

/**
 * An org as the ribbon of the two orgs names it: as the store holds it, by a
 * name alone for one this machine does not hold, or by its id alone for one
 * it does not hold and nothing names.
 */
export type OrgRibbonOrg = SalesforceOrg | string | OrgRibbonNotHeld | undefined;

/** Whether `org` is known by its id alone. */
export function isNotHeld(org: OrgRibbonOrg): org is OrgRibbonNotHeld {
  return typeof org === 'object' && 'notHeld' in org;
}

/**
 * The org the ribbon names for `id`: the one this machine holds, else the
 * name the page knows it by, else the id alone, said as an org this machine
 * no longer holds. Printed as a name, an id read as an alias nobody had
 * given: a frozen dataset whose manifest kept no alias, once its org was
 * logged out of, was said to come from `00D…`.
 *
 * Apart from the ribbon, whose chunk the pages that open on a screen it is
 * not on fetch the first time they draw it: they name its orgs before.
 *
 * @param orgs - The orgs this machine holds.
 * @param id - The org's id in that registry, as the page keeps it.
 * @param name - What the page knows it by otherwise: a manifest's alias.
 */
export function ribbonOrg(
  orgs: readonly SalesforceOrg[],
  id: string | null | undefined,
  name?: string | null,
): OrgRibbonOrg {
  if (!id) return name || undefined;
  return orgs.find((org) => org.id === id) ?? (name || { notHeld: id });
}
