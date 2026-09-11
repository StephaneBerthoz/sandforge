/**
 * Dataset anonymizer: turns the raw sas-only extraction into the frozen,
 * versionable dataset.
 *
 * Per record, in order:
 *   1. `Id` is dropped — the stable `referenceId` is the identity;
 *   2. `RecordTypeId` is replaced by the RecordType **Name** via rt-map
 *      (resolution back to an ID happens at load time, by DeveloperName —
 *      see the RecordTypeIdResolver extension point);
 *   3. in-scope lookup values (source IDs of extracted records) are
 *      replaced by the target record's `referenceId`;
 *   4. every other field goes through its rules-file generator, default
 *      `clear` — never clear-text;
 *   5. **dead-ID sweep**: any remaining string validating the Salesforce
 *      18-char checksum is emptied (the reliable discriminant — it catches
 *      RecordType IDs of other pods and IDs pasted into free-text fields).
 *
 * The PersonContact sidecar is emitted here: Account →
 * PersonContact `referenceId → referenceId` pairs, resolved as targeted
 * updates by the load phase after insert.
 */

import { DeterministicPseudonymizer } from './DeterministicPseudonymizer.js';
import { isValidSalesforceId18 } from './salesforceId.js';
import { resolveGenerator, type PseudonymRulesFile } from './rulesFile.js';
import type {
  ExtractedDataset,
  FrozenDataset,
  FrozenObjectData,
  FrozenRecord,
  FrozenRecordTypeRef,
  PersonContactLink,
} from './types.js';

/** Anonymization inputs. */
export interface AnonymizeOptions {
  /** Raw extraction (sas-only working data). */
  extracted: ExtractedDataset;
  /** Parsed rules file (source of truth). */
  rules: PseudonymRulesFile;
  /** Salt-derived deterministic pseudonymizer. */
  pseudonymizer: DeterministicPseudonymizer;
  /** Semver of the dataset being produced (mirrored into the manifest). */
  datasetVersion: string;
}

/**
 * Applies the pseudonymization rules to a whole extracted dataset.
 * Pure in-memory transform: no I/O, no org access.
 */
export class FrozenDatasetAnonymizer {
  /** Transform the extraction into a frozen dataset. */
  anonymize(options: AnonymizeOptions): FrozenDataset {
    const { extracted, rules, pseudonymizer } = options;

    // sourceId → referenceId across ALL objects (link rewriting needs the
    // full map before any per-record pass).
    const refBySourceId = new Map<string, string>();
    for (const objectData of extracted.objects) {
      for (const record of objectData.records) {
        refBySourceId.set(record.sourceId, record.referenceId);
      }
    }

    // RecordType Id → map entry.
    const rtById = new Map(extracted.recordTypeMap.map((e) => [e.id, e]));

    // RecordType refs per object (names only — safe to version).
    const recordTypes: Record<string, FrozenRecordTypeRef[]> = {};
    for (const objectData of extracted.objects) {
      recordTypes[objectData.objectApiName] = extracted.recordTypeMap
        .filter((e) => e.sobjectType === objectData.objectApiName)
        .map((e) => ({ name: e.name, developerName: e.developerName }));
    }

    const objects: FrozenObjectData[] = [];
    for (const objectData of extracted.objects) {
      const records: FrozenRecord[] = objectData.records.map((record) => {
        const fields = this.anonymizeRecordFields(
          objectData.objectApiName,
          record.fields,
          refBySourceId,
          rtById,
          rules,
          pseudonymizer,
        );
        return { referenceId: record.referenceId, fields };
      });
      objects.push({ objectApiName: objectData.objectApiName, records });
    }

    return {
      datasetVersion: options.datasetVersion,
      objects,
      recordTypes,
      personContactSidecar: buildPersonContactSidecar(extracted, refBySourceId),
    };
  }

  /** Transform one record's fields (steps 1-5 of the file header). */
  private anonymizeRecordFields(
    objectApiName: string,
    sourceFields: Record<string, unknown>,
    refBySourceId: ReadonlyMap<string, string>,
    rtById: ReadonlyMap<string, { name: string }>,
    rules: PseudonymRulesFile,
    pseudonymizer: DeterministicPseudonymizer,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(sourceFields)) {
      // Step 1 — the source ID is never carried over.
      if (field === 'Id') {
        continue;
      }
      // Nulls/absences pass through untouched: tree exports omit null
      // fields, so absence must not be turned into emptiness.
      if (value === null || value === undefined) {
        out[field] = value;
        continue;
      }
      // Step 2 — RecordTypeId becomes the RecordType Name.
      if (field === 'RecordTypeId' && typeof value === 'string') {
        const rt = rtById.get(value);
        out[field] = rt ? rt.name : '';
        continue;
      }
      // Step 3 — in-scope lookups become referenceIds.
      if (typeof value === 'string') {
        const referenceId = refBySourceId.get(value);
        if (referenceId !== undefined) {
          out[field] = referenceId;
          continue;
        }
      }
      // Step 4 — rules-file generator, default clear.
      const generator = resolveGenerator(rules, objectApiName, field);
      out[field] = pseudonymizer.pseudonymize(generator, value);
    }
    // Step 5 — dead-ID sweep: any remaining checksum-valid Salesforce ID
    // is emptied (catches out-of-scope lookups and IDs in free text).
    for (const [field, value] of Object.entries(out)) {
      if (typeof value === 'string' && isValidSalesforceId18(value)) {
        out[field] = '';
      }
    }
    return out;
  }
}

/**
 * Build the PersonContact sidecar from the RAW extraction: for each
 * Account carrying a `PersonContactId` that resolves to an extracted
 * Contact, emit the referenceId pair. Source IDs never appear in it.
 */
function buildPersonContactSidecar(
  extracted: ExtractedDataset,
  refBySourceId: ReadonlyMap<string, string>,
): PersonContactLink[] {
  const links: PersonContactLink[] = [];
  const accounts = extracted.objects.find((o) => o.objectApiName === 'Account');
  if (!accounts) {
    return links;
  }
  for (const account of accounts.records) {
    const personContactId = account.fields.PersonContactId;
    if (typeof personContactId !== 'string' || personContactId === '') {
      continue;
    }
    const contactReferenceId = refBySourceId.get(personContactId);
    if (contactReferenceId !== undefined) {
      links.push({
        accountReferenceId: account.referenceId,
        contactReferenceId,
      });
    }
  }
  return links;
}
