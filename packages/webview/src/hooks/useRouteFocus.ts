import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * How long a page drawn without its heading — its chunk still loading, or the
 * data it shows its heading with (Monitor's first read) — is watched for the
 * heading, the main landmark holding the focus meanwhile. Watching costs
 * nothing: a user who moves the focus meanwhile keeps it.
 */
const PAGE_WAIT_MS = 15_000;

/** The `main` every panel renders its page into (PanelApp). */
const MAIN_ID = 'main-content';

/**
 * Whether the focus is somewhere a route change may take it from: nowhere
 * (the control that navigated unmounted with its page), or the main landmark.
 * A control of the new page that took the focus on mount keeps it, and so
 * does an overlay or the palette open over the page.
 */
function focusIsFree(main: HTMLElement): boolean {
  const focused = document.activeElement;
  return focused === null || focused === document.body || focused === main;
}

/**
 * Tell a keyboard and screen-reader user that the panel moved to another page.
 *
 * Every page change remounts the whole page, so the control that navigated —
 * a call to action, a palette item — is gone, the focus fell to `<body>` and
 * the next Tab started over at the skip link, with nothing said about the new
 * page. Once the new page has committed, its `h1` takes the focus (PageHeader
 * renders it with `tabIndex={-1}`), so a screen reader reads where the user
 * now is; a page with no heading hands it to the main landmark. The first
 * render moves nothing: a panel opening on its own page leaves the focus where
 * VS Code put it.
 *
 * The document's title names the page too, in the form the panel's tab has
 * (`SandForge: <page>`), in the panel's language.
 */
export function useRouteFocus(route: string): void {
  const { t } = useTranslation();
  const pageName = t(`nav.${route}`, { defaultValue: route });

  useEffect(() => {
    document.title = `SandForge: ${pageName}`;
  }, [pageName]);

  // The route the focus was last settled for. A ref rather than a first-render
  // flag: StrictMode runs a mount's effect twice, and the second run must not
  // read as a navigation.
  const settled = useRef(route);
  useEffect(() => {
    if (settled.current === route) return undefined;
    settled.current = route;
    const main = document.getElementById(MAIN_ID);
    if (!main) return undefined;

    let watcher: MutationObserver | null = null;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const stopWatching = (): void => {
      watcher?.disconnect();
      watcher = null;
      clearTimeout(giveUp);
    };
    /** What the focus was last handed to: the page's heading, or the main landmark. */
    let given: HTMLElement | null = null;
    const settle = (): void => {
      given = main.querySelector<HTMLElement>('h1') ?? main;
      given.focus();
      if (document.activeElement !== given) {
        given = main;
        main.focus();
      }
    };
    // After the page has committed and painted, as the wizard waits for its step.
    const frame = requestAnimationFrame(() => {
      if (!focusIsFree(main)) return;
      settle();
      // A page drawn without its heading — its chunk, or the data it shows
      // its heading with, on its way — holds the focus on the main landmark,
      // and its heading takes it once drawn; a heading a loading page drew
      // and then took away hands it on too. The page is watched until the
      // user moves the focus elsewhere.
      watcher = new MutationObserver(() => {
        const focused = document.activeElement;
        if (focused === given && given !== main) return;
        const dropped =
          (focused === null || focused === document.body) && given?.isConnected === false;
        if (focused === main || dropped) settle();
        else stopWatching();
      });
      watcher.observe(main, { childList: true, subtree: true });
      giveUp = setTimeout(stopWatching, PAGE_WAIT_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      stopWatching();
    };
  }, [route]);
}
