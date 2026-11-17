/**
 * How the audits read an org: GET requests alone, each counted, each waited
 * for a bounded time, a SOQL or Tooling query followed page by page up to a
 * bound it says it reached.
 *
 * An audit reads and writes nothing in the org: nothing here sends anything
 * but a GET. What it costs is what the org counts against its daily API
 * requests, and the audit says it: every request sent through {@link AuditOrg}
 * is counted, a refused or unanswered one included, since the org counted it.
 *
 * Through the same transport as the target's limits (`LimitsTransport`), so
 * the audits load no client library of their own.
 */

import * as z from 'zod';
import { extractErrorMessage } from '../../../src/core/common/extractErrorMessage.js';
import { TimeoutError, TimeoutManager } from '../../../src/core/engine/TimeoutManager.js';

/** The part of a connection the audits need: a GET, answered with the body. */
export interface AuditTransport {
  request(request: { method: 'GET'; url: string }): Promise<unknown>;
}

/** How long an audit waits for each answer, as the target's limits are waited for. */
export const AUDIT_TIMEOUT_MS = 30_000;

/** The most pages one query of an audit follows: 10,000 rows at the org's page of 2,000. */
export const AUDIT_MAX_PAGES = 5;

/** The longest reason an audit gives for what it could not read. */
const REASON_CHARS = 300;

/** One page of a query, as the REST API answers it. */
const pageSchema = z
  .object({
    records: z.array(z.record(z.string(), z.unknown())),
    done: z.boolean(),
    nextRecordsUrl: z.string().optional(),
  })
  .loose();

/** The rows of a query, and whether the page bound cut it short. */
export interface AuditRows {
  records: Array<Record<string, unknown>>;
  /** More rows were there than the pages read: the read says so, never takes them for all. */
  truncated: boolean;
}

/**
 * Why a request got no answer, in the org's words or the wait's, on one line
 * and bounded: a reason, never a value the org holds.
 */
export function unreadReasonOf(err: unknown, timeoutMs: number = AUDIT_TIMEOUT_MS): string {
  const words =
    err instanceof TimeoutError
      ? `the org did not answer within ${Math.round(timeoutMs / 1000)} s`
      : `the org refused it: ${extractErrorMessage(err)}`;
  const line = words.replace(/\s+/g, ' ').trim();
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 1)}…` : line;
}

/** The org as the audits read it: every request counted. */
export class AuditOrg {
  private sent = 0;
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: AuditTransport,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? AUDIT_TIMEOUT_MS;
  }

  /** The requests sent so far, those refused or unanswered included. */
  get requests(): number {
    return this.sent;
  }

  /** How long each answer is waited for. */
  get timeout(): number {
    return this.timeoutMs;
  }

  /** One GET, counted, waited for {@link timeout} at most. */
  async get(url: string): Promise<unknown> {
    this.sent++;
    return new TimeoutManager(this.timeoutMs).withTimeout('env:audit', () =>
      this.transport.request({ method: 'GET', url }),
    );
  }

  /**
   * This org as a transport of its own, every request counted with the
   * others: the deliverability probe reads through it.
   */
  asTransport(): AuditTransport {
    return { request: (request) => this.get(request.url) };
  }

  /**
   * The rows of a SOQL query, or of a Tooling query, page by page up to
   * `maxPages`. Throws what the org answered, or a page the API never gives.
   */
  async query(
    soql: string,
    options: { tooling?: boolean; maxPages?: number } = {},
  ): Promise<AuditRows> {
    const maxPages = options.maxPages ?? AUDIT_MAX_PAGES;
    const path = options.tooling === true ? '/tooling/query' : '/query';
    let page = pageOf(await this.get(`${path}?q=${encodeURIComponent(soql)}`));
    const records = [...page.records];
    let pages = 1;
    while (!page.done && page.nextRecordsUrl !== undefined && pages < maxPages) {
      // A locator is followed only on the API's own path: never another host.
      if (!page.nextRecordsUrl.startsWith('/services/data/')) break;
      page = pageOf(await this.get(page.nextRecordsUrl));
      records.push(...page.records);
      pages++;
    }
    return { records, truncated: !page.done };
  }
}

/** A page as the API answers one, or the error of an answer it never gives. */
function pageOf(answer: unknown): z.infer<typeof pageSchema> {
  const parsed = pageSchema.safeParse(answer);
  if (!parsed.success) throw new Error('its answer is not one a query gives');
  return parsed.data;
}

/**
 * A field of a row, whatever the case the query named it in: the API answers
 * with the field's own name, `Endpoint__c` for an `endpoint__c` asked.
 */
export function fieldOf(row: Readonly<Record<string, unknown>>, name: string): unknown {
  if (name in row) return row[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) return row[key];
  }
  return undefined;
}

/** A field of a row as text, or undefined when it is empty or not text. */
export function textOf(row: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = fieldOf(row, name);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A field of a row as a boolean, or undefined when it is not one. */
export function booleanOf(
  row: Readonly<Record<string, unknown>>,
  name: string,
): boolean | undefined {
  const value = fieldOf(row, name);
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * An instant the API gives, `2026-11-21T06:00:00.000+0000`, as an ISO
 * instant in UTC; undefined for one that does not read.
 */
export function instantOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}
