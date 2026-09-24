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
 * of the mapped records the load created rather than linked, when it ran, and
 * what earlier removals of it did. Record ids stay in the sas with the rest.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { ForgeRemovalSpan, ForgeUndoMark } from '@sandforge/shared';
import { SasPathGuard } from './SasPathGuard.js';
import type { LoadCreatedRecords, PersistedLoad, ReferenceIdMappingStore } from './types.js';

/** File name of the persisted mapping inside the sas directory. */
export const REFERENCEID_MAPPING_FILENAME = 'referenceid-mapping.json';

/** On-disk shape of the persisted mapping. */
interface MappingFilePayload {
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
  updatedAt: string;
  /** referenceId → real target ID. */
  mapping: Record<string, string>;
  /**
   * Per object, the keys of the mapping whose records the load created —
   * inserted, or a technical placeholder — in the order it wrote them. Every
   * other key names a record it linked or reused. Absent from files written
   * before it was recorded.
   */
  created?: LoadCreatedRecords[];
  /**
   * When the load that wrote the mapping began, and when it wrote its last
   * record, on this machine's clock. Absent from files written before it was
   * recorded.
   */
  load?: { startedAt: string; endedAt: string };
  /** Once the records the load created were removed: when, and how many went each way. */
  removal?: ForgeUndoMark;
  /**
   * What earlier removals of the load left on records they did not delete, by
   * record id: the `LastModifiedDate` the org left on each.
   */
  removalStamps?: Record<string, string>;
  /** When earlier removals of the load that wrote to the org ran, and as which user. */
  removalSpans?: ForgeRemovalSpan[];
}

/** The parts of a file the removal reads, each checked: the file comes back from disk. */
const createdSchema = z.array(
  z.object({ objectApiName: z.string(), referenceIds: z.array(z.string()) }),
);
const loadSpanSchema = z.object({ startedAt: z.string(), endedAt: z.string() });
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
  /** Set once the records the load created were removed. */
  removal?: ForgeUndoMark;
  /** What earlier removals of the load left on the records they did not delete. */
  removalStamps: Record<string, string>;
  /** When earlier removals of the load that wrote to the org ran, and as which user. */
  removalSpans: ForgeRemovalSpan[];
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
   * Read the persisted mapping; empty when the file does not exist yet, and
   * empty when it was written to an org the target no longer is.
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
   * The keys of the persisted mapping whose records a load created, per
   * object — none when there is no file, when it was written to an org the
   * target no longer is, or before loads kept them.
   */
  async loadCreated(): Promise<LoadCreatedRecords[]> {
    const payload = await this.read();
    if (payload === undefined || (await this.writtenToAnotherOrg(payload))) return [];
    return readAs(createdSchema, payload.created) ?? [];
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
    const payload = await this.read();
    if (payload === undefined) return undefined;
    const created = readAs(createdSchema, payload.created);
    const load = readAs(loadSpanSchema, payload.load);
    const removal = readAs(removalMarkSchema, payload.removal);
    return {
      orgId: typeof payload.orgId === 'string' ? payload.orgId : '',
      mapping: new Map(
        Object.entries(payload.mapping ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      ...(created ? { created } : {}),
      ...(load ? { startedAt: load.startedAt } : {}),
      endedAt: load?.endedAt ?? String(payload.updatedAt ?? ''),
      ...(removal ? { removal } : {}),
      removalStamps: readAs(removalStampsSchema, payload.removalStamps) ?? {},
      removalSpans: readAs(removalSpansSchema, payload.removalSpans) ?? [],
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
   * Persist the mapping captured at insert time. REPLACES the file: the
   * loader passes the full post-load mapping (reused + inserted, purged
   * entries removed), with what it created and when it ran — and what an
   * earlier removal left there belonged to the load before.
   *
   * @param load - Which keys the load created, and when it began. Absent, the
   *   file says neither, and the load's records cannot be removed from it.
   */
  async persist(mapping: ReadonlyMap<string, string>, load?: PersistedLoad): Promise<void> {
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
          }
        : {}),
    });
  }

  /**
   * Keep what a removal of the load did: forget the records that went, from
   * the mapping and from what the load created, keep what the removal left on
   * the others and when it ran, for the next one, and mark the load once its
   * records went.
   *
   * Written only while the file still records the load removed: a load that
   * ran meanwhile wrote a mapping of its own, and nothing of this removal
   * belongs in it.
   *
   * @param endedAt - When the load removed wrote its last record, as
   *   {@link recorded} named it.
   * @returns Whether the file still recorded that load, and was written.
   */
  async recordRemoval(endedAt: string, removal: RecordedRemoval): Promise<boolean> {
    const payload = await this.read();
    if (payload === undefined) return false;
    const load = readAs(loadSpanSchema, payload.load);
    if ((load?.endedAt ?? payload.updatedAt) !== endedAt) return false;

    const gone = new Set(removal.gone.map(recordKey));
    const mapping = Object.fromEntries(
      Object.entries(payload.mapping ?? {}).filter(
        ([, id]) => typeof id !== 'string' || !gone.has(recordKey(id)),
      ),
    );
    const created = readAs(createdSchema, payload.created)
      ?.map(({ objectApiName, referenceIds }) => ({
        objectApiName,
        referenceIds: referenceIds.filter((key) =>
          Object.prototype.hasOwnProperty.call(mapping, key),
        ),
      }))
      .filter((object) => object.referenceIds.length > 0);
    const stamps = Object.fromEntries(
      Object.entries({
        ...readAs(removalStampsSchema, payload.removalStamps),
        ...removal.stamps,
      }).filter(([id]) => !gone.has(recordKey(id))),
    );
    const spans = [
      ...(readAs(removalSpansSchema, payload.removalSpans) ?? []),
      ...(removal.span ? [removal.span] : []),
    ];
    const mark = removal.mark ?? readAs(removalMarkSchema, payload.removal);

    // Copied, then the removal's parts set afresh: a stamp of a record that
    // went, spread from the file as it was, would outlive the record.
    const next: MappingFilePayload = { ...payload, updatedAt: this.now().toISOString(), mapping };
    delete next.removal;
    delete next.removalStamps;
    delete next.removalSpans;
    await this.write({
      ...next,
      ...(created ? { created } : {}),
      ...(mark ? { removal: mark } : {}),
      ...(Object.keys(stamps).length > 0 ? { removalStamps: stamps } : {}),
      ...(spans.length > 0 ? { removalSpans: spans } : {}),
    });
    return true;
  }
}
