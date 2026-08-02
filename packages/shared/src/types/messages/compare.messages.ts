import type { BaseMessage } from './base.messages.js';

/** Compare messages */
export interface CompareExecuteRequest extends BaseMessage {
  type: 'compare:execute';
  payload: { configId: string };
}
