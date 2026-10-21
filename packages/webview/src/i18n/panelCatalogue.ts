/**
 * The English a panel starts with: the namespaces of the catalogue its shell
 * renders — the toasts, the command palette, the skip link, the error
 * boundary, the bridge's notices, the page names.
 *
 * Every panel parsed the whole catalogue, about 270 kB, before its page could
 * paint. The panel build points `./locales/en.json` here (vite.config.ts), as
 * the sidebar build points it at sidepanelCatalogue.ts; each page brings the
 * namespaces it renders when it loads (PanelRouter, englishNamespaces.ts).
 * Named imports let the bundler leave the other namespaces out, and nothing
 * else imports the catalogue in a build: the pages' namespaces are modules of
 * their own. The path is spelled from the parent folder so that alias does
 * not bring this module back to itself. src/PanelRouter.english.test.ts
 * checks these are the namespaces the shell renders keys from.
 */
import {
  a11y,
  bridge,
  commandPalette,
  common,
  errorBoundary,
  home,
  nav,
} from '../i18n/locales/en.json';

export default { a11y, bridge, commandPalette, common, errorBoundary, home, nav };
