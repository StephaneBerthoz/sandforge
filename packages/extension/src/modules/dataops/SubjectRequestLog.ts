import { z } from 'zod';
import type { SubjectRequestEvent, SubjectRequestLogEntry } from '@sandforge/shared';
import { SUBJECT_REQUEST_LOG_LIMIT } from '@sandforge/shared';

import type { ConfigStore } from '../../core/storage/ConfigStore.js';

/**
 * Where the log lives: one array, oldest first, in ConfigStore beside the
 * audit trail, so it survives a restart like every other history kept here.
 */
const LOG_KEY = 'dataops:subject-requests';
const LOG_CATEGORY = 'audit';

const objectCountsSchema = z.object({
  objectApiName: z.string(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/**
 * An event as it is stored, read back through this schema: an entry edited by
 * hand, or written by another version, is left out rather than shown wrong.
 */
const eventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('searched'),
    at: z.string(),
    searchedBy: z.array(z.enum(['email', 'phone', 'name'])),
    objects: z.array(
      z.object({
        objectApiName: z.string(),
        found: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('exported'),
    at: z.string(),
    records: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('erased'),
    at: z.string(),
    mode: z.enum(['anonymize', 'delete']),
    outcome: z.enum(['success', 'partial', 'failure', 'stopped']),
    operationId: z.string(),
    objects: z.array(objectCountsSchema),
  }),
]);

const entrySchema = z.object({
  requestId: z.string().min(1),
  orgId: z.string().min(1),
  openedAt: z.string(),
  events: z.array(eventSchema),
});

/**
 * The local log of subject requests: which request, on which org, when, and
 * what was found, exported and erased — counts and object names, never an
 * address, a name, a number, a record Id or a value. It is the evidence that
 * a request was handled; a log that kept what was searched for would be one
 * more copy of the person's data to erase.
 *
 * Bounded at {@link SUBJECT_REQUEST_LOG_LIMIT} requests, the oldest dropped
 * first: ConfigStore is one blob VS Code writes whole on every change.
 */
export class SubjectRequestLog {
  /**
   * @param configStore - The window's store.
   * @param limit - Requests kept; the oldest are dropped past it.
   */
  constructor(
    private readonly configStore: Pick<ConfigStore, 'get' | 'set'>,
    private readonly limit: number = SUBJECT_REQUEST_LOG_LIMIT,
  ) {}

  /** Whether the log holds this request, on this org. */
  has(requestId: string, orgId: string): boolean {
    return this.read().some((e) => e.requestId === requestId && e.orgId === orgId);
  }

  /**
   * Add one event to a request, opening the request with its first event. An
   * event for a request the log no longer holds — dropped past the bound —
   * opens it again rather than being lost.
   */
  record(requestId: string, orgId: string, event: SubjectRequestEvent): void {
    const entries = this.read();
    let entry = entries.find((e) => e.requestId === requestId && e.orgId === orgId);
    if (!entry) {
      entry = { requestId, orgId, openedAt: event.at, events: [] };
      entries.push(entry);
    }
    entry.events.push(event);
    this.write(entries);
  }

  /** Every request, the newest first. */
  list(): SubjectRequestLogEntry[] {
    return this.read().reverse();
  }

  /** What is stored, oldest first, with anything unreadable left out. */
  private read(): SubjectRequestLogEntry[] {
    const raw = this.configStore.get<unknown>(LOG_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => {
      const parsed = entrySchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  }

  private write(entries: SubjectRequestLogEntry[]): void {
    this.configStore.set(LOG_KEY, entries.slice(-this.limit), LOG_CATEGORY);
  }
}
