/**
 * What a masking run, or a backup, in slices costs, worked out before it is
 * asked from the rows each object holds: its slices, the requests it sends,
 * the Bulk API batches it uses — none —, the disk its snapshots take, and how
 * long it takes. Pure: the org's counts and limits are read elsewhere.
 */

import { MAX_SLICES_PER_SET } from '@sandforge/shared';
import type { SlicePlanObject } from '@sandforge/shared';

import { SECONDS_PER_PAGE, SECONDS_PER_WRITE } from '../../checkpoint/rewindEstimate.js';

/** Rows a masking run writes back per update call: the most one REST collection takes. */
export const SLICE_WRITE_BATCH = 200;

/**
 * Bytes a row of a snapshot takes on disk, about: its id and the JSON around
 * it, and as much again for each field it keeps. Recalibrated by the size of
 * the first slice's file once it is written.
 */
const BYTES_PER_ROW = 48;
const BYTES_PER_FIELD = 64;

/** One object as a plan reads it. */
export interface SlicePlanInput {
  objectApiName: string;
  /** Rows the run holds it to, as counted. */
  rows: number;
  /** The fields its snapshots keep, the Id among them. */
  fields: number;
  /** Set when the count is the org's approximate one. */
  approximate?: boolean;
  /** Whether the object has an active duplicate rule: two more reads a slice. */
  duplicateRule?: boolean;
}

/** What a plan says of one object, and of every object. */
export interface SlicesPlanned {
  objects: SlicePlanObject[];
  requests: number;
  parts: { snapshots: number; updates: number; reads: number };
  diskBytes: number;
  seconds: number;
  /** The objects that would make more slices than a set holds. */
  tooMany: string[];
}

/** Slices `rows` make, `size` a slice: one at least, which finds the object empty. */
export function slicesFor(rows: number, size: number): number {
  return Math.max(1, Math.ceil(rows / size));
}

/** Requests one slice of `rows` sends: its snapshot's pages, the org's clock, its updates. */
export function sliceRequests(
  rows: number,
  pageSize: number,
  options: { masking: boolean; duplicateRule?: boolean },
): number {
  const pages = Math.max(1, Math.ceil(rows / pageSize));
  const updates = options.masking ? Math.ceil(rows / SLICE_WRITE_BATCH) : 0;
  return pages + 1 + updates + (options.duplicateRule ? 2 : 0);
}

/**
 * The plan of a run in slices.
 *
 * Per object: each slice's snapshot pages and the org's clock read before
 * it, the read that finds the object ended, two reads of what its duplicate
 * rules wrote when it has one, and the updates of a masking run; then the
 * count of rows created while it went. A backup in slices writes nothing.
 *
 * @param size - Rows a slice holds.
 * @param pageSize - Rows a page of a snapshot reads: 2,000 in a sandbox, 500 in production.
 * @param kind - A masking run writes its rows back; a backup does not.
 */
export function planSlices(
  objects: readonly SlicePlanInput[],
  size: number,
  pageSize: number,
  kind: 'masking' | 'backup',
): SlicesPlanned {
  let snapshots = 0;
  let updates = 0;
  let reads = 0;
  let diskBytes = 0;
  const planned: SlicePlanObject[] = [];
  const tooMany: string[] = [];
  for (const object of objects) {
    const slices = slicesFor(object.rows, size);
    if (slices > MAX_SLICES_PER_SET) tooMany.push(object.objectApiName);
    const full = Math.floor(object.rows / size);
    const rest = object.rows - full * size;
    // Each full slice's pages, the rest's, and the read that finds no row past the last.
    snapshots += full * Math.ceil(size / pageSize) + Math.ceil(rest / pageSize) + 1;
    if (kind === 'masking') updates += Math.ceil(object.rows / SLICE_WRITE_BATCH);
    // The org's clock before each slice, what the duplicate rules wrote,
    // and the counts of rows created as the run went.
    reads += slices + (object.duplicateRule && kind === 'masking' ? 2 * slices : 0) + 2;
    diskBytes += object.rows * (BYTES_PER_ROW + BYTES_PER_FIELD * object.fields);
    planned.push({
      objectApiName: object.objectApiName,
      size,
      slices,
      ...(object.approximate ? { approximate: true as const } : {}),
    });
  }
  return {
    objects: planned,
    requests: snapshots + updates + reads,
    parts: { snapshots, updates, reads },
    diskBytes,
    seconds: Math.round(snapshots * SECONDS_PER_PAGE + updates * SECONDS_PER_WRITE),
    tooMany,
  };
}

/** The disk a plan wants free before it starts: what its snapshots take, and a tenth more. */
export function diskNeeded(diskBytes: number): number {
  return Math.ceil(diskBytes * 1.1);
}

/** A count of bytes as a person reads it: `1.2 GB`, `412 MB`, `80 KB`. */
export function bytesWords(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
