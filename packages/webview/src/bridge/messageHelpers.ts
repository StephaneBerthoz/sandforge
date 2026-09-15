import type { BaseMessage } from '@sandforge/shared';

/**
 * Build a typed BaseMessage with a random id and current timestamp.
 *
 * The id is random rather than a time and a counter: each panel runs its own
 * copy of this module and every reply reaches every panel, so two panels that
 * sent in the same millisecond used to mint the same id and could take each
 * other's answers — and a sync whose id repeats is refused as a duplicate.
 *
 * @param type - Message type string (e.g., 'org:list', 'settings:update').
 * @param payload - Optional payload to attach to the message.
 */
export function buildMessage<P = undefined>(
  type: string,
  ...args: P extends undefined ? [] : [payload: P]
): BaseMessage & (P extends undefined ? object : { payload: P }) {
  const msg: BaseMessage = {
    id: `wv-${crypto.randomUUID()}`,
    type,
    timestamp: Date.now(),
  };

  if (args.length > 0) {
    (msg as BaseMessage & { payload: P }).payload = args[0] as P;
  }

  return msg as BaseMessage & (P extends undefined ? object : { payload: P });
}
