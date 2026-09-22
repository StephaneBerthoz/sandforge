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
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SasPathGuard } from './SasPathGuard.js';
import type { ReferenceIdMappingStore } from './types.js';

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

  /**
   * Persist the mapping captured at insert time. REPLACES the file: the
   * loader passes the full post-load mapping (reused + inserted, purged
   * entries removed).
   */
  async persist(mapping: ReadonlyMap<string, string>): Promise<void> {
    const filePath = this.filePath;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const organizationId = await this.currentOrganizationId();
    const payload: MappingFilePayload = {
      version: 1,
      orgId: this.orgId,
      ...(organizationId !== undefined ? { organizationId } : {}),
      updatedAt: this.now().toISOString(),
      mapping: Object.fromEntries([...mapping.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}
