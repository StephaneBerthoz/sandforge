/**
 * zod 4 compiles each object schema into a function with `new Function`, and
 * first probes whether it may. A webview's content security policy allows no
 * eval: the probe throws and zod falls back, but the refused `new Function` is
 * still reported as a `script-src` violation, one per panel start.
 *
 * zod reads the setting as each schema is built, not as it parses, so it has to
 * be in place before the shared schemas are: this module is the first import of
 * each entry (main.tsx, main.sidepanel.tsx), ahead of anything that loads them.
 */
import { z } from 'zod';

z.config({ jitless: true });
