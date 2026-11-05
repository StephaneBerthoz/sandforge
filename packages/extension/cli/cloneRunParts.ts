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
import type {
  ForgeRemovalSpan,
  ForgeRunObjectRecords,
  ForgeUndoObjectResult,
} from '@sandforge/shared';
import type { ForgeRunJournal } from '../src/modules/forge/ForgeRunJournal.js';
import type {
  RemovalPreviewObject,
  RunLaterPart,
  RunPartAlongside,
} from '../src/modules/forge/ForgeRunRemoval.js';

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
}

/** What the lines of a journal say of each part, beside its records: see {@link RunPart}. */
interface PartLines {
  startedAt?: string;
  endedAt?: string;
  wrote: string[];
}

/**
 * Read, line by line, the parts of the journal at `path`: when each began and
 * ended, and what its second pass wrote to (`["p", id, field]`, a lookup
 * filled in; `["g", object, id]`, a status given). A line that does not read
 * is passed over, as the journal's own reader passes it.
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
    });
  }
  return parts;
}

/**
 * A part's span as this machine's clock dated it, for a removal to read on
 * the org's (`runRecordedAt`, `runDurationMs`): its end, right after its last
 * write, and how long it ran. Undefined when its lines say no end.
 */
export function machineSpanOf(part: RunPart): RunPartAlongside['span'] | undefined {
  const ended = Date.parse(part.endedAt ?? '');
  if (!Number.isFinite(ended)) return undefined;
  const began = Date.parse(part.startedAt ?? '');
  return {
    runRecordedAt: new Date(ended),
    runDurationMs: Number.isFinite(began) && began <= ended ? ended - began : 0,
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
    return span ? [{ span, wrote: later.wrote, linked: later.linked }] : [];
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

/** The removal spans of every list, each once, in the order they ran. */
export function spansOf(
  ...lists: ReadonlyArray<readonly ForgeRemovalSpan[] | undefined>
): ForgeRemovalSpan[] {
  const seen = new Set<string>();
  const spans: ForgeRemovalSpan[] = [];
  for (const span of lists.flatMap((list) => list ?? [])) {
    const key = `${span.first}|${span.last}|${span.userId.slice(0, 15)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push(span);
  }
  return spans.sort((a, b) => Date.parse(a.first) - Date.parse(b.first));
}

/** How many reasons an object's result says at most, as a removal says them. */
const REASONS_KEPT = 5;

/** `a` and `b` as one list, each once, `limit` at most. */
function bothOf(a: readonly string[], b: readonly string[], limit = Infinity): string[] {
  return [...new Set([...a, ...b])].slice(0, limit);
}

/** `a` plus `b`, absent when both are. */
function sumOf(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * The results of removals of several parts of a run made one after the
 * other, object by object, as one removal says them: an object two of them
 * took records of is counted once, with both counts, in the order the
 * removals first named it.
 */
export function mergedUndoObjects(
  ...lists: ReadonlyArray<readonly ForgeUndoObjectResult[]>
): ForgeUndoObjectResult[] {
  const merged = new Map<string, ForgeUndoObjectResult>();
  for (const object of lists.flat()) {
    const was = merged.get(object.objectApiName);
    if (!was) {
      merged.set(object.objectApiName, { ...object });
      continue;
    }
    const optional = {
      notVisible: sumOf(was.notVisible, object.notVisible),
      notReached: sumOf(was.notReached, object.notReached),
      heldByAutomation: sumOf(was.heldByAutomation, object.heldByAutomation),
      platformCopies: sumOf(was.platformCopies, object.platformCopies),
    };
    const holders = bothOf(was.automationHolders ?? [], object.automationHolders ?? []);
    const files =
      was.filesLeft || object.filesLeft
        ? {
            count: (was.filesLeft?.count ?? 0) + (object.filesLeft?.count ?? 0),
            names: bothOf(was.filesLeft?.names ?? [], object.filesLeft?.names ?? [], REASONS_KEPT),
          }
        : undefined;
    merged.set(object.objectApiName, {
      objectApiName: object.objectApiName,
      planned: was.planned + object.planned,
      deleted: was.deleted + object.deleted,
      alreadyGone: was.alreadyGone + object.alreadyGone,
      keptChanged: was.keptChanged + object.keptChanged,
      keptDependents: was.keptDependents + object.keptDependents,
      refused: was.refused + object.refused,
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
      heldBy: bothOf(was.heldBy, object.heldBy),
      ...(holders.length > 0 ? { automationHolders: holders } : {}),
      unchecked: bothOf(was.unchecked, object.unchecked),
      reasons: bothOf(was.reasons, object.reasons, REASONS_KEPT),
      ...(files ? { filesLeft: files } : {}),
    });
  }
  return [...merged.values()];
}

/** What the previews of several parts of a run say, object by object, as one preview says it. */
export function mergedPreviewObjects(
  ...lists: ReadonlyArray<readonly RemovalPreviewObject[]>
): RemovalPreviewObject[] {
  const merged = new Map<string, RemovalPreviewObject>();
  for (const object of lists.flat()) {
    const was = merged.get(object.objectApiName);
    if (!was) {
      merged.set(object.objectApiName, { ...object, changedBy: { ...object.changedBy } });
      continue;
    }
    const changedBy = { ...was.changedBy };
    for (const [user, count] of Object.entries(object.changedBy)) {
      changedBy[user] = (changedBy[user] ?? 0) + count;
    }
    const copies = sumOf(was.platformCopies, object.platformCopies);
    merged.set(object.objectApiName, {
      objectApiName: object.objectApiName,
      planned: was.planned + object.planned,
      toDelete: was.toDelete + object.toDelete,
      alreadyGone: was.alreadyGone + object.alreadyGone,
      changedSince: was.changedSince + object.changedSince,
      keptChanged: was.keptChanged + object.keptChanged,
      changedBy,
      undeletable: was.undeletable + object.undeletable,
      notVisible: was.notVisible + object.notVisible,
      unread: was.unread + object.unread,
      ...(copies !== undefined ? { platformCopies: copies } : {}),
      reasons: bothOf(was.reasons, object.reasons, REASONS_KEPT),
    });
  }
  return [...merged.values()];
}
