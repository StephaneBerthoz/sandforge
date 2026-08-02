/** Message direction */
export type MessageDirection = 'extension_to_webview' | 'webview_to_extension';

/** Base message structure — all messages extend this */
export interface BaseMessage {
  id: string;
  type: string;
  timestamp: number;
  /** Links a response to the original request (set to request's `id`). */
  correlationId?: string;
}
