import type {
  ForgeRehearsal,
  ForgeRehearsalNotJudgedReason,
  ForgeRehearsalProgress,
} from '@sandforge/shared';
import { RehearsalWriter, type RehearsedRow, type RehearsedUpdate } from './RehearsalWriter.js';
import {
  ancestorsOf,
  familyOf,
  sampleOf,
  sampleOfUpdates,
  withTheirParents,
  type RowFamily,
} from './rehearsalSample.js';
import {
  COLLECTIONS_PER_CALL,
  compositeBody,
  planCalls,
  readCompositeAnswer,
  updateVerdictsOf,
  updatesRoomOf,
  verdictsOf,
  type CompositeRequestBody,
  type PlannedCall,
  type PlannedUpdate,
  type RowVerdict,
} from './compositeCalls.js';
import { rehearsalGaps, type RefusedRow } from './rehearsalGaps.js';

/** What a rehearsal is about to cost, put to the user before its first call. */
export interface RehearsalPlan {
  /** Rows the run would create. */
  rows: number;
  /**
   * Rows the rehearsal sends: the sample, the records its rows name, and the
   * records the updates it sends are of, or name.
   */
  sampled: number;
  /**
   * Per object, the updates the rehearsal sends of those the run makes after
   * its inserts, the most first: the target's automation runs on them too.
   */
  updates: Array<{ objectApiName: string; updates: number }>;
  /** Composite calls planned. */
  calls: number;
  /**
   * The most it sends: a call that stops at a refused row leaves the rows of
   * its later requests for another call.
   */
  maxCalls: number;
  /** Per object, the rows sent, the most first. */
  objects: Array<{ objectApiName: string; rows: number }>;
}

/** What a rehearsal needs: how to prepare the rows, ask the user, and reach the target. */
export interface RehearsalDeps {
  /**
   * Run the clone as the real run would, with `writer` in place of the
   * target's writers: every row it would create ends up in `writer.rows`, and
   * nothing reaches the target.
   */
  prepare: (writer: RehearsalWriter) => Promise<void>;
  /** The target's key prefix of an object, from the describe the run holds. */
  keyPrefixOf: (objectApiName: string) => Promise<string | null>;
  /** Send one composite request to the target, and resolve with its answer. */
  composite: (body: CompositeRequestBody) => Promise<unknown>;
  /** The target's REST API path, `/services/data/vXX.X`. */
  apiPath: string;
  /** The headers of a Forge write, sent with every Collections request. */
  writeHeaders: Readonly<Record<string, string>>;
  /** The target's record types, by the first 15 characters of their id, to their DeveloperName. */
  recordTypeNames?: ReadonlyMap<string, string>;
  /**
   * Put the plan to the user before the first call. What it throws stops the
   * rehearsal there, with nothing sent to the target.
   */
  confirm: (plan: RehearsalPlan) => Promise<void>;
  /** Told how far the rehearsal has got. */
  onProgress?: (progress: ForgeRehearsalProgress) => void;
  /**
   * Stops the rehearsal before its next call once aborted: each call is
   * rolled back whole, so stopping between two leaves nothing in the target.
   */
  signal?: AbortSignal;
}

/**
 * A call the target committed: the update that ends each call to roll it back
 * did not fail. The records the call created stay in the target, and the
 * rehearsal stops there.
 */
export class RehearsalNotRolledBackError extends Error {
  /**
   * @param ids - The records the call created, as its answer named them.
   * @param objects - How many of them each object holds, by the key prefix
   *   of their ids, for a trail that keeps counts and never an id.
   */
  constructor(
    readonly ids: readonly string[],
    readonly objects: ReadonlyArray<{ objectApiName: string; created: number }> = [],
  ) {
    super(
      `A rehearsal call was not rolled back: the ${ids.length} record(s) it created stay in the ` +
        `target (${ids.join(', ')}). The rehearsal stopped there; remove them from the target.`,
    );
    this.name = 'RehearsalNotRolledBackError';
  }
}

/** A rehearsal stopped by its signal before a call: each call it sent was rolled back whole. */
export class RehearsalCancelledError extends Error {
  /** @param calls - The calls sent before it stopped. */
  constructor(readonly calls: number) {
    super(
      calls > 0
        ? `The rehearsal was cancelled after ${calls} call(s), each rolled back whole: nothing ` +
            'stays in the target.'
        : 'The rehearsal was cancelled before its first call. Nothing was sent to the target.',
    );
    this.name = 'RehearsalCancelledError';
  }
}

/** Per object, how many of `ids` it holds, by the key prefix each row of `rows` gives its object. */
function objectsOfIds(
  ids: readonly string[],
  rows: Iterable<RehearsedRow>,
): Array<{ objectApiName: string; created: number }> {
  const objectOf = new Map<string, string>();
  for (const row of rows) objectOf.set(row.placeholderId.slice(0, 3), row.objectApiName);
  const counts = new Map<string, number>();
  for (const id of ids) {
    const object = objectOf.get(id.slice(0, 3)) ?? id.slice(0, 3);
    counts.set(object, (counts.get(object) ?? 0) + 1);
  }
  return [...counts].map(([objectApiName, created]) => ({ objectApiName, created }));
}

/** Per object, how many of `items` it holds, the most first. */
function countsPerObject(
  items: ReadonlyArray<{ objectApiName: string }>,
): Array<{ objectApiName: string; count: number }> {
  const counts = new Map<string, number>();
  for (const { objectApiName } of items) {
    counts.set(objectApiName, (counts.get(objectApiName) ?? 0) + 1);
  }
  return [...counts]
    .map(([objectApiName, count]) => ({ objectApiName, count }))
    .sort((a, b) => b.count - a.count || a.objectApiName.localeCompare(b.objectApiName));
}

/** An update a rehearsal can send, with the rows its call must create for it. */
interface SendableUpdate extends PlannedUpdate {
  /** The row of its record and every row its values name, by `seq`. */
  needs: number[];
}

/**
 * The update as a call sends it, with the rows it needs; undefined for one of
 * a record the target already held, which a rehearsal never writes: it
 * creates what it judges, and keeps none of it.
 */
function sendableOf(
  update: RehearsedUpdate,
  rowOf: (value: unknown) => RehearsedRow | undefined,
): SendableUpdate | undefined {
  const row = rowOf(update.recordId);
  if (!row) return undefined;
  const needs = new Set([row.seq]);
  for (const value of Object.values(update.fields)) {
    const named = rowOf(value);
    if (named) needs.add(named.seq);
  }
  return {
    seq: update.seq,
    objectApiName: update.objectApiName,
    rowSeq: row.seq,
    fields: update.fields,
    needs: [...needs],
  };
}

/**
 * The updates of `pending` a call can carry: those whose rows it creates, in
 * order, as many as its subrequests leave room for.
 */
function updatesFor(call: PlannedCall, pending: readonly SendableUpdate[]): SendableUpdate[] {
  const inCall = new Set(call.collections.flatMap((collection) => collection.seqs));
  return pending
    .filter((update) => update.needs.every((seq) => inCall.has(seq)))
    .slice(0, updatesRoomOf(call.collections.length));
}

/**
 * A call for updates no call of the rows carried — their rows went in
 * different calls, or a call stopped before them: the rows the first of
 * `pending` needs, with the records they name, then the rows of the next
 * while one call holds them all. The updates whose rows no call can hold are
 * given back apart.
 */
function updateCallOf(
  pending: readonly SendableUpdate[],
  family: RowFamily,
): { call?: PlannedCall; beyond: SendableUpdate[] } {
  const oneCall = (updates: readonly SendableUpdate[]): PlannedCall | undefined => {
    const rows = withTheirParents(
      updates.flatMap((update) =>
        update.needs.flatMap((seq) => {
          const row = family.bySeq.get(seq);
          return row ? [row] : [];
        }),
      ),
      family,
    );
    const plan = planCalls(rows, family);
    const [call] = plan.calls;
    return plan.calls.length === 1 &&
      plan.beyond.length === 0 &&
      call &&
      updates.length <= updatesRoomOf(call.collections.length)
      ? call
      : undefined;
  };
  const beyond: SendableUpdate[] = [];
  for (const [index, first] of pending.entries()) {
    let carried = [first];
    let call = oneCall(carried);
    if (!call) {
      beyond.push(first);
      continue;
    }
    for (const next of pending.slice(index + 1)) {
      const wider = oneCall([...carried, next]);
      if (!wider) continue;
      carried = [...carried, next];
      call = wider;
    }
    return { call, beyond };
  }
  return { beyond };
}

/**
 * The calls a rehearsal plans, every row and update passing: those of the
 * rows, each carrying the updates whose rows it creates, then those the
 * updates left over take.
 */
function plannedCallsOf(
  rowCalls: readonly PlannedCall[],
  updates: readonly SendableUpdate[],
  family: RowFamily,
): number {
  let pending = [...updates];
  /** Takes off `pending` the updates `call` carries; how many it did. */
  const carry = (call: PlannedCall): number => {
    const carried = new Set(updatesFor(call, pending));
    pending = pending.filter((update) => !carried.has(update));
    return carried.size;
  };
  for (const call of rowCalls) carry(call);
  let more = 0;
  while (pending.length > 0) {
    const { call, beyond } = updateCallOf(pending, family);
    const out = new Set(beyond);
    pending = pending.filter((update) => !out.has(update));
    if (!call || carry(call) === 0) break;
    more++;
  }
  return rowCalls.length + more;
}

/**
 * Rehearse a run: prepare its rows as the run would, pick a sample, put the
 * cost to the user, then create the sample in the target call by call, each
 * call rolled back whole, and read the platform's verdict on every row.
 *
 * A call stops at the first request that refuses a row; the rows of the
 * requests after it are sent again in the next call, with the records they
 * name — created again, rolled back again. A row whose parent was refused is
 * not judged: the refusal of its parent says nothing of its own.
 *
 * The updates the run makes after its inserts — a lookup a second pass fills
 * in, a status given back — go in the call that creates their record and the
 * records they name, after its inserts and before the step that rolls it
 * back, as the run makes them after its own; one whose rows no call of the
 * rows held together gets a call of its own. Counted and never sent, they
 * were the one write of a run no rehearsal judged: a rule that refuses an
 * order its activation, a flow that fails as a status comes back, met the
 * run alone.
 */
export async function rehearse(deps: RehearsalDeps): Promise<ForgeRehearsal> {
  const writer = new RehearsalWriter(deps.keyPrefixOf);
  await deps.prepare(writer);
  const rows = writer.rows;
  const rowOf = (value: unknown): RehearsedRow | undefined => writer.rowOf(value);
  const family = familyOf(rows, rowOf);
  const sample = sampleOf(rows);
  const updateSample = sampleOfUpdates(
    writer.updated.flatMap((update) => {
      const sendable = sendableOf(update, rowOf);
      return sendable ? [sendable] : [];
    }),
  );
  const updates = updateSample.updates;
  // The rows the updates sent are of, or name, are created to be updated.
  const toJudge = withTheirParents(
    [
      ...sample.rows,
      ...updates.flatMap((update) =>
        update.needs.flatMap((seq) => {
          const row = family.bySeq.get(seq);
          return row ? [row] : [];
        }),
      ),
    ],
    family,
  );
  const standsFor = (seq: number): number => sample.standsFor.get(seq) ?? 1;

  const verdicts = new Map<number, RowVerdict>();
  const notJudged = new Map<number, ForgeRehearsalNotJudgedReason>();
  const updateVerdicts = new Map<number, RowVerdict>();
  const updatesNotJudged = new Map<number, ForgeRehearsalNotJudgedReason>();
  const initial = planCalls(toJudge, family);
  for (const seq of initial.beyond) notJudged.set(seq, 'beyond_a_call');
  const plannedCalls = plannedCallsOf(initial.calls, updates, family);
  const maxCalls = plannedCalls * COLLECTIONS_PER_CALL;

  let calls = 0;
  if (plannedCalls > 0) {
    if (deps.signal?.aborted) throw new RehearsalCancelledError(0);
    deps.onProgress?.({ phase: 'confirming', calls: plannedCalls });
    await deps.confirm({
      rows: rows.length,
      sampled: toJudge.length,
      updates: countsPerObject(updates).map(({ objectApiName, count }) => ({
        objectApiName,
        updates: count,
      })),
      calls: plannedCalls,
      maxCalls,
      objects: countsPerObject(toJudge).map(({ objectApiName, count }) => ({
        objectApiName,
        rows: count,
      })),
    });
  }

  const refusedWithItsParents = (seq: number): boolean =>
    [seq, ...ancestorsOf(seq, family)].some((s) => verdicts.get(s)?.passed === false);
  /** Why an update can get no verdict: a row it needs was refused, or will get none. */
  const updateBlockedBy = (update: SendableUpdate): ForgeRehearsalNotJudgedReason | undefined => {
    for (const seq of update.needs) {
      if (refusedWithItsParents(seq)) return 'parent_refused';
      const reason = notJudged.get(seq);
      if (reason) return reason;
    }
    return undefined;
  };
  for (;;) {
    // Between two calls, each rolled back whole: stopping here leaves nothing.
    if (deps.signal?.aborted) throw new RehearsalCancelledError(calls);
    const judgeable = toJudge.filter((row) => {
      if (verdicts.has(row.seq) || notJudged.has(row.seq)) return false;
      if (!ancestorsOf(row.seq, family).some((seq) => verdicts.get(seq)?.passed === false)) {
        return true;
      }
      notJudged.set(row.seq, 'parent_refused');
      return false;
    });
    const updatesLeft = updates.filter((update) => {
      if (updateVerdicts.has(update.seq) || updatesNotJudged.has(update.seq)) return false;
      const blocked = updateBlockedBy(update);
      if (!blocked) return true;
      updatesNotJudged.set(update.seq, blocked);
      return false;
    });
    if (judgeable.length === 0 && updatesLeft.length === 0) break;
    if (calls >= maxCalls) {
      for (const row of judgeable) notJudged.set(row.seq, 'call_budget');
      for (const update of updatesLeft) updatesNotJudged.set(update.seq, 'call_budget');
      break;
    }
    let call: PlannedCall | undefined;
    if (judgeable.length > 0) {
      const plan = planCalls(judgeable, family);
      for (const seq of plan.beyond) notJudged.set(seq, 'beyond_a_call');
      call = plan.calls[0];
    } else {
      const planned = updateCallOf(updatesLeft, family);
      for (const update of planned.beyond) updatesNotJudged.set(update.seq, 'beyond_a_call');
      call = planned.call;
    }
    if (!call) continue;
    const carried = updatesFor(
      call,
      updatesLeft.filter((update) => !updatesNotJudged.has(update.seq)),
    );
    calls++;
    deps.onProgress?.({ phase: 'rehearsing', call: calls, calls: Math.max(plannedCalls, calls) });
    const body = compositeBody(call, family, rowOf, deps.apiPath, deps.writeHeaders, carried);
    const answer = readCompositeAnswer(await deps.composite(body), call, carried.length);
    if (answer.kind === 'not_rolled_back') {
      throw new RehearsalNotRolledBackError(answer.ids, objectsOfIds(answer.ids, rows));
    }
    // A row sent again as a parent takes the latest verdict: the one its
    // children were judged under.
    for (const [seq, verdict] of verdictsOf(call, answer.collections)) verdicts.set(seq, verdict);
    for (const [seq, verdict] of updateVerdictsOf(carried, answer)) {
      updateVerdicts.set(seq, verdict);
    }
  }

  const refused: RefusedRow[] = [];
  let passed = 0;
  for (const row of toJudge) {
    const verdict = verdicts.get(row.seq);
    if (!verdict) continue;
    if (verdict.passed) passed++;
    else refused.push({ row, errors: verdict.errors, standsFor: standsFor(row.seq) });
  }
  let updatesPassed = 0;
  /** The run's updates the judged ones stand for. */
  let updatesStoodFor = 0;
  for (const update of updates) {
    const verdict = updateVerdicts.get(update.seq);
    const row = family.bySeq.get(update.rowSeq);
    if (!verdict || !row) continue;
    const of = updateSample.standsFor.get(update.seq) ?? 1;
    updatesStoodFor += of;
    if (verdict.passed) {
      updatesPassed++;
      continue;
    }
    // Said of the record it updates, with what the update sets: a message
    // that quotes a value of either has it taken out.
    refused.push({
      row: { ...row, fields: { ...row.fields, ...update.fields } },
      errors: verdict.errors,
      standsFor: of,
      onUpdate: true,
    });
  }
  const why = new Map<string, number>();
  for (const [seq, reason] of notJudged) {
    const object = family.bySeq.get(seq)?.objectApiName ?? '';
    const key = `${object}|${reason}`;
    why.set(key, (why.get(key) ?? 0) + 1);
  }
  return {
    gaps: rehearsalGaps(refused, deps.recordTypeNames),
    rows: rows.length,
    sampled: toJudge.length,
    judged: verdicts.size,
    passed,
    notJudged: notJudged.size,
    notJudgedWhy: [...why].map(([key, count]) => {
      const [objectApiName, reason] = key.split('|') as [string, ForgeRehearsalNotJudgedReason];
      return { objectApiName, rows: count, reason };
    }),
    updates: writer.updates,
    updatesJudged: updateVerdicts.size,
    updatesPassed,
    updatesNotRehearsed: writer.updates - updatesStoodFor,
    calls,
    plannedCalls,
  };
}
