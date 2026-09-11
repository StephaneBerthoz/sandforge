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

import * as fs from 'node:fs';
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
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/**
 * Reads and writes the referenceId→real-ID mapping in the sas.
 * `load()` tolerates a missing file (first load → empty mapping).
 */
export class SasReferenceIdMappingStore implements ReferenceIdMappingStore {
  private readonly guard: SasPathGuard;
  private readonly orgId: string;
  private readonly now: () => Date;

  constructor(
    private readonly sasDir: string,
    options?: SasReferenceIdMappingStoreOptions,
  ) {
    this.guard = options?.guard ?? new SasPathGuard();
    this.orgId = options?.orgId ?? '';
    this.now = options?.now ?? (() => new Date());
  }

  /** Absolute path of the mapping file (validated outside the repo). */
  get filePath(): string {
    return this.guard.assertOutsideRepo(path.join(this.sasDir, REFERENCEID_MAPPING_FILENAME));
  }

  /** Read the persisted mapping; empty when the file does not exist yet. */
  async load(): Promise<Map<string, string>> {
    const filePath = this.filePath;
    if (!fs.existsSync(filePath)) {
      return new Map();
    }
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MappingFilePayload;
    return new Map(Object.entries(payload.mapping ?? {}));
  }

  /**
   * Persist the mapping captured at insert time. REPLACES the file: the
   * loader passes the full post-load mapping (reused + inserted, purged
   * entries removed).
   */
  async persist(mapping: ReadonlyMap<string, string>): Promise<void> {
    const filePath = this.filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload: MappingFilePayload = {
      version: 1,
      orgId: this.orgId,
      updatedAt: this.now().toISOString(),
      mapping: Object.fromEntries([...mapping.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}
