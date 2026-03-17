import type { BaseMessage } from '@sandforge/shared';
import type { MessageBroker } from './MessageBroker';

/** State snapshot that gets pushed to connected webviews. */
export interface WebviewState {
  orgs: Record<string, unknown>[];
  settings: Record<string, unknown>;
  activeOperations: string[];
  extensionReady: boolean;
}

/** Message shape for state synchronization pushes. */
export interface StateSyncMessage extends BaseMessage {
  type: 'state:sync';
  payload: WebviewState;
}

/**
 * Maintains a state snapshot on the extension side and pushes
 * it to all connected webviews whenever it changes.
 */
export class WebviewStateSync {
  private state: WebviewState = {
    orgs: [],
    settings: {},
    activeOperations: [],
    extensionReady: false,
  };

  private idCounter = 0;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private broker: MessageBroker) {}

  /**
   * Merge a partial update into the current state and push to webviews.
   * Multiple rapid calls are batched via a microtask debounce (~16ms).
   */
  updateState(partial: Partial<WebviewState>): void {
    this.state = { ...this.state, ...partial };
    if (!this.pushTimer) {
      this.pushTimer = setTimeout(() => {
        this.pushTimer = undefined;
        this.pushState();
      }, 16);
    }
  }

  /** Get a readonly copy of the current state. */
  getState(): Readonly<WebviewState> {
    return this.state;
  }

  /** Push the full state snapshot to all connected webviews. */
  pushState(): void {
    const message: StateSyncMessage = {
      id: `state-sync-${++this.idCounter}`,
      type: 'state:sync',
      timestamp: Date.now(),
      payload: { ...this.state },
    };
    this.broker.postToWebview(message);
  }

  /** Reset state to initial defaults and cancel any pending push. */
  reset(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
    this.state = {
      orgs: [],
      settings: {},
      activeOperations: [],
      extensionReady: false,
    };
  }
}
