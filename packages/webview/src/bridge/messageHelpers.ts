import type { BaseMessage } from '@sandforge/shared';

let counter = 0;

/** Reset counter (for tests). */
export function resetMessageCounter(): void {
  counter = 0;
}

/**
 * Build a typed BaseMessage with an auto-generated id and current timestamp.
 * @param type - Message type string (e.g., 'org:list', 'settings:update').
 * @param payload - Optional payload to attach to the message.
 */
export function buildMessage<P = undefined>(
  type: string,
  ...args: P extends undefined ? [] : [payload: P]
): BaseMessage & (P extends undefined ? object : { payload: P }) {
  const msg: BaseMessage = {
    id: `wv-${Date.now()}-${++counter}`,
    type,
    timestamp: Date.now(),
  };

  if (args.length > 0) {
    (msg as BaseMessage & { payload: P }).payload = args[0] as P;
  }

  return msg as BaseMessage & (P extends undefined ? object : { payload: P });
}
