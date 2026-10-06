import type { RehearsedRow } from './RehearsalWriter.js';

/**
 * Up to this many rows, a rehearsal sends every row the run would create:
 * one Collections request holds 200, and a small clone is judged whole.
 */
export const EVERY_ROW_UP_TO = 200;

/** Whether a field of a row gives it a value: a field left empty is a different shape. */
function populated(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * What a row is judged as: its object, the record type it goes in with, and
 * the fields it gives a value. Two rows of the same shape meet the same
 * required fields, the same picklists of the same record type and, mostly,
 * the same rules; one of them stands for both.
 */
export function shapeOf(row: Pick<RehearsedRow, 'objectApiName' | 'fields'>): string {
  const recordType = row.fields['RecordTypeId'];
  const fields = Object.keys(row.fields)
    .filter((name) => name !== 'attributes' && populated(row.fields[name]))
    .sort();
  return [
    row.objectApiName,
    typeof recordType === 'string' ? recordType : '',
    fields.join(','),
  ].join('|');
}

/** The rows a rehearsal judges, and how many of the run's rows each stands for. */
export interface RehearsalSample {
  rows: RehearsedRow[];
  /** By `seq`, the rows of the run of the same shape, itself included. */
  standsFor: Map<number, number>;
}

/**
 * The rows to rehearse: every row when the run creates {@link EVERY_ROW_UP_TO}
 * or fewer, one row per shape ({@link shapeOf}) otherwise — the first the run
 * would create, which the rows after it are most like in what they name.
 */
export function sampleOf(rows: readonly RehearsedRow[]): RehearsalSample {
  if (rows.length <= EVERY_ROW_UP_TO) {
    return { rows: [...rows], standsFor: new Map(rows.map((row) => [row.seq, 1])) };
  }
  const firstOfShape = new Map<string, RehearsedRow>();
  const standsFor = new Map<number, number>();
  for (const row of rows) {
    const shape = shapeOf(row);
    const first = firstOfShape.get(shape);
    if (first) {
      standsFor.set(first.seq, (standsFor.get(first.seq) ?? 1) + 1);
      continue;
    }
    firstOfShape.set(shape, row);
    standsFor.set(row.seq, 1);
  }
  return { rows: [...firstOfShape.values()], standsFor };
}

/** How the rows the run creates name one another. */
export interface RowFamily {
  /** Every row the run creates, by `seq`. */
  bySeq: ReadonlyMap<number, RehearsedRow>;
  /** By `seq`, the rows a row names: the records the run creates that it needs before it. */
  parents: ReadonlyMap<number, readonly number[]>;
  /**
   * By `seq`, how far a row is from the rows that name none: 0 for those, one
   * more than its furthest parent otherwise. A row goes in a later request of
   * a call than every row it names.
   */
  levels: ReadonlyMap<number, number>;
}

/**
 * How the rows name one another, through the placeholder ids their lookups
 * hold. A row only ever names a record created before it — the executor
 * leaves a lookup to one it has not written yet empty, and fills it in after
 * — so the rows can be walked in order.
 *
 * @param rowOf - The row a value stands for, when it is a placeholder.
 */
export function familyOf(
  rows: readonly RehearsedRow[],
  rowOf: (value: unknown) => RehearsedRow | undefined,
): RowFamily {
  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  const parents = new Map<number, number[]>();
  const levels = new Map<number, number>();
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const named = new Set<number>();
    for (const value of Object.values(row.fields)) {
      const parent = rowOf(value);
      if (parent && parent.seq !== row.seq) named.add(parent.seq);
    }
    const own = [...named].sort((a, b) => a - b);
    parents.set(row.seq, own);
    levels.set(
      row.seq,
      own.reduce((most, seq) => Math.max(most, (levels.get(seq) ?? 0) + 1), 0),
    );
  }
  return { bySeq, parents, levels };
}

/** The rows a row needs before it, nearest first, each once. */
export function ancestorsOf(seq: number, family: Pick<RowFamily, 'parents'>): number[] {
  const seen = new Set<number>();
  const toVisit = [...(family.parents.get(seq) ?? [])];
  for (let next = toVisit.shift(); next !== undefined; next = toVisit.shift()) {
    if (seen.has(next)) continue;
    seen.add(next);
    toVisit.push(...(family.parents.get(next) ?? []));
  }
  return [...seen];
}

/**
 * The sample with every row its rows name: a row whose lookup points at a
 * record the run creates is judged with that record created before it, in
 * the same transaction, and the record is judged too.
 */
export function withTheirParents(
  sample: readonly RehearsedRow[],
  family: Pick<RowFamily, 'bySeq' | 'parents'>,
): RehearsedRow[] {
  const seqs = new Set<number>();
  for (const row of sample) {
    seqs.add(row.seq);
    for (const ancestor of ancestorsOf(row.seq, family)) seqs.add(ancestor);
  }
  return [...seqs]
    .sort((a, b) => a - b)
    .flatMap((seq) => {
      const row = family.bySeq.get(seq);
      return row ? [row] : [];
    });
}
