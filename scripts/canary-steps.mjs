/**
 * What the canary reads of the output of SandForge's commands, and of the
 * records it compares. Kept apart from `canary.mjs`, which runs as it is
 * loaded, so that each reading can be tested without an org.
 */
import { createHash } from 'node:crypto';

/** A date as a SOQL literal takes it, to the second. */
export const soqlDate = (epoch) => new Date(epoch).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The last message of `type` among those a command printed with `--json`:
 * the Frozen and DataOps commands print every message the panel would have
 * received, under `posted`.
 */
export const postedOf = (doc, type) =>
  (doc?.posted ?? []).filter((message) => message?.type === type).at(-1);

/**
 * The first error a command posted, as its type and message: in `--json`
 * mode the Frozen and DataOps commands say why a step failed there, and
 * nothing on their error output.
 */
export function postedError(doc) {
  const error = (doc?.posted ?? []).find((message) =>
    String(message?.type ?? '').endsWith(':error'),
  );
  if (!error) return undefined;
  const code = error.payload?.code ? ` [${error.payload.code}]` : '';
  return `${error.type}: ${error.payload?.message ?? 'no message'}${code}`;
}

/**
 * The records a Frozen load created, per object in the order it wrote them,
 * as target ids: from the mapping the load keeps in the sas. A removal makes
 * the mapping forget what it deleted, so it is read before one, to count
 * afterwards by id what the target still holds.
 */
export function frozenCreated(mapping) {
  const ids = mapping?.mapping ?? {};
  const byObject = new Map();
  for (const { objectApiName, referenceIds } of mapping?.created ?? []) {
    const created = (referenceIds ?? []).map((referenceId) => ids[referenceId]).filter(Boolean);
    if (created.length > 0) {
      byObject.set(objectApiName, [...(byObject.get(objectApiName) ?? []), ...created]);
    }
  }
  return byObject;
}

/** What a Frozen dry run says a load would do: records of the dataset, to insert, to link, not sent. */
export function frozenPreviewCounts(plan) {
  const counts = { fromFiles: 0, toInsert: 0, toLink: 0, notSent: 0 };
  for (const object of plan?.perObject ?? []) {
    counts.fromFiles += object.fromFiles ?? 0;
    counts.toInsert += object.toInsert ?? 0;
    counts.toLink += (object.reusedByKeys ?? 0) + (object.reusedFromCatalog ?? 0);
    counts.notSent += object.notSent ?? 0;
  }
  return counts;
}

/**
 * Whether a record a Frozen load did not write was held back for a parent
 * the target refused rather than refused itself: its one error is the
 * load's own `PARENT_REFUSED`.
 */
const heldBack = (errors) =>
  Array.isArray(errors) && errors.length === 1 && String(errors[0]).startsWith('PARENT_REFUSED:');

/**
 * What a Frozen load did: records inserted, those of them written again
 * without a field the target refused, records linked to one the target held,
 * records refused, and records held back for a parent it refused.
 */
export function frozenLoadCounts(report) {
  const counts = {
    fromFiles: 0,
    inserted: 0,
    withoutFields: 0,
    linked: 0,
    refused: 0,
    heldBack: 0,
  };
  for (const object of report?.perObject ?? []) {
    counts.fromFiles += object.fromFiles ?? 0;
    counts.inserted += object.inserted ?? 0;
    counts.withoutFields += object.writtenWithoutFields?.rows ?? 0;
    counts.linked += object.reused ?? 0;
    for (const failed of object.failed ?? []) {
      if (heldBack(failed.errors)) counts.heldBack++;
      else counts.refused++;
    }
  }
  return counts;
}

/**
 * The records a Seed run planned, per object: for a dry run, what it would
 * write; for a run, what it wrote and what the org refused. Run with the
 * same `--seed`, the two are equal.
 */
export function seedPlanned(result) {
  const planned = {};
  for (const object of result?.objectResults ?? []) {
    planned[object.objectApiName] =
      (planned[object.objectApiName] ?? 0) +
      (object.recordsCreated ?? 0) +
      (object.recordsFailed ?? 0);
  }
  return planned;
}

/**
 * The records a Seed run wrote again without the fields the org refused them
 * on, a validation rule's among them: said in a note among an object's
 * errors (`fieldsLeftOutNote`), not counted among its failures.
 */
export function seedWrittenAgain(result) {
  let rows = 0;
  for (const object of result?.objectResults ?? []) {
    for (const note of object.errors ?? []) {
      const said = /^(\d+) record\(s\) written again without/.exec(String(note));
      if (said) rows += Number(said[1]);
    }
  }
  return rows;
}

/** The records a Seed run created, per object: what its `--remove` takes back. */
export function seedCreated(result) {
  const byObject = new Map();
  for (const { objectApiName, createdIds } of result?.objectResults ?? []) {
    if ((createdIds ?? []).length > 0) {
      byObject.set(objectApiName, [...(byObject.get(objectApiName) ?? []), ...createdIds]);
    }
  }
  return byObject;
}

/**
 * The records an Autopilot run created, per object, from the ids its
 * `--json` summary prints: nothing else tells them from the target's own.
 */
export function autopilotCreated(doc) {
  return new Map(
    Object.entries(doc?.created ?? {}).filter(([, ids]) => Array.isArray(ids) && ids.length > 0),
  );
}

/** How many ids a map of object → ids holds. */
export const idCount = (byObject) =>
  [...byObject.values()].reduce((sum, ids) => sum + ids.length, 0);

/** A value as the checksum reads it: an absent field and an empty one alike. */
const cell = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * A digest of `fields` of `rows`: the same for the same values, whatever
 * order the rows came back in. Taken before a masking and after its restore,
 * the two are equal when every value went back.
 */
export function fieldsChecksum(rows, fields) {
  const lines = [...(rows ?? [])]
    .sort((a, b) => String(a.Id).localeCompare(String(b.Id)))
    .map((row) => JSON.stringify([row.Id, ...fields.map((field) => cell(row[field]))]));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** How many rows of `after` hold, on `fields`, other values than the row of the same Id in `before`. */
export function changedRows(before, after, fields) {
  const was = new Map((before ?? []).map((row) => [row.Id, row]));
  return (after ?? []).filter((row) => {
    const old = was.get(row.Id);
    return old !== undefined && fields.some((field) => cell(old[field]) !== cell(row[field]));
  }).length;
}

/**
 * A window around dates, as SOQL literals: from `leadMs` before the first,
 * down to its second, to `trailMs` after the last, up to its second.
 * Undefined when no date reads as one.
 */
export function windowAround(dates, leadMs, trailMs) {
  const epochs = (dates ?? []).map((date) => Date.parse(date ?? '')).filter(Number.isFinite);
  if (epochs.length === 0) return undefined;
  return {
    from: soqlDate(Math.floor((Math.min(...epochs) - leadMs) / 1000) * 1000),
    to: soqlDate(Math.ceil((Math.max(...epochs) + trailMs) / 1000) * 1000),
  };
}
