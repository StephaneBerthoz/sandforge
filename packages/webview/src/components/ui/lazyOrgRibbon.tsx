import { lazy } from 'react';
import type { OrgRibbonProps } from './OrgRibbon';

/**
 * The ribbon's module, for the pages that open on a screen it is not on.
 *
 * Forge opens on its input, and Frozen Dataset on Extract: every panel showing
 * either parsed it before a first screen that does not draw it. A ribbon whose
 * chunk cannot be read is left out: what it says is said on the screens around
 * it, and it takes nothing down with it.
 */
export const loadOrgRibbon = (): Promise<{ default: React.FC<OrgRibbonProps> }> =>
  import('./OrgRibbon').then(
    (module) => ({ default: module.OrgRibbon }),
    () => ({ default: () => null }),
  );

/** The ribbon of the two orgs, in a chunk of its own fetched the first time it is drawn. */
export const LazyOrgRibbon = lazy(loadOrgRibbon);
