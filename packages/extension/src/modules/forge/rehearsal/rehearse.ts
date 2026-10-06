import type {
  ForgeRehearsal,
  ForgeRehearsalNotJudgedReason,
  ForgeRehearsalProgress,
} from '@sandforge/shared';
import type { SaveErrorDetail } from '../../../core/common/existingRecordMatch.js';
import { RehearsalWriter, type RehearsedRow } from './RehearsalWriter.js';
import { ancestorsOf, familyOf, sampleOf, withTheirParents } from './rehearsalSample.js';
import {
  COLLECTIONS_PER_CALL,
  compositeBody,
  planCalls,
  readCompositeAnswer,
  verdictsOf,
  type CompositeRequestBody,
} from './compositeCalls.js';
import { rehearsalGaps, type RefusedRow } from './rehearsalGaps.js';

/** What a rehearsal is about to cost, put to the user before its first call. */
export interface RehearsalPlan {
  /** Rows the run would create. */
  rows: number;
  /** Rows the rehearsal sends: the sample and the records its rows name. */
  sampled: number;
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
}

/**
 * A call the target committed: the update that ends each call to roll it back
 * did not fail. The records the call created stay in the target, and the
 * rehearsal stops there.
 */
export class RehearsalNotRolledBackError extends Error {
  constructor(readonly ids: readonly string[]) {
    super(
      `A rehearsal call was not rolled back: the ${ids.length} record(s) it created stay in the ` +
        `target (${ids.join(', ')}). The rehearsal stopped there; remove them from the target.`,
    );
    this.name = 'RehearsalNotRolledBackError';
  }
}

/** Per object, how many of `rows` it holds, the most first. */
function perObject(rows: readonly RehearsedRow[]): Array<{ objectApiName: string; rows: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.objectApiName, (counts.get(row.objectApiName) ?? 0) + 1);
  return [...counts]
    .map(([objectApiName, count]) => ({ objectApiName, rows: count }))
    .sort((a, b) => b.rows - a.rows || a.objectApiName.localeCompare(b.objectApiName));
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
 */
export async function rehearse(deps: RehearsalDeps): Promise<ForgeRehearsal> {
  const writer = new RehearsalWriter(deps.keyPrefixOf);
  await deps.prepare(writer);
  const rows = writer.rows;
  const family = familyOf(rows, (value) => writer.rowOf(value));
  const sample = sampleOf(rows);
  const toJudge = withTheirParents(sample.rows, family);
  const standsFor = (seq: number): number => sample.standsFor.get(seq) ?? 1;

  const verdicts = new Map<
    number,
    { passed: true } | { passed: false; errors: SaveErrorDetail[] }
  >();
  const notJudged = new Map<number, ForgeRehearsalNotJudgedReason>();
  const initial = planCalls(toJudge, family);
  for (const seq of initial.beyond) notJudged.set(seq, 'beyond_a_call');
  const plannedCalls = initial.calls.length;
  const maxCalls = plannedCalls * COLLECTIONS_PER_CALL;

  let calls = 0;
  if (plannedCalls > 0) {
    deps.onProgress?.({ phase: 'confirming', calls: plannedCalls });
    await deps.confirm({
      rows: rows.length,
      sampled: toJudge.length,
      calls: plannedCalls,
      maxCalls,
      objects: perObject(toJudge),
    });
  }

  const pending = (): RehearsedRow[] =>
    toJudge.filter((row) => !verdicts.has(row.seq) && !notJudged.has(row.seq));
  for (let left = pending(); left.length > 0; left = pending()) {
    const refusedParent = (row: RehearsedRow): boolean =>
      ancestorsOf(row.seq, family).some((seq) => verdicts.get(seq)?.passed === false);
    const judgeable = left.filter((row) => {
      if (!refusedParent(row)) return true;
      notJudged.set(row.seq, 'parent_refused');
      return false;
    });
    if (judgeable.length === 0) break;
    if (calls >= maxCalls) {
      for (const row of judgeable) notJudged.set(row.seq, 'call_budget');
      break;
    }
    const plan = planCalls(judgeable, family);
    for (const seq of plan.beyond) notJudged.set(seq, 'beyond_a_call');
    const call = plan.calls[0];
    if (!call) continue;
    calls++;
    deps.onProgress?.({ phase: 'rehearsing', call: calls, calls: Math.max(plannedCalls, calls) });
    const body = compositeBody(
      call,
      family,
      (value) => writer.rowOf(value),
      deps.apiPath,
      deps.writeHeaders,
    );
    const answer = readCompositeAnswer(await deps.composite(body), call);
    if (answer.kind === 'not_rolled_back') throw new RehearsalNotRolledBackError(answer.ids);
    // A row sent again as a parent takes the latest verdict: the one its
    // children were judged under.
    for (const [seq, verdict] of verdictsOf(call, answer.collections)) verdicts.set(seq, verdict);
  }

  const refused: RefusedRow[] = [];
  let passed = 0;
  for (const row of toJudge) {
    const verdict = verdicts.get(row.seq);
    if (!verdict) continue;
    if (verdict.passed) passed++;
    else refused.push({ row, errors: verdict.errors, standsFor: standsFor(row.seq) });
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
    updatesNotRehearsed: writer.updates,
    calls,
    plannedCalls,
  };
}
