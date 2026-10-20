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
