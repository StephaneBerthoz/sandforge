import { z } from 'zod';

/**
 * Zod schema for the base message structure.
 *
 * Every message exchanged between the extension and the webview must
 * include `id` (non-empty string), `type` (non-empty string) and
 * `timestamp` (finite number). Additional properties are allowed via
 * `.passthrough()` so that concrete message payloads are not stripped.
 */
export const baseMessageSchema = z
  .object({
    /** Unique message identifier */
    id: z.string().min(1),
    /** Message type discriminant (e.g. "org:list", "seed:execute") */
    type: z.string().min(1),
    /** Unix-epoch timestamp in milliseconds */
    timestamp: z.number().finite(),
  })
  .passthrough();

/** Inferred type from the base message schema */
export type BaseMessageParsed = z.infer<typeof baseMessageSchema>;
