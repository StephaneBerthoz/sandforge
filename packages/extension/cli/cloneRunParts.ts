/**
 * The parts of a clone that stopped and was taken up, as the removal of one
 * of its summaries reads them from the run's journal: what each part created,
 * linked to and wrote beyond its own records, and when it ran.
 *
 * A clone cut by an interrupt and resumed keeps one journal and prints two
 * summaries, one per part, each removed on its own (`--remove <summary>`), or
 * the run whole by its journal (`--remove <journal>`). Each removal read its
 * own part alone: live, the resume's removal deleted its product lines, the
 * org restamped the cut part's opportunity, and the cut part's removal then
 * kept that opportunity as changed since the run, and its contact for the
 * contact role the resume had linked to. What one part's removal leaves, and
 * what the run's later parts wrote, is read here for every removal of the run.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ForgeRunObjectRecords } from '@sandforge/shared';
import type { ForgeRunJournal } from '../src/modules/forge/ForgeRunJournal.js';
import type { RunLaterPart, RunPartAlongside } from '../src/modules/forge/ForgeRunRemoval.js';
import { jobEndedTimesOf } from '../src/modules/forge/ForgeRunStore.js';

// Read by the panel's removals of a run's parts as by these: kept with them.
export {
  mergedPreviewObjects,
  mergedUndoObjects,
  spansOf,
} from '../src/modules/forge/removalOutcome.js';

/** A Salesforce id, as a journal writes one. */
const ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** One part of a run, as its journal says it. */
export interface RunPart {
  /** Its place in the journal, from 0. */
  part: number;
  /** What it created, by target id, children before their parents. */
  created: ForgeRunObjectRecords[];
  /** The target ids of the records it linked to: the target held them, or the org made them as the run wrote. */
  linked: string[];
  /**
   * The target ids of the records it wrote to beyond those it created: a
   * lookup an earlier part's record owed, filled in, a status given back.
   */
  wrote: string[];
  /** When it began, on the clock of the machine that ran it. */
  startedAt?: string;
  /** When it ended, or its last line, on that clock. */
  endedAt?: string;
  /**
   * When the last Bulk API job it closed ended, as the org dated it, read
   * back since (`jobEndedLine`): it wrote until then.
   */
  jobEndedAt?: string;
}

/** What the lines of a journal say of each part, beside its records: see {@link RunPart}. */
interface PartLines {
  startedAt?: string;
  endedAt?: string;
  jobEndedAt?: string;
  wrote: string[];
}

/**
 * Read, line by line, the parts of the journal at `path`: when each began and
 * ended — its end, its last call, or the end of a Bulk API job it had under
 * way, read back since (`jobEndedLine`) — and what its second pass wrote to
 * (`["p", id, field]`, a lookup filled in; `["g", object, id]`, a status
 * given). A line that does not read is passed over, as the journal's own
 * reader passes it.
 */
async function partLinesOf(path: string): Promise<PartLines[]> {
  const parts: PartLines[] = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  const later = (part: PartLines, time: unknown): void => {
    if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) return;
    if (part.endedAt === undefined || Date.parse(time) > Date.parse(part.endedAt)) {
      part.endedAt = time;
    }
  };
  for await (const line of lines) {
    const current = parts.at(-1);
    if (line.startsWith('{"part":')) {
      try {
        const { part } = JSON.parse(line) as { part?: { startedAt?: unknown } };
        const startedAt = typeof part?.startedAt === 'string' ? part.startedAt : undefined;
        parts.push({ ...(startedAt ? { startedAt } : {}), wrote: [] });
      } catch {
        parts.push({ wrote: [] });
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('{"end":')) {
      try {
        later(current, (JSON.parse(line) as { end?: { at?: unknown } }).end?.at);
      } catch {
        // The last line of a run killed as it wrote: the others stand.
      }
      continue;
    }
    // A Bulk API job the part closed went on to its end after it stopped:
    // read back since, the part ends no earlier than the job, on this
    // machine's clock. Ended at its last line, a removal kept as changed
    // since the run the 2 520 cases such a job wrote, live.
    const jobEnded = jobEndedTimesOf(line);
    if (jobEnded) {
      later(current, jobEnded.at);
      if (
        current.jobEndedAt === undefined ||
        Date.parse(jobEnded.orgAt) > Date.parse(current.jobEndedAt)
      ) {
        current.jobEndedAt = jobEnded.orgAt;
      }
      continue;
    }
    if (!line.startsWith('["x"') && !line.startsWith('["p"') && !line.startsWith('["g"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(value)) continue;
    const [tag, a, b, c] = value as unknown[];
    if (tag === 'x') later(current, c);
    else if (tag === 'p' && typeof a === 'string' && ID.test(a)) current.wrote.push(a);
    else if (tag === 'g' && typeof b === 'string' && ID.test(b)) current.wrote.push(b);
  }
  return parts;
}

/**
 * The parts of the run whose journal is at `path`, each with what it created
 * and linked to, as the journal's reader gives them, and what its lines say
 * beside: see {@link RunPart}. None when the journal is not there, or cannot
 * be read as a run's.
 */
export async function runPartsOf(path: string, journals: ForgeRunJournal): Promise<RunPart[]> {
  if (!existsSync(path)) return [];
  let lines: PartLines[];
  try {
    lines = await partLinesOf(path);
  } catch {
    return [];
  }
  const parts: RunPart[] = [];
  for (const [part, said] of lines.entries()) {
    const read = await journals.readAt(path, part).catch(() => undefined);
    if (!read) return [];
    parts.push({
      part,
      created: read.created,
      linked: read.remap.linked.flatMap((sourceId) => {
        const target = read.remap.table[sourceId];
        return target !== undefined ? [target] : [];
      }),
      wrote: said.wrote,
      ...(said.startedAt ? { startedAt: said.startedAt } : {}),
      ...(said.endedAt ? { endedAt: said.endedAt } : {}),
      ...(said.jobEndedAt ? { jobEndedAt: said.jobEndedAt } : {}),
    });
  }
  return parts;
}

/**
 * A part's span as this machine's clock dated it, for a removal to read on
 * the org's (`runRecordedAt`, `runDurationMs`): its end, right after its last
 * write, and how long it ran. Undefined when its lines say no end.
 *
 * The removal of the part's records ends it with its last write as the org
 * dated it (`endedByItsWrites`), read in what it reads of them: ten seconds
 * of leeway after the end its lines say took a contact role made by hand
 * eight seconds after a cut part ended for the run's.
 *
 * A part whose Bulk API job ended after it stopped ends no earlier than the
 * job, as the org dated it (`writtenUntil`): ended with its last write, the
 * job's last batch, the feed items the platform made a second later under
 * those 120 cases read as added since the run, live, and kept them.
 */
export function machineSpanOf(part: RunPart): RunPartAlongside['span'] | undefined {
  const ended = Date.parse(part.endedAt ?? '');
  if (!Number.isFinite(ended)) return undefined;
  const began = Date.parse(part.startedAt ?? '');
  const jobEnded = Date.parse(part.jobEndedAt ?? '');
  return {
    runRecordedAt: new Date(ended),
    runDurationMs: Number.isFinite(began) && began <= ended ? ended - began : 0,
    endedByItsWrites: true,
    ...(Number.isFinite(jobEnded) ? { writtenUntil: new Date(jobEnded) } : {}),
  };
}

/**
 * The parts after `part`, each with what it wrote to and linked to, for the
 * removal of `part`, or of another part's records alongside it, to read as
 * the run's doing (`RunRemovalOptions.laterParts`). A part whose end its
 * lines do not say is left out: what it wrote then reads as a change.
 */
export function laterPartsOf(parts: readonly RunPart[], part: number): RunLaterPart[] {
  return parts.flatMap((later) => {
    if (later.part <= part || (later.wrote.length === 0 && later.linked.length === 0)) return [];
    const span = machineSpanOf(later);
    if (!span) return [];
    // Read against its recorded end: see `RunLaterPart.span`.
    const recorded = { runRecordedAt: span.runRecordedAt, runDurationMs: span.runDurationMs };
    return [{ span: recorded, wrote: later.wrote, linked: later.linked }];
  });
}

/** The ids of `plan`'s records. */
export function idsOf(plan: readonly ForgeRunObjectRecords[]): string[] {
  return plan.flatMap((object) => object.ids);
}

/**
 * Of `plan`, the records `left` still names, by either length of their ids:
 * every one of them when `left` is undefined — no removal of the run said
 * what it left.
 */
export function stillLeft(
  plan: readonly ForgeRunObjectRecords[],
  left: readonly string[] | undefined,
): ForgeRunObjectRecords[] {
  if (left === undefined) return plan.map((object) => ({ ...object, ids: [...object.ids] }));
  const keys = new Set(left.map((id) => id.slice(0, 15)));
  return plan.flatMap((object) => {
    const ids = object.ids.filter((id) => keys.has(id.slice(0, 15)));
    return ids.length > 0 ? [{ objectApiName: object.objectApiName, ids }] : [];
  });
}
