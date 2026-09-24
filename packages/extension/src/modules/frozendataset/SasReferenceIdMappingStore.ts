/**
 * Sas-persisted referenceId→Id mapping store — implements the engine
 * extension point {@link ReferenceIdMappingStore} (types.ts).
 *
 * Target-org automations may rewrite business identifiers at insert: the
 * ONLY reliable address of a loaded record is the real ID captured in the
 * DML outcome. This store persists that mapping
 * as JSON inside the sas (outside the repo, enforced by SasPathGuard) so
 * reloads, PersonContact post-loads and the PostLoadVerifier can resolve
 * referenceIds to real IDs.
 *
 * It also keeps what the removal of a load needs and nothing else holds: which
 * of the mapped records the load created rather than linked, when it ran —
 * by this machine's clock, and by the target's — and what earlier removals of
 * it did; and the same of the loads before it that no reload purged, whose
 * records are still in the org. Record ids stay in the sas with the rest.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { ForgeRemovalSpan, ForgeUndoMark, ForgeWrittenBetween } from '@sandforge/shared';
import { SasPathGuard } from './SasPathGuard.js';
import type {
  LoadCreatedRecords,
  PersistedLoad,
  PreviousLoad,
  ReferenceIdMappingStore,
} from './types.js';

/** File name of the persisted mapping inside the sas directory. */
export const REFERENCEID_MAPPING_FILENAME = 'referenceid-mapping.json';

/** What the file keeps of one load: the last one, or one before it. */
interface LoadPayload {
  /** When the load's mapping was last written. */
  updatedAt: string;
  /** referenceId → real target ID. */
  mapping: Record<string, string>;
  /**
   * Per object, the keys of the mapping whose records the load created —
   * inserted, or a technical placeholder — in the order it wrote them; for a
   * reload, first the records an earlier load created that it found again.
   * Every other key names a record it linked or reused. Absent from files
   * written before it was recorded.
   */
  created?: LoadCreatedRecords[];
  /**
   * When the load that wrote the mapping began, and when it wrote its last
   * record, on this machine's clock. Absent from files written before it was
   * recorded.
   */
  load?: { startedAt: string; endedAt: string };
  /**
   * When the target dated the records the load created, read back as it
   * ended. Absent when it created none, when not every date could be read,
   * and from files written before it was recorded.
   */
  writtenBetween?: ForgeWrittenBetween;
  /** Once the records the load created were removed: when, and how many went each way. */
  removal?: ForgeUndoMark;
  /**
   * What earlier removals of the load left on records they did not delete —
   * and the purges of reloads that set them to Draft for a delete that did
   * not come — by record id: the `LastModifiedDate` the org left on each.
   */
  removalStamps?: Record<string, string>;
  /** When earlier removals of the load that wrote to the org ran, and as which user. */
  removalSpans?: ForgeRemovalSpan[];
}

/** On-disk shape of the persisted mapping: the last load, and the ones it kept. */
interface MappingFilePayload extends LoadPayload {
  version: 1;
  /** Target org the mapping belongs to (informational guard rail). */
  orgId: string;
  /**
   * The id the target org answered with when the mapping was written. A
   * refreshed sandbox keeps its registered id and answers with a new one, so
   * this is what tells the records of the org it was from those of the org it
   * is. Absent from files written before it was recorded.
   */
  organizationId?: string;
  /**
   * The loads before the last one, newest first, whose created records no
   * reload purged or took over: the last load was not a reload, a pilot's
   * reload purges nothing, a reload stopped part way left the rest, and a
   * purge the target refused leaves what it refused. Each keeps what it
   * created and still has in the org, and its dates — or, for a load that
   * does not say what it created, its whole mapping, for the next reload to
   * judge. Absent when there is none.
   */
  earlier?: LoadPayload[];
}

/** The parts of a file the removal reads, each checked: the file comes back from disk. */
const createdSchema = z.array(
  z.object({ objectApiName: z.string(), referenceIds: z.array(z.string()) }),
);
const loadSpanSchema = z.object({ startedAt: z.string(), endedAt: z.string() });
const writtenBetweenSchema = z.object({ first: z.string(), last: z.string() });
const removalMarkSchema = z.object({
  removedAt: z.string(),
  deleted: z.number(),
  alreadyGone: z.number(),
  kept: z.number(),
  refused: z.number(),
});
const removalStampsSchema = z.record(z.string(), z.string());
const removalSpansSchema = z.array(
  z.object({ first: z.string(), last: z.string(), userId: z.string() }),
);

/** The value a schema reads in `value`, or undefined when it reads none. */
function readAs<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * One load as the file keeps it, each part read as its schema reads it: a
 * part that does not read is left out, a mapping entry that is no string too.
 */
function loadPartsOf(value: unknown): LoadPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const mapping =
    typeof raw.mapping === 'object' && raw.mapping !== null
      ? Object.fromEntries(
          Object.entries(raw.mapping).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  const created = readAs(createdSchema, raw.created);
  const load = readAs(loadSpanSchema, raw.load);
  const writtenBetween = readAs(writtenBetweenSchema, raw.writtenBetween);
  const removal = readAs(removalMarkSchema, raw.removal);
  const removalStamps = readAs(removalStampsSchema, raw.removalStamps);
  const removalSpans = readAs(removalSpansSchema, raw.removalSpans);
  return {
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    mapping,
    ...(created ? { created } : {}),
    ...(load ? { load } : {}),
    ...(writtenBetween ? { writtenBetween } : {}),
    ...(removal ? { removal } : {}),
    ...(removalStamps ? { removalStamps } : {}),
    ...(removalSpans ? { removalSpans } : {}),
  };
}

/** The loads the file keeps before the last one, each that reads. */
function earlierOf(payload: MappingFilePayload): LoadPayload[] {
  return Array.isArray(payload.earlier)
    ? payload.earlier.flatMap((entry) => loadPartsOf(entry) ?? [])
    : [];
}

/** Which load a payload holds: when it wrote its last record, or when its mapping was written. */
function endedAtOf(load: LoadPayload): string {
  return load.load?.endedAt ?? load.updatedAt;
}

/**
 * The load a mapping file records, as its removal and the module status read
 * it.
 */
export interface RecordedLoad {
  /** The registered org the load wrote to. */
  orgId: string;
  /** referenceId → real target ID. */
  mapping: ReadonlyMap<string, string>;
  /**
   * Per object, the keys whose records the load created, in the order it
   * wrote them. Undefined for a file written before loads kept it: its
   * created records cannot be told from the ones it linked.
   */
  created?: LoadCreatedRecords[];
  /** When the load began, on this machine's clock; undefined when the file does not say. */
  startedAt?: string;
  /**
   * When the load wrote its last record, on this machine's clock — or, for a
   * file that does not say, when the mapping was written. Names the load.
   */
  endedAt: string;
  /**
   * When the target dated the records the load created: what its removal
   * reads the load's span by. Undefined when the file does not say.
   */
  writtenBetween?: ForgeWrittenBetween;
  /** Set once the records the load created were removed. */
  removal?: ForgeUndoMark;
  /**
   * What earlier removals of the load left on the records they did not delete,
   * and reloads on the records they set to Draft and did not delete.
   */
  removalStamps: Record<string, string>;
  /** When earlier removals of the load that wrote to the org ran, and as which user. */
  removalSpans: ForgeRemovalSpan[];
  /** Set for a load before the last one, which the last load kept. */
  earlier?: true;
}

/** What a removal of the load did, for the mapping to keep. */
export interface RecordedRemoval {
  /** The load's records that went, deleted or found gone: the mapping forgets them. */
  gone: readonly string[];
  /** What the removal left on records it did not delete, by id. */
  stamps: Readonly<Record<string, string>>;
  /** When it ran, when it wrote to the org. */
  span?: ForgeRemovalSpan;
  /** Set when the load's records went, so the removal is not offered again. */
  mark?: ForgeUndoMark;
}

/** Options of {@link SasReferenceIdMappingStore}. */
export interface SasReferenceIdMappingStoreOptions {
  /** Sas path guard — injected in tests, auto-detected otherwise. */
  guard?: SasPathGuard;
  /** Target org ID recorded in the file (informational). */
  orgId?: string;
  /**
   * The id the target org answers with now (`Organization.Id`), or how to ask
   * it. Recorded on persist, and compared with the one recorded in the file
   * on load. Asked once, at the first read or write: a load reads nothing
   * from its target before the entry guards have passed.
   */
  organizationId?: string | (() => Promise<string | undefined>);
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/** Whether two org ids name the same org: their first 15 characters, case included. */
function sameOrg(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/**
 * A load without the records `keys` names: forgotten by its mapping, by what
 * it created and by what removals left on them. What a removal took, what a
 * reload purged or took over as its own, is no longer this load's.
 */
function withoutRecords(load: LoadPayload, keys: ReadonlySet<string>): LoadPayload {
  if (keys.size === 0) return load;
  const mapping = Object.fromEntries(
    Object.entries(load.mapping).filter(([, id]) => !keys.has(recordKey(id))),
  );
  const created = load.created
    ?.map(({ objectApiName, referenceIds }) => ({
      objectApiName,
      referenceIds: referenceIds.filter((key) =>
        Object.prototype.hasOwnProperty.call(mapping, key),
      ),
    }))
    .filter((object) => object.referenceIds.length > 0);
  const stamps = Object.fromEntries(
    Object.entries(load.removalStamps ?? {}).filter(([id]) => !keys.has(recordKey(id))),
  );
  // Copied, then the parts set afresh: a stamp of a record that went, spread
  // from the file as it was, would outlive the record.
  const next: LoadPayload = { ...load, mapping };
  delete next.removalStamps;
  return {
    ...next,
    ...(created ? { created } : {}),
    ...(Object.keys(stamps).length > 0 ? { removalStamps: stamps } : {}),
  };
}

/**
 * Whether a load still has something a reload or a removal would look for:
 * a record it created — or, for one that does not say what it created, any
 * record at all, which the next reload judges.
 */
function stillNamesSome(load: LoadPayload): boolean {
  return load.created
    ? load.created.some((object) => object.referenceIds.length > 0)
    : Object.keys(load.mapping).length > 0;
}

/**
 * Reads and writes the referenceId→real-ID mapping in the sas.
 * `load()` tolerates a missing file (first load → empty mapping).
 */
export class SasReferenceIdMappingStore implements ReferenceIdMappingStore {
  private readonly guard: SasPathGuard;
  private readonly orgId: string;
  private readonly askOrganizationId: () => Promise<string | undefined>;
  private organizationId: Promise<string | undefined> | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly sasDir: string,
    options?: SasReferenceIdMappingStoreOptions,
  ) {
    this.guard = options?.guard ?? new SasPathGuard();
    this.orgId = options?.orgId ?? '';
    const organizationId = options?.organizationId;
    this.askOrganizationId =
      typeof organizationId === 'function' ? organizationId : async () => organizationId;
    this.now = options?.now ?? (() => new Date());
  }

  /** Absolute path of the mapping file (validated outside the repo). */
  get filePath(): string {
    return this.guard.assertOutsideRepo(path.join(this.sasDir, REFERENCEID_MAPPING_FILENAME));
  }

  /**
   * Read the persisted mapping of the last load; empty when the file does not
   * exist yet, and empty when it was written to an org the target no longer
   * is.
   *
   * A sandbox refresh replaces every record a load wrote. Handed to a reload,
   * their ids would be purged one by one from an org that never held them,
   * each a failure in the load report.
   */
  async load(): Promise<Map<string, string>> {
    const payload = await this.read();
    if (payload === undefined || (await this.writtenToAnotherOrg(payload))) return new Map();
    return new Map(Object.entries(payload.mapping ?? {}));
  }

  /**
   * The loads the file records, as a reload purges them: the last one, then
   * the ones it kept, newest first — none when there is no file, or when it
   * was written to an org the target no longer is.
   */
  async previousLoads(): Promise<PreviousLoad[]> {
    const payload = await this.read();
    if (payload === undefined || (await this.writtenToAnotherOrg(payload))) return [];
    const last = loadPartsOf(payload);
    return [...(last ? [last] : []), ...earlierOf(payload)].map((load) => ({
      mapping: new Map(Object.entries(load.mapping)),
      ...(load.created ? { created: load.created } : {}),
      ...(load.writtenBetween ? { writtenBetween: load.writtenBetween } : {}),
      ...(load.removalStamps ? { removalStamps: load.removalStamps } : {}),
    }));
  }

  /**
   * The load the file records, read as it was written — without asking the
   * target which org it is, so the page can say what a removal would take
   * without reaching the org. The removal asks, through {@link isStale},
   * once Production Guard has let it go.
   *
   * @returns Undefined when no load wrote a mapping yet.
   */
  async recorded(): Promise<RecordedLoad | undefined> {
    return (await this.recordedLoads())[0];
  }

  /**
   * Every load the file records, read as {@link recorded} reads the last one:
   * the last load first, then the ones before it that it kept, newest first.
   *
   * @returns Empty when no load wrote a mapping yet.
   */
  async recordedLoads(): Promise<RecordedLoad[]> {
    const payload = await this.read();
    if (payload === undefined) return [];
    const orgId = typeof payload.orgId === 'string' ? payload.orgId : '';
    const last = loadPartsOf(payload);
    return [
      ...(last ? [this.recordedOf(last, orgId)] : []),
      ...earlierOf(payload).map((load) => ({
        ...this.recordedOf(load, orgId),
        earlier: true as const,
      })),
    ];
  }

  private recordedOf(load: LoadPayload, orgId: string): RecordedLoad {
    return {
      orgId,
      mapping: new Map(Object.entries(load.mapping)),
      ...(load.created ? { created: load.created } : {}),
      ...(load.load ? { startedAt: load.load.startedAt } : {}),
      endedAt: endedAtOf(load),
      ...(load.writtenBetween ? { writtenBetween: load.writtenBetween } : {}),
      ...(load.removal ? { removal: load.removal } : {}),
      removalStamps: load.removalStamps ?? {},
      removalSpans: load.removalSpans ?? [],
    };
  }

  /**
   * Whether the mapping on disk names records of an org the target no longer
   * is: both ids are known, and they differ. A file written before the id was
   * recorded is never called stale.
   */
  async isStale(): Promise<boolean> {
    const payload = await this.read();
    return payload !== undefined && (await this.writtenToAnotherOrg(payload));
  }

  private async writtenToAnotherOrg(payload: MappingFilePayload): Promise<boolean> {
    const written = payload.organizationId;
    if (written === undefined) return false;
    const current = await this.currentOrganizationId();
    return current !== undefined && !sameOrg(written, current);
  }

  /** The id the target answers with now, asked on first use and kept. */
  private currentOrganizationId(): Promise<string | undefined> {
    this.organizationId ??= this.askOrganizationId();
    return this.organizationId;
  }

  /** The file as written, or `undefined` when there is none yet. */
  private async read(): Promise<MappingFilePayload | undefined> {
    const filePath = this.filePath;
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err: unknown) {
      // Only an absent file is a first load. A file that exists but cannot
      // be read still raises: a mapping read as empty would re-insert
      // records that are already in the target org.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
    return JSON.parse(content) as MappingFilePayload;
  }

  /** Write the file whole. */
  private async write(payload: MappingFilePayload): Promise<void> {
    const filePath = this.filePath;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  /**
   * The loads the file records that a load keeping them carries on, newest
   * first, each without what the load settled: none when the file was written
   * to another org, a registered one or the one a refresh left, and none of a
   * load left with nothing a reload or a removal would look for.
   */
  private async keptLoads(settled: readonly string[]): Promise<LoadPayload[]> {
    const payload = await this.read();
    if (payload === undefined || payload.orgId !== this.orgId) return [];
    if (await this.writtenToAnotherOrg(payload)) return [];
    const keys = new Set(settled.map(recordKey));
    const last = loadPartsOf(payload);
    return [...(last ? [last] : []), ...earlierOf(payload)]
      .map((load) => withoutRecords(load, keys))
      .filter(stillNamesSome);
  }

  /**
   * Persist the mapping captured at insert time. REPLACES the mapping of the
   * last load: the loader passes the full post-load mapping (reused +
   * inserted), with what it created and when it ran — and what an earlier
   * removal left there belonged to the load before.
   *
   * @param load - Which keys the load created, when it began, when the
   *   target dated its writes, and whether the loads before it are kept.
   *   Absent, the file says none of it, and the load's records cannot be
   *   removed from it.
   */
  async persist(mapping: ReadonlyMap<string, string>, load?: PersistedLoad): Promise<void> {
    const kept = load?.earlier ? await this.keptLoads(load.earlier.settled) : [];
    const organizationId = await this.currentOrganizationId();
    const endedAt = this.now().toISOString();
    await this.write({
      version: 1,
      orgId: this.orgId,
      ...(organizationId !== undefined ? { organizationId } : {}),
      updatedAt: endedAt,
      mapping: Object.fromEntries([...mapping.entries()].sort(([a], [b]) => a.localeCompare(b))),
      ...(load
        ? {
            created: load.created
              .map(({ objectApiName, referenceIds }) => ({
                objectApiName,
                referenceIds: referenceIds.filter((key) => mapping.has(key)),
              }))
              .filter((object) => object.referenceIds.length > 0),
            load: { startedAt: load.startedAt.toISOString(), endedAt },
            ...(load.writtenBetween ? { writtenBetween: { ...load.writtenBetween } } : {}),
          }
        : {}),
      ...(kept.length > 0 ? { earlier: kept } : {}),
    });
  }

  /**
   * Keep what a removal of a load did: forget the records that went, from its
   * mapping and from what it created — and from every other load the file
   * records, none of which has them any more — keep what the removal left on
   * the others and when it ran, for the next one, and mark the load once its
   * records went.
   *
   * Written only while the file still records the load removed, as the last
   * load or one before it: a load that replaced it meanwhile wrote a mapping
   * of its own, and nothing of this removal belongs in it.
   *
   * @param endedAt - When the load removed wrote its last record, as
   *   {@link recorded} named it.
   * @returns Whether the file still recorded that load, and was written.
   */
  async recordRemoval(endedAt: string, removal: RecordedRemoval): Promise<boolean> {
    const payload = await this.read();
    const last = loadPartsOf(payload);
    if (payload === undefined || last === undefined) return false;
    const loads = [last, ...earlierOf(payload)];
    const removed = loads.findIndex((load) => endedAtOf(load) === endedAt);
    if (removed < 0) return false;

    const gone = new Set(removal.gone.map(recordKey));
    const [nextLast, ...nextEarlier] = loads.map((load, index) =>
      withoutRecords(index === removed ? withRemoval(load, removal) : load, gone),
    );
    // Written from its parts: a part a record that went took with it — a
    // stamp of that record — does not survive from the file as it was.
    await this.write({
      version: 1,
      orgId: typeof payload.orgId === 'string' ? payload.orgId : '',
      ...(payload.organizationId !== undefined ? { organizationId: payload.organizationId } : {}),
      ...nextLast,
      updatedAt: this.now().toISOString(),
      ...(nextEarlier.length > 0 ? { earlier: nextEarlier } : {}),
    });
    return true;
  }

  /**
   * Keep what a reload's purge left on records of the loads the file records
   * that it did not delete, by record id: the `LastModifiedDate` the org left
   * on each. Each load that names the record keeps it with what its removals
   * left, so that its removal reads the date as the purge's doing and not as
   * a change made since the load.
   *
   * A reload stopped between setting an activated order to Draft for its
   * delete and the delete left the load that created the order named with an
   * order modified after it: its removal kept the order as changed since,
   * unless told to take those too, for a status the reload had changed and
   * given back.
   *
   * Nothing else of the file changes — not when its mapping was written, which
   * names a load recorded before loads kept their span.
   *
   * @returns Whether a load the file records names one of the records, and the
   *   file was written.
   */
  async recordStamps(stamps: Readonly<Record<string, string>>): Promise<boolean> {
    const payload = await this.read();
    const last = loadPartsOf(payload);
    if (payload === undefined || last === undefined) return false;
    const loads = [last, ...earlierOf(payload)];
    const stamped = loads.map((load) => withStamps(load, stamps));
    if (stamped.every((load, index) => load === loads[index])) return false;
    const [nextLast, ...nextEarlier] = stamped;
    await this.write({
      version: 1,
      orgId: typeof payload.orgId === 'string' ? payload.orgId : '',
      ...(payload.organizationId !== undefined ? { organizationId: payload.organizationId } : {}),
      ...nextLast,
      ...(nextEarlier.length > 0 ? { earlier: nextEarlier } : {}),
    });
    return true;
  }
}

/**
 * A load with `stamps` added to what removals left on its records, for the
 * records its mapping names: the same load when it names none of them. A
 * stamp replaces an older one of the same record, whichever length its id is
 * written in.
 */
function withStamps(load: LoadPayload, stamps: Readonly<Record<string, string>>): LoadPayload {
  const named = new Set(Object.values(load.mapping).map(recordKey));
  const added = Object.entries(stamps).filter(([id]) => named.has(recordKey(id)));
  if (added.length === 0) return load;
  const replaced = new Set(added.map(([id]) => recordKey(id)));
  return {
    ...load,
    removalStamps: {
      ...Object.fromEntries(
        Object.entries(load.removalStamps ?? {}).filter(([id]) => !replaced.has(recordKey(id))),
      ),
      ...Object.fromEntries(added),
    },
  };
}

/** A load as a removal of it leaves it: what it left on records, when it ran, and its mark. */
function withRemoval(load: LoadPayload, removal: RecordedRemoval): LoadPayload {
  const stamps = { ...load.removalStamps, ...removal.stamps };
  const spans = [...(load.removalSpans ?? []), ...(removal.span ? [removal.span] : [])];
  const mark = removal.mark ?? load.removal;
  return {
    ...load,
    ...(mark ? { removal: mark } : {}),
    ...(Object.keys(stamps).length > 0 ? { removalStamps: stamps } : {}),
    ...(spans.length > 0 ? { removalSpans: spans } : {}),
  };
}
