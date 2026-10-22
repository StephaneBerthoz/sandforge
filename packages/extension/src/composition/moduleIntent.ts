import * as z from 'zod';
import type { NavigationIntentMessage } from '@sandforge/shared';

/**
 * What a `sandforge.open*` command may be asked to start on the page it
 * opens. The launcher's first card, shown while no org is registered, opens
 * Organizations on an import from the Salesforce CLI or on the browser
 * sign-in. A command can be run from anywhere with any argument, so anything
 * else is refused: the page opens as it always does.
 */
export const moduleIntentSchema = z
  .object({ orgAction: z.enum(['import-cli', 'login-web']) })
  .strict();

/** A start the page is asked for, as the schema lets it through. */
export type ModuleIntent = z.infer<typeof moduleIntentSchema>;

/**
 * The message that hands a page what it was asked to start, or undefined when
 * the command was run without one, or with an argument the schema refuses.
 *
 * @param moduleId - The page the command opens.
 * @param argument - Whatever the command was run with.
 * @param id - The message id.
 */
export function intentMessageFor(
  moduleId: string,
  argument: unknown,
  id: string,
): NavigationIntentMessage | undefined {
  if (argument === undefined) return undefined;
  const intent = moduleIntentSchema.safeParse(argument);
  if (!intent.success) return undefined;
  return {
    id,
    type: 'navigation:intent',
    timestamp: Date.now(),
    payload: { route: moduleId, ...intent.data },
  };
}

/**
 * Whether a message from a new panel's page says React has mounted it, so a
 * start or What's New posted now reaches a listener: the enveloped
 * `panel:route` the panel sends from an effect of its first commit, the
 * commit in which the bridge's listeners for `navigation:intent` and
 * `whats-new:show` subscribe. A message sent earlier proves only that the
 * bundle is parsing: on an editor in another language than English, the
 * language request leaves while the i18n module loads, before the first
 * render. Self-contained and free of any `vscode` import, so the panel's
 * browser tests post on the very test the extension makes.
 *
 * @param raw - A message as `onDidReceiveMessage` hands it, envelope included.
 */
export function isPageMountedMessage(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const payload = (raw as { payload?: unknown }).payload;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'panel:route'
  );
}
