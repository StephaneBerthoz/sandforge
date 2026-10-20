/**
 * The English the sidebar reads: its own namespaces of the panel catalogue.
 *
 * The sidebar bundle is the one every VS Code window loads, and it carried the
 * whole catalogue, 3 700 keys and about 250 kB, to show some fifty of them;
 * VS Code destroys the view each time it is hidden, so each reveal parsed it
 * again. The sidebar build points `./locales/en.json` here (vite.config.ts).
 * Named imports let the bundler leave the other namespaces out; the path is
 * spelled from the parent folder so that alias does not bring this module
 * back to itself.
 *
 * The extension answers the sidebar's request for another language with the
 * same namespaces (SIDEPANEL_LOCALE_NAMESPACES in @sandforge/shared), and the
 * sidebar entry's test checks that every key the sidebar renders is in one.
 */
import { common, errorBoundary, home, nav, sidePanel } from '../i18n/locales/en.json';

export default { common, errorBoundary, home, nav, sidePanel };
