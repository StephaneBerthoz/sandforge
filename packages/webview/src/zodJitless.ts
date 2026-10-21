/**
 * zod, as the webview imports it.
 *
 * zod 4 compiles each object schema into a function with `new Function`, and
 * first probes whether it may. A webview's content security policy allows no
 * eval: the probe throws and zod falls back, but the refused `new Function` is
 * still reported as a `script-src` violation, one per panel start.
 *
 * zod reads the setting as each schema is built, not as it parses, so it has
 * to be in place before the shared schemas are. The webview builds resolve
 * `zod` to this module (ZOD_WITHOUT_EVAL in vite.config.ts): a module runs
 * before every module that imports it, so the call below runs before any
 * schema is built, whichever page loads zod first. It used to be the first
 * import of each entry instead, which made every panel and the sidebar parse
 * zod, about 100 kB, for the few pages that validate anything. It reads zod
 * from `zod/v4`, the same modules under a name the alias leaves alone.
 */
import * as z from 'zod/v4';

z.config({ jitless: true });

export * from 'zod/v4';
export { default } from 'zod/v4';
