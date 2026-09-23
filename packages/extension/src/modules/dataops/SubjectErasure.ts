import type {
  DataOpsAnonymizationRule,
  RemovalPlanObject,
  SubjectEraseMode,
} from '@sandforge/shared';

import type { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { describedObjectSchema } from './DataQualityScanner.js';
import type { DescribedObject } from './DataQualityScanner.js';
import type { AnonymizationEngine } from './AnonymizationEngine.js';
import type { OrgSession, WriteCounts } from './RecordRemoval.js';
import {
  countRelated,
  deleteRecords,
  readRecordsById,
  updateRecords,
  workedObjects,
} from './RecordRemoval.js';
import {
  detectPersonalData,
  holdsValue,
  isFilledValue,
  planErasure,
} from './personalDataFields.js';
import type { ErasedField } from './personalDataFields.js';

/** The records of one object an erasure is asked to act on. */
export interface ErasureTarget {
  objectApiName: string;
  ids: string[];
}

/** One object of an erasure, planned: what it will do, and what it needs to do it. */
export interface PreparedErasure {
  plan: RemovalPlanObject;
  /** The object's own name, as the org spells it. */
  objectApiName: string;
  /** Anonymize: the records as read, and how each field is overwritten. */
  records?: Array<Record<string, unknown>>;
  erased?: ErasedField[];
  /** Delete: the records to delete. */
  ids?: string[];
}

/**
 * The plan of an anonymizing erasure of one object: read the records, let the
 * detector name the fields that hold personal data — on these very records,
 * by name, type and value — and add the person's name.
 */
async function prepareAnonymization(
  conn: Pick<OrgSession, 'query'>,
  detector: Pick<PIIDetector, 'detectPII'>,
  object: DescribedObject,
  ids: readonly string[],
): Promise<PreparedErasure> {
  const valueFields = object.fields.filter(holdsValue).map((f) => f.name);
  const records = await readRecordsById(conn, object.name, valueFields, ids);
  const detected = detectPersonalData(detector, object.name, object.fields, records);
  const erasure = planErasure(object, detected);
  return {
    objectApiName: object.name,
    records,
    erased: erasure.fields,
    plan: {
      objectApiName: object.name,
      label: object.label,
      records: records.length,
      fields: erasure.fields.map((e) => ({
        fieldApiName: e.field.name,
        label: e.field.label,
        method: e.method,
      })),
      kept: erasure.kept.map((f) => ({ fieldApiName: f.name, label: f.label })),
    },
  };
}

/**
 * Plan an erasure: per object, what an anonymizing run would overwrite and
 * how, or what a delete would take with it. Nothing is written.
 *
 * An object the connected user may not update — or delete — is planned as
 * refused, and the run leaves it alone.
 *
 * @param conn - The org.
 * @param detector - The pre-flight PII detector.
 * @param mode - Overwrite in place, or delete.
 * @param targets - The records to erase, per object.
 */
export async function prepareErasure(
  conn: Pick<OrgSession, 'describe' | 'describeGlobal' | 'query'>,
  detector: Pick<PIIDetector, 'detectPII'>,
  mode: SubjectEraseMode,
  targets: readonly ErasureTarget[],
): Promise<PreparedErasure[]> {
  const prepared: PreparedErasure[] = [];
  let worked: Map<string, string> | undefined;
  for (const target of targets) {
    const object = describedObjectSchema.parse(
      await conn.describe(assertSoqlIdentifier(target.objectApiName)),
    );
    const refusedPlan = (refused: string): PreparedErasure => ({
      objectApiName: object.name,
      plan: { objectApiName: object.name, label: object.label, records: 0, refused },
    });
    if (mode === 'anonymize') {
      if (object.updateable !== true) {
        prepared.push(refusedPlan(`The connected user may not edit ${object.label} records.`));
        continue;
      }
      prepared.push(await prepareAnonymization(conn, detector, object, target.ids));
      continue;
    }
    if (object.deletable !== true) {
      prepared.push(refusedPlan(`The connected user may not delete ${object.label} records.`));
      continue;
    }
    worked ??= await workedObjects(conn);
    const related = await countRelated(conn, object, target.ids, worked);
    prepared.push({
      objectApiName: object.name,
      ids: [...target.ids],
      plan: {
        objectApiName: object.name,
        label: object.label,
        records: target.ids.length,
        related: related.related,
        uncounted: related.uncounted,
      },
    });
  }
  return prepared;
}

/**
 * The anonymizer's rules for one object's erasure. Each carries no salt, so
 * the engine draws its made-up values from the key it was built with.
 */
function erasureRules(
  objectApiName: string,
  erased: readonly ErasedField[],
): DataOpsAnonymizationRule[] {
  return erased.map((e) => ({
    objectApiName,
    fieldApiName: e.field.name,
    method: e.method,
    config: {},
  }));
}

/**
 * Run a prepared erasure: overwrite with the DataOps anonymizer, or delete.
 * Objects planned as refused are left alone, and every record the org refuses
 * is counted, not dropped.
 *
 * @param conn - The org.
 * @param engine - The DataOps anonymizer.
 * @param prepared - What {@link prepareErasure} planned.
 * @param onObject - Told as each object is done.
 */
export async function runErasure(
  conn: Pick<OrgSession, 'update' | 'destroy'>,
  engine: Pick<AnonymizationEngine, 'anonymize'>,
  prepared: readonly PreparedErasure[],
  onObject?: (objectApiName: string, counts: WriteCounts) => void,
): Promise<Array<{ objectApiName: string; counts: WriteCounts }>> {
  const done: Array<{ objectApiName: string; counts: WriteCounts }> = [];
  for (const object of prepared) {
    if (object.plan.refused) continue;
    let counts: WriteCounts;
    if (object.ids) {
      counts = await deleteRecords(conn, object.objectApiName, object.ids);
    } else {
      const erased = object.erased ?? [];
      const records = object.records ?? [];
      if (erased.length === 0 || records.length === 0) continue;
      const masked = engine.anonymize(records, erasureRules(object.objectApiName, erased));
      // Only the Id and the fields that held something are sent: an empty
      // field holds no one's data, and a made-up value written into it would
      // be data the record never had. The rest of what was read stays as the
      // org holds it.
      const payloads: Array<Record<string, unknown>> = [];
      let untouched = 0;
      records.forEach((original, index) => {
        const payload: Record<string, unknown> = { Id: original.Id };
        for (const e of erased) {
          if (isFilledValue(original[e.field.name]))
            payload[e.field.name] = masked[index][e.field.name] ?? null;
        }
        if (Object.keys(payload).length > 1) payloads.push(payload);
        else untouched++;
      });
      counts = await updateRecords(conn, object.objectApiName, payloads);
      // A record with none of those fields filled has nothing left to erase.
      counts.done += untouched;
    }
    done.push({ objectApiName: object.objectApiName, counts });
    onObject?.(object.objectApiName, counts);
  }
  return done;
}
