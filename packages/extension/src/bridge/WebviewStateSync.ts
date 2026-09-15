import type { ActiveOperation, StateSyncMessage, WebviewState } from '@sandforge/shared';
import type { MessageBroker } from './MessageBroker';

// `WebviewState` + `StateSyncMessage` live in `@sandforge/shared`
// (`types/messages/settings.messages.ts`) — they are the TS counterparts of
// the `state:sync` envelope in `bridge/messageSchemas.ts`. Re-exported here
// so existing imports from this module keep working.
export type { StateSyncMessage, WebviewState } from '@sandforge/shared';

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
    selectedOrgId: null,
  };

  private idCounter = 0;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private broker: MessageBroker) {}

  /**
   * Merge a partial update into the current state and push to webviews.
   * Multiple rapid calls are batched via a microtask debounce (~16ms).
   * After {@link dispose} the state is still merged but no push is scheduled.
   */
  updateState(partial: Partial<WebviewState>): void {
    this.state = { ...this.state, ...partial };
    if (!this.pushTimer && !this.disposed) {
      this.pushTimer = setTimeout(() => {
        this.pushTimer = undefined;
        this.pushState();
      }, 16);
    }
  }

  /**
   * Replace the active operations list and push to webviews.
   * Called by the BackgroundOperationRegistry event listener.
   *
   * @param ops - The current list of active operations
   */
  setActiveOperations(ops: ActiveOperation[]): void {
    this.updateState({ activeOperations: ops });
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

  /**
   * Cancel any pending push and stop scheduling new ones. Registered with the
   * extension's subscriptions: background operations and org changes keep
   * calling updateState while the extension is torn down, and a debounced push
   * firing then posted to a broker that was already disposed.
   */
  dispose(): void {
    this.disposed = true;
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
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
      selectedOrgId: null,
    };
  }
}
