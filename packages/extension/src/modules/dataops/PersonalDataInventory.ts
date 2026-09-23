import type {
  PiiInventoryField,
  PiiInventoryObjectResult,
  PiiInventoryResult,
} from '@sandforge/shared';
import { PII_SAMPLE_SIZE } from '@sandforge/shared';

import type { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { describedObjectSchema } from './DataQualityScanner.js';
import type { DescribedField } from './DataQualityScanner.js';
import type { OrgSession } from './RecordRemoval.js';
import {
  detectPersonalData,
  holdsText,
  isFilledValue,
  isWrittenByPeople,
  searchKindOf,
  subjectNameField,
} from './personalDataFields.js';

/** What an inventory needs of the detector: its verdict, and the patterns it reads values with. */
export type InventoryDetector = Pick<PIIDetector, 'detectPII' | 'getPatterns'>;

/** What an inventory is asked to read. */
export interface InventoryRequest {
  orgId: string;
  objects: string[];
}

/**
 * Fields one sample query selects. An object with more text fields is read in
 * several queries, the same records each time — they are taken by Id — so the
 * query text stays well short of what the org accepts in a URL.
 */
export const SAMPLE_FIELDS_PER_QUERY = 100;

/**
 * The last {@link PII_SAMPLE_SIZE} records of an object by Id, `fields` of
 * each. The Id order makes every query of a wide object return the same
 * records, which are then put back together.
 */
async function readSample(
  conn: Pick<OrgSession, 'query'>,
  objectApiName: string,
  fields: readonly DescribedField[],
): Promise<Array<Record<string, unknown>>> {
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const names = fields.map((f) => assertSoqlIdentifier(f.name)).filter((n) => n !== 'Id');
  const chunks: string[][] = [];
  for (let at = 0; at < names.length; at += SAMPLE_FIELDS_PER_QUERY) {
    chunks.push(names.slice(at, at + SAMPLE_FIELDS_PER_QUERY));
  }
  if (chunks.length === 0) chunks.push([]);
  for (const chunk of chunks) {
    const answer = await conn.query(
      `SELECT ${['Id', ...chunk].join(', ')} FROM ${objectApiName} ` +
        `ORDER BY Id DESC LIMIT ${PII_SAMPLE_SIZE}`,
    );
    for (const raw of answer.records) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
      delete record.attributes;
      const id = typeof record.Id === 'string' ? record.Id : undefined;
      if (!id) continue;
      const known = byId.get(id);
      if (known) Object.assign(known, record);
      else {
        byId.set(id, record);
        order.push(id);
      }
    }
  }
  return order.map((id) => byId.get(id) as Record<string, unknown>);
}

/** Read one object. A describe the org refuses fails the object, not the inventory. */
async function inventoryObject(
  conn: Pick<OrgSession, 'describe' | 'query'>,
  detector: InventoryDetector,
  requested: string,
): Promise<PiiInventoryObjectResult> {
  let described;
  let objectApiName: string;
  try {
    described = describedObjectSchema.parse(await conn.describe(assertSoqlIdentifier(requested)));
    objectApiName = assertSoqlIdentifier(described.name);
    if (described.queryable === false) throw new Error(`${objectApiName} cannot be queried.`);
  } catch (err: unknown) {
    return { status: 'failed', objectApiName: requested, message: extractErrorMessage(err) };
  }

  // Named from their names and types first: the sample reads those, and every
  // text field people write, whose values may give away what their names do not.
  const byNameAndType = detectPersonalData(detector, objectApiName, described.fields);
  const named = new Set(byNameAndType.map((d) => d.field.name));
  const sampled = described.fields.filter(
    (f) => (holdsText(f) && isWrittenByPeople(f)) || named.has(f.name),
  );

  let sample: Array<Record<string, unknown>> = [];
  let sampleError: string | undefined;
  try {
    sample = await readSample(conn, objectApiName, sampled);
  } catch (err: unknown) {
    sampleError = extractErrorMessage(err);
  }

  const detected = sampleError
    ? byNameAndType
    : detectPersonalData(detector, objectApiName, described.fields, sample);
  const patterns = detector.getPatterns();
  const fields: PiiInventoryField[] = detected
    .map((d) => {
      const kind = searchKindOf(d.field);
      const values = sample.map((record) => record[d.field.name]);
      const regex = d.detectedBy === 'content' ? patterns[d.pattern] : undefined;
      return {
        fieldApiName: d.field.name,
        label: d.field.label,
        classification: d.classification,
        detectedBy: d.detectedBy,
        pattern: d.pattern,
        filled: values.filter(isFilledValue).length,
        ...(regex
          ? { matched: values.filter((v) => typeof v === 'string' && regex.test(v)).length }
          : {}),
        ...(kind ? { searchedFor: kind } : {}),
      };
    })
    // The fields the sample confirms first, the most filled first.
    .sort((a, b) => b.filled - a.filled || a.label.localeCompare(b.label));

  const nameField = subjectNameField(described);
  return {
    status: 'scanned',
    objectApiName: requested,
    label: described.label,
    sampled: sample.length,
    fields,
    nameField: nameField ? { fieldApiName: nameField.name, label: nameField.label } : null,
    ...(sampleError !== undefined ? { sampleError } : {}),
  };
}

/**
 * Which fields of the objects asked for hold personal data.
 *
 * The detector the Seed and Sync pre-flight runs names the fields from their
 * names, labels and types. The inventory then reads a sample — the last
 * {@link PII_SAMPLE_SIZE} records of each object by Id — to see which of those
 * fields actually hold values, and hands the sample's text values to the same
 * detector, which names the fields whose values look like an email, a phone,
 * a card or a bank number whatever they are called. What comes back is counts:
 * no value read leaves the extension.
 *
 * @param conn - The org.
 * @param detector - The pre-flight PII detector.
 * @param request - The org and the objects to read.
 * @param now - When the inventory ran (injected by tests).
 */
export async function inventoryPersonalData(
  conn: Pick<OrgSession, 'describe' | 'query'>,
  detector: InventoryDetector,
  request: InventoryRequest,
  now: () => Date = () => new Date(),
): Promise<PiiInventoryResult> {
  const scannedAt = now().toISOString();
  const objects: PiiInventoryObjectResult[] = [];
  for (const objectApiName of request.objects) {
    objects.push(await inventoryObject(conn, detector, objectApiName));
  }
  return { orgId: request.orgId, scannedAt, sampleSize: PII_SAMPLE_SIZE, objects };
}
