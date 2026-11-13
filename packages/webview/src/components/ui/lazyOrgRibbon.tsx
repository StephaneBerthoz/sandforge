import type { OrgRibbonProps } from './OrgRibbon';
import { lazyOnce, loadOnce } from '../../utils/loadOnce';

/**
 * The ribbon's module, for the pages that open on a screen it is not on.
 *
 * Forge opens on its input, and Frozen Dataset on Extract: every panel showing
 * either parsed it before a first screen that does not draw it. A ribbon whose
 * chunk cannot be read is left out: what it says is said on the screens around
 * it, and it takes nothing down with it.
 *
 * Loaded once for the ribbon and for Forge's preload of it alike (`loadOnce`):
 * fetched while discovery is read, it still suspended as Review was first
 * drawn, came some 100 milliseconds after it, and moved Review 79 pixels down.
 */
export const loadOrgRibbon = loadOnce((): Promise<{ default: React.FC<OrgRibbonProps> }> =>
  import('./OrgRibbon').then(
    (module) => ({ default: module.OrgRibbon }),
    () => ({ default: () => null }),
  ),
);

/** The ribbon of the two orgs, in a chunk of its own fetched the first time it is drawn. */
export const LazyOrgRibbon = lazyOnce(loadOrgRibbon);
