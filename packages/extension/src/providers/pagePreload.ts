import * as z from 'zod';

/**
 * What the webview build writes in `webview-dist/assets/preload.json`
 * (packages/webview/src/build/pagePreload.ts): by route, the files of
 * `webview-dist` its page needs before it paints, the panel bundle aside.
 * Each is a script of `assets/`, by a name the build gave it: anything else
 * is not one, and the shell links nothing for it.
 */
const pagePreloadSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9-]{0,63}$/),
  z.array(z.string().regex(/^assets\/(?:chunks\/)?[\w-]+(?:\.[\w-]+)*\.js$/)).max(500),
);

/**
 * The files each route's page needs before it paints, read from the text of
 * the build's preload list. Nothing for a list that is absent or malformed:
 * the page then loads as it did before the list, one round of imports after
 * another.
 *
 * @param text - The file's text, or undefined when it could not be read.
 */
export function parsePagePreload(text: string | undefined): ReadonlyMap<string, readonly string[]> {
  if (text === undefined) return new Map();
  try {
    const parsed = pagePreloadSchema.safeParse(JSON.parse(text));
    return parsed.success ? new Map(Object.entries(parsed.data)) : new Map();
  } catch {
    return new Map();
  }
}
