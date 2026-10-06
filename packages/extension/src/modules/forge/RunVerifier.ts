/**
 * The verification of what a Forge run created, once the target has settled.
 * READ-ONLY: it never writes to either org.
 *
 *   - **presence**: every record the run created is read back, per object,
 *     two hundred ids a query; one not read is looked for in the recycle bin
 *     (`queryAll`, `IsDeleted`), and one found in neither is counted as out of
 *     the user's sight, never as deleted;
 *   - **links**: on a sample of each object's records, every lookup the run
 *     set from a record it mapped — one whose value in the source names a row
 *     of the run's id map — is read in the target and compared with the id
 *     that row got there;
 *   - **changes since the run**: each record's `LastModifiedDate` against the
 *     target's date of the run's last stamp, as the removal of the run's
 *     records reads it to keep a record changed since;
 *   - **settling**: the first reading comes after a pause, and readings
 *     repeat until two in a row agree (three at most, two seconds apart, as
 *     Frozen's post-load check does); otherwise the verdict is `unstable`.
 */

import type { Connection } from 'jsforce';
import type {
  ForgeRunObjectRecords,
  ForgeRunVerification,
  ForgeVerificationChange,
  ForgeVerificationLink,
  ForgeVerificationObject,
  ForgeVerificationVerdict,
} from '@sandforge/shared';

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { describedObjectSchema } from '../dataops/DataQualityScanner.js';
import { idLists, orgSession, readRecordsById } from '../dataops/RecordRemoval.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { CLOCK_LEEWAY_MS } from './ForgeRunRemoval.js';

/** Default pause before the first reading, and between two readings (ms). */
export const DEFAULT_VERIFY_INTERVAL_MS = 2_000;
/** Most readings of the target: two that agree end it early. */
export const DEFAULT_VERIFY_ATTEMPTS = 3;
/** Records of each object whose lookups are checked. */
export const DEFAULT_LINK_SAMPLE = 20;
/** Records named per list the verification keeps: the counts say how many there were. */
export const NAMED_PER_LIST = 20;

/** What a verification reads of the org a run wrote to. */
export interface VerifiedOrg {
  /** A query answered in one page: every one sent names two hundred ids at most. */
  query(soql: string): Promise<{ totalSize: number; records: unknown[] }>;
  /** The same, the recycle bin included. */
  queryAll(soql: string): Promise<{ totalSize: number; records: unknown[] }>;
  describe(objectApiName: string): Promise<unknown>;
  /**
   * The org's clock now, as it writes a date: a run whose writes the target
   * did not date is dated by when it was recorded, read on that clock.
   */
  serverTime?(): Promise<string>;
}

/** What a verification reads of the org a run read from: what each record pointed at. */
export type SourceOrg = Pick<VerifiedOrg, 'query' | 'describe'>;

/**
 * The org a verification reads, over a jsforce connection.
 *
 * @param conn - The org's connection.
 * @param context - Names the work in the API-usage warnings.
 */
export function verifiedOrg(conn: Connection, context: string): VerifiedOrg {
  const session = orgSession(conn, context);
  return {
    query: (soql) => session.query(soql),
    describe: (objectApiName) => session.describe(objectApiName),
    queryAll: async (soql) => {
      const answer = await conn.query<Record<string, unknown>>(soql, { scanAll: true });
      checkApiLimits(conn.limitInfo, context);
      return { totalSize: answer.totalSize, records: answer.records };
    },
    serverTime: async () => (await conn.soap.getServerTimestamp()).timestamp,
  };
}

/** What a verification needs of the run it verifies. */
export interface RunToVerify {
  /**
   * Per object, the run's records to read back, by their ids in the target:
   * what it created, less what its removals took.
   */
  records: readonly ForgeRunObjectRecords[];
  /** Source id to target id, as the run kept it: what each lookup was set to. */
  remapTable: Readonly<Record<string, string>>;
  /**
   * The target's date of the last stamp the run left on its records
   * (`writtenBetween.last`): a record modified after it was changed since.
   */
  runEndedAt?: Date;
  /**
   * When the run was recorded, on this machine's clock, right after its last
   * write: for a run the target did not date, read on the org's clock.
   */
  runRecordedAt?: Date;
  /**
   * What removals of the run left on records they did not delete, by record
   * id: a record last modified no later than that was not changed since.
   */
  removalStamps?: Readonly<Record<string, string>>;
  /** Per object, the fields the run was told to leave out, by their source names. */
  fieldExclusions?: Readonly<Record<string, readonly string[]>>;
  /** Per object, a source field and the target field the run wrote it under. */
  fieldMappings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Per object, the fields rows were written again without, the target
   * having refused them: empty on purpose in those rows, which the run said.
   */
  writtenWithout?: Readonly<Record<string, readonly string[]>>;
}

/** How a verification goes. */
export interface RunVerifyOptions {
  /** Pause before the first reading and between two. Default {@link DEFAULT_VERIFY_INTERVAL_MS}. */
  intervalMs?: number;
  /** Most readings. Default {@link DEFAULT_VERIFY_ATTEMPTS}. */
  maxAttempts?: number;
  /** Records per object whose lookups are checked. Default {@link DEFAULT_LINK_SAMPLE}. */
  linkSample?: number;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
  /** Sleep injection for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The orgs a verification reads. */
export interface RunVerifierDeps {
  /** The org the run wrote to. */
  target: VerifiedOrg;
  /**
   * The org the run read from, or why it cannot be read: the run did not
   * keep it, or it is no longer registered. Its lookups are then unchecked.
   */
  source: SourceOrg | { unavailable: string };
}

/** One lookup the run set on a record, and the id it set it to. */
interface ExpectedLink {
  field: string;
  expected: string;
}

/** What is checked of one object's lookups, read once before the readings. */
interface LinkPlan {
  /** The target fields read on the sample. */
  fields: string[];
  /** Target record key to the lookups the run set on it. */
  expected: Map<string, ExpectedLink[]>;
  /** The sample, by target id. */
  sample: string[];
  /** Why the lookups could not be checked, when they could not. */
  unchecked?: string;
}

/** One reading of one object. Compared whole across readings. */
interface ObjectReading {
  objectApiName: string;
  expected: number;
  present: number;
  deletedIds: string[];
  notVisibleIds: string[];
  changed: ForgeVerificationChange[];
  linksChecked: number;
  broken: ForgeVerificationLink[];
  error?: string;
  recycleBinUnread?: string;
  linksUnchecked?: string;
}

/**
 * The columns a reading of the run's records asks for, tried in turn: when
 * each was last modified and by whom; or, for an object that keeps no
 * `LastModifiedDate`, its system stamp alone; or nothing past the id.
 */
const DATE_COLUMNS: readonly { modified?: string; by?: string }[] = [
  { modified: 'LastModifiedDate', by: 'LastModifiedById' },
  { modified: 'SystemModstamp' },
  {},
];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** The id a row carries, when it carries one. */
function idOf(row: Record<string, unknown>): string | undefined {
  return typeof row.Id === 'string' ? row.Id : undefined;
}

/** JSON.stringify with recursively sorted object keys (stable comparison). */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Verifies what a Forge run created in its target: whether each record is
 * there, whether its lookups point where the run set them, and which were
 * changed since the run — once the target has stopped moving.
 */
export class RunVerifier {
  /** Each object described once per org. */
  private readonly describes = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: RunVerifierDeps) {}

  /** Verify the run and say what was found. */
  async verify(run: RunToVerify, options: RunVerifyOptions = {}): Promise<ForgeRunVerification> {
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? defaultSleep;
    const intervalMs = options.intervalMs ?? DEFAULT_VERIFY_INTERVAL_MS;
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_VERIFY_ATTEMPTS);
    const sampleSize = options.linkSample ?? DEFAULT_LINK_SAMPLE;

    const runEnd = await this.runEnd(run);
    // What each sampled record pointed at in the source does not move while
    // the target settles: read once, before the first reading.
    const source = this.deps.source;
    const sourceUnavailable = 'unavailable' in source ? source.unavailable : undefined;
    const plans = new Map<string, LinkPlan>();
    if (!('unavailable' in source)) {
      for (const object of run.records) {
        plans.set(object.objectApiName, await this.linkPlan(source, run, object, sampleSize));
      }
    }

    // The target is read after a pause, then again until two readings agree:
    // what a flow or a trigger does once the run's last call is answered can
    // still be under way when the run reports.
    let previous: string | null = null;
    let stable: ObjectReading[] | null = null;
    let last: ObjectReading[] = [];
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      await sleep(intervalMs);
      last = [];
      for (const object of run.records) {
        last.push(await this.read(run, object, runEnd, plans.get(object.objectApiName)));
      }
      const serialized = stableSerialize(last);
      if (previous !== null && serialized === previous) {
        stable = last;
        break;
      }
      previous = serialized;
    }

    const objects = (stable ?? last).map(objectResult);
    return {
      verdict: verdictOf(stable !== null, objects, sourceUnavailable),
      verifiedAt: now().toISOString(),
      attempts,
      objects,
      ...(sourceUnavailable !== undefined ? { linksUnchecked: sourceUnavailable } : {}),
    };
  }

  /**
   * The run's end, in the target's dates: the one the run read back as it
   * ended, or, for a run the target did not date, when it was recorded, read
   * on the org's clock give or take {@link CLOCK_LEEWAY_MS}. NaN when neither
   * is known: no record is then taken for changed since.
   */
  private async runEnd(run: RunToVerify): Promise<number> {
    if (run.runEndedAt) return run.runEndedAt.getTime();
    if (!run.runRecordedAt) return Number.NaN;
    let aheadMs = 0;
    const clock = this.deps.target.serverTime;
    if (clock) {
      const before = Date.now();
      try {
        const orgNow = epochOf(await clock.call(this.deps.target));
        if (Number.isFinite(orgNow)) aheadMs = orgNow - (before + Date.now()) / 2;
      } catch {
        // Untold: the machine's clock stands for the org's.
      }
    }
    return run.runRecordedAt.getTime() + aheadMs + CLOCK_LEEWAY_MS;
  }

  /** An object's describe, asked once per org. */
  private describe(org: Pick<VerifiedOrg, 'describe'>, side: string, name: string) {
    const key = `${side}:${name}`;
    let described = this.describes.get(key);
    if (!described) {
      described = org.describe(name);
      this.describes.set(key, described);
    }
    return described.then((raw) => describedObjectSchema.parse(raw));
  }

  /**
   * What is checked of one object's lookups: the lookups the target lets a
   * write set, under the name the run wrote each with, but those the run was
   * told to leave out; and, on the sample, what each pointed at in the source
   * that the run's id map holds — a lookup the run set from a record it
   * mapped. One whose source record is in no row of the map was written as
   * read, or left empty, and is not the run's to judge.
   */
  private async linkPlan(
    source: SourceOrg,
    run: RunToVerify,
    object: ForgeRunObjectRecords,
    sampleSize: number,
  ): Promise<LinkPlan> {
    const name = object.objectApiName;
    const empty: LinkPlan = { fields: [], expected: new Map(), sample: [] };
    try {
      const [target, read] = await Promise.all([
        this.describe(this.deps.target, 'target', name),
        this.describe(source, 'source', name),
      ]);
      const settable = new Set(
        target.fields
          .filter((f) => f.type === 'reference' && (f.createable === true || f.updateable === true))
          .map((f) => f.name),
      );
      const excluded = new Set(run.fieldExclusions?.[name] ?? []);
      const renamed = run.fieldMappings?.[name] ?? {};
      const pairs = read.fields
        .filter((f) => f.type === 'reference' && !excluded.has(f.name))
        .map((f) => ({ from: f.name, to: renamed[f.name] ?? f.name }))
        .filter(({ to }) => settable.has(to) && !excluded.has(to));
      if (pairs.length === 0) return empty;

      const sourceOf = new Map<string, string>();
      const targetOf = new Map<string, string>();
      for (const [sourceId, targetId] of Object.entries(run.remapTable)) {
        sourceOf.set(recordKey(targetId), sourceId);
        targetOf.set(recordKey(sourceId), targetId);
      }
      const sample = object.ids.slice(0, sampleSize).filter((id) => sourceOf.has(recordKey(id)));
      if (sample.length === 0) return empty;
      const rows = await readRecordsById(
        source,
        name,
        pairs.map((p) => p.from),
        sample.map((id) => sourceOf.get(recordKey(id)) as string),
      );
      const expected = new Map<string, ExpectedLink[]>();
      for (const row of rows) {
        const sourceId = idOf(row);
        const targetId = sourceId ? targetOf.get(recordKey(sourceId)) : undefined;
        if (!targetId) continue;
        const links: ExpectedLink[] = [];
        for (const { from, to } of pairs) {
          const value = row[from];
          const parent = typeof value === 'string' ? targetOf.get(recordKey(value)) : undefined;
          if (parent) links.push({ field: to, expected: parent });
        }
        if (links.length > 0) expected.set(recordKey(targetId), links);
      }
      const fields = [...new Set([...expected.values()].flat().map((link) => link.field))];
      return { fields, expected, sample: fields.length > 0 ? sample : [] };
    } catch (err: unknown) {
      return { ...empty, unchecked: extractErrorMessage(err) };
    }
  }

  /** One reading of one object's records in the target. */
  private async read(
    run: RunToVerify,
    object: ForgeRunObjectRecords,
    runEnd: number,
    plan: LinkPlan | undefined,
  ): Promise<ObjectReading> {
    const name = object.objectApiName;
    const reading: ObjectReading = {
      objectApiName: name,
      expected: object.ids.length,
      present: 0,
      deletedIds: [],
      notVisibleIds: [],
      changed: [],
      linksChecked: 0,
      broken: [],
      ...(plan?.unchecked !== undefined ? { linksUnchecked: plan.unchecked } : {}),
    };

    let rows: Array<Record<string, unknown>> | undefined;
    let columns: (typeof DATE_COLUMNS)[number] = {};
    let error: string | undefined;
    for (const candidate of DATE_COLUMNS) {
      try {
        const names = [candidate.modified, candidate.by].filter((c): c is string => !!c);
        rows = await readRecordsById(this.deps.target, name, names, object.ids);
        columns = candidate;
        break;
      } catch (err: unknown) {
        error ??= extractErrorMessage(err);
      }
    }
    if (!rows) return { ...reading, error: error ?? 'The org gave no reason.' };

    const read = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const id = idOf(row);
      if (id) read.set(recordKey(id), row);
    }
    const missing = object.ids.filter((id) => !read.has(recordKey(id)));
    let archived = 0;
    if (missing.length > 0) {
      const bin = await this.recycleBin(name, missing);
      if ('unread' in bin) {
        reading.notVisibleIds = missing;
        reading.recycleBinUnread = bin.unread;
      } else {
        for (const id of missing) {
          const state = bin.found.get(recordKey(id));
          if (state === 'deleted') reading.deletedIds.push(id);
          else if (state === 'there') archived++;
          else reading.notVisibleIds.push(id);
        }
      }
    }
    reading.present = read.size + archived;

    // Changed since the run: modified after its last stamp, both by the org's
    // clock, and after what a removal of it left on the record, which was
    // that removal's doing.
    const stamps = new Map(
      Object.entries(run.removalStamps ?? {}).map(([id, date]) => [recordKey(id), epochOf(date)]),
    );
    if (columns.modified && Number.isFinite(runEnd)) {
      for (const id of object.ids) {
        const row = read.get(recordKey(id));
        if (!row) continue;
        const modified = epochOf(row[columns.modified]);
        if (!Number.isFinite(modified)) continue;
        if (modified <= runEnd || modified <= (stamps.get(recordKey(id)) ?? Number.NaN)) continue;
        const by = columns.by ? row[columns.by] : undefined;
        reading.changed.push({
          recordId: id,
          modifiedAt: String(row[columns.modified]),
          ...(typeof by === 'string' ? { modifiedById: by } : {}),
        });
      }
    }

    if (plan && plan.sample.length > 0) {
      try {
        const sampled = await readRecordsById(this.deps.target, name, plan.fields, plan.sample);
        const leftOut = new Set(run.writtenWithout?.[name] ?? []);
        for (const row of sampled) {
          const id = idOf(row);
          if (!id) continue;
          for (const { field, expected } of plan.expected.get(recordKey(id)) ?? []) {
            const value = row[field];
            const found = typeof value === 'string' && value !== '' ? value : null;
            if (found !== null && recordKey(found) === recordKey(expected)) {
              reading.linksChecked++;
              continue;
            }
            // Written again without the field, the target having refused it:
            // empty on purpose, as the run said.
            if (found === null && leftOut.has(field)) continue;
            reading.linksChecked++;
            reading.broken.push({ recordId: id, field, expected, found });
          }
        }
      } catch (err: unknown) {
        reading.linksUnchecked = extractErrorMessage(err);
      }
    }
    return reading;
  }

  /**
   * The records not read back, as the recycle bin and `queryAll` see them:
   * deleted, there all along (an archived activity, which a plain query does
   * not return), or neither. Why the bin could not be read, when it could not.
   */
  private async recycleBin(
    objectApiName: string,
    ids: readonly string[],
  ): Promise<{ found: Map<string, 'deleted' | 'there'> } | { unread: string }> {
    const found = new Map<string, 'deleted' | 'there'>();
    try {
      const object = assertSoqlIdentifier(objectApiName);
      for (const list of idLists(ids)) {
        const answer = await this.deps.target.queryAll(
          `SELECT Id, IsDeleted FROM ${object} WHERE Id IN (${list})`,
        );
        for (const record of answer.records) {
          if (typeof record !== 'object' || record === null) continue;
          const row = record as Record<string, unknown>;
          const id = idOf(row);
          if (!id) continue;
          const deleted = row.IsDeleted === true || row.IsDeleted === 'true';
          found.set(recordKey(id), deleted ? 'deleted' : 'there');
        }
      }
    } catch (err: unknown) {
      return { unread: extractErrorMessage(err) };
    }
    return { found };
  }
}

/** One object's result, from the reading the verdict stands on, its lists cut short. */
function objectResult(reading: ObjectReading): ForgeVerificationObject {
  return {
    objectApiName: reading.objectApiName,
    expected: reading.expected,
    present: reading.present,
    deleted: reading.deletedIds.length,
    notVisible: reading.notVisibleIds.length,
    changed: reading.changed.length,
    changedRecords: reading.changed.slice(0, NAMED_PER_LIST),
    deletedIds: reading.deletedIds.slice(0, NAMED_PER_LIST),
    notVisibleIds: reading.notVisibleIds.slice(0, NAMED_PER_LIST),
    linksChecked: reading.linksChecked,
    linksBroken: reading.broken.length,
    brokenLinks: reading.broken.slice(0, NAMED_PER_LIST),
    ...(reading.error !== undefined ? { error: reading.error } : {}),
    ...(reading.linksUnchecked !== undefined ? { linksUnchecked: reading.linksUnchecked } : {}),
    ...(reading.recycleBinUnread !== undefined
      ? { recycleBinUnread: reading.recycleBinUnread }
      : {}),
  };
}

/**
 * What the readings come to: `unstable` without two that agreed; `partial`
 * when a record is not there, a lookup does not hold, or a part could not be
 * checked; `verified` otherwise. A record changed since the run is there, and
 * listed: it lowers nothing on its own, a lookup it changed being checked.
 */
function verdictOf(
  stable: boolean,
  objects: readonly ForgeVerificationObject[],
  linksUnchecked: string | undefined,
): ForgeVerificationVerdict {
  if (!stable) return 'unstable';
  const short = objects.some(
    (o) =>
      o.error !== undefined ||
      o.linksUnchecked !== undefined ||
      o.deleted > 0 ||
      o.notVisible > 0 ||
      o.linksBroken > 0,
  );
  return short || linksUnchecked !== undefined ? 'partial' : 'verified';
}

/**
 * A verification's counts, every object together, as the audit trail and the
 * command's line keep them: counts only, never a record.
 */
export function verificationTotals(verification: ForgeRunVerification): Record<string, number> {
  const sum = (pick: (o: ForgeVerificationObject) => number): number =>
    verification.objects.reduce((total, o) => total + pick(o), 0);
  return {
    expected: sum((o) => o.expected),
    present: sum((o) => o.present),
    deleted: sum((o) => o.deleted),
    notVisible: sum((o) => o.notVisible),
    changed: sum((o) => o.changed),
    linksChecked: sum((o) => o.linksChecked),
    linksBroken: sum((o) => o.linksBroken),
    attempts: verification.attempts,
  };
}

/**
 * Per object, the fields a run wrote rows again without, as its result names
 * them (`writtenWithoutFields`): what {@link RunToVerify.writtenWithout} takes.
 */
export function writtenWithoutByObject(
  rows: ReadonlyArray<{ objectApiName: string; fields: ReadonlyArray<{ field: string }> }>,
): Record<string, string[]> {
  const byObject: Record<string, string[]> = {};
  for (const { objectApiName, fields } of rows) {
    const named = (byObject[objectApiName] ??= []);
    for (const { field } of fields) if (!named.includes(field)) named.push(field);
  }
  return byObject;
}
