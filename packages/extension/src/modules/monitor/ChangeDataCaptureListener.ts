import { buildCdcChannel } from '@sandforge/shared';

/** A Salesforce Change Data Capture event */
export interface CdcEvent {
  entityName: string;
  changeType: 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE';
  recordIds: string[];
  timestamp: string;
  changedFields?: string[];
}

/** Function that subscribes to a CDC channel and returns an unsubscribe function */
export type CdcSubscribeFn = (
  channel: string,
  handler: (event: CdcEvent) => void
) => () => void;

/** Maximum number of events stored in the circular buffer */
const MAX_EVENTS = 200;

/**
 * Listens for Salesforce Change Data Capture events on specified entities.
 * Maintains a circular buffer of recent events and allows watching/unwatching
 * individual entity types.
 */
export class ChangeDataCaptureListener {
  private readonly subscribe: CdcSubscribeFn;
  private readonly unsubscribeFns: Map<string, () => void> = new Map();
  private readonly events: CdcEvent[] = [];

  constructor(subscribe: CdcSubscribeFn) {
    this.subscribe = subscribe;
  }

  /** Start watching CDC events for the given entity name */
  watch(entityName: string): void {
    if (this.unsubscribeFns.has(entityName)) {
      return;
    }

    const channel = buildCdcChannel(entityName);
    const unsubscribe = this.subscribe(channel, (event: CdcEvent) => {
      this.addEvent(event);
    });

    this.unsubscribeFns.set(entityName, unsubscribe);
  }

  /** Stop watching CDC events for the given entity name */
  unwatch(entityName: string): void {
    const unsubscribe = this.unsubscribeFns.get(entityName);
    if (unsubscribe) {
      unsubscribe();
      this.unsubscribeFns.delete(entityName);
    }
  }

  /** Return the list of currently watched entity names */
  getWatchedEntities(): string[] {
    return [...this.unsubscribeFns.keys()];
  }

  /** Return recent CDC events, optionally filtered by entity name */
  getRecentEvents(entityName?: string): CdcEvent[] {
    if (entityName === undefined) {
      return [...this.events];
    }
    return this.events.filter((e) => e.entityName === entityName);
  }

  private addEvent(event: CdcEvent): void {
    if (this.events.length >= MAX_EVENTS) {
      this.events.shift();
    }
    this.events.push(event);
  }
}
