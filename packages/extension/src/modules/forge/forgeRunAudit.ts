/**
 * What a Forge run's entry in the audit trail says of how the run was set up
 * and let through, beside what it wrote (`AuditRunContext`).
 *
 * The entry used to keep what the run did per object, the orgs, the outcome
 * and Production Guard's decision. A reader of the trail asking of a clone
 * into a sandbox whether it anonymized, whether anyone looked at it before it
 * went, what fired as it inserted and what the user said yes to found none of
 * it: those were the page's and the run's, and gone once the panel closed.
 * Words and counts only, as the rest of the entry: never a value of a record,
 * the name of a flow, or what a decision maps from or to.
 *
 * Kept apart from the handler, which records the run, so each answer is built
 * and tested in one place.
 */

import type {
  AuditConfirmation,
  AuditDecisionCount,
  AuditFiredOnInsert,
  AuditRunContext,
  ForgeConfig,
  ForgeDecisionApplied,
  ForgeGapDecisionKind,
  ForgeGraph,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import { automationUnreadOf, firedOnInsertOf } from './ForgeRunGate.js';

/**
 * How long a simulation or a rehearsal stands as one that came before a run of
 * the same case. Simulate, read the gaps, decide each, run: the decisions take
 * minutes, and the run of an hour later is another sitting.
 */
export const TRIED_WITHIN_MS = 30 * 60_000;

/** The cases whose last simulation and rehearsal are kept: the oldest go first. */
const CASES_KEPT = 16;

/** The order a run's decisions are listed in: the order the Gaps tab offers them. */
const DECISION_ORDER: readonly ForgeGapDecisionKind[] = [
  'map_value',
  'leave_empty',
  'set_default',
  'truncate',
  'map_record_type',
  'exclude_object',
  'skip_rows',
  'ignore',
];

/**
 * What tells one case from another: the orgs, the input — the record, the
 * query, the template, the prompt — and the objects discovery found, whether
 * the run writes each or not.
 *
 * The decisions are left out of it, and so are the objects left out since:
 * simulating, then deciding what the simulation found, is how a run is meant
 * to be prepared, and the run that follows is the one the simulation was of.
 * Another depth, or a discovery of another record, finds another graph: that
 * is another case.
 */
export function forgeCaseKey(graph: Pick<ForgeGraph, 'nodes'>, config: ForgeConfig): string {
  return JSON.stringify([
    config.sourceOrgId,
    config.targetOrgId,
    config.inputMode,
    config.recordId ?? null,
    config.soqlQuery ?? null,
    config.templateId ?? null,
    config.aiPrompt ?? null,
    graph.nodes.map((node) => node.objectApiName).sort(),
  ]);
}

/** When a case was last simulated and rehearsed, in epoch milliseconds. */
interface Tried {
  simulation?: number;
  rehearsal?: number;
}

/**
 * The simulations and rehearsals this window ended lately, by case, for the
 * entry of the run that follows them. Bounded: a case not tried again drops
 * out once {@link CASES_KEPT} others were, and a try older than
 * {@link TRIED_WITHIN_MS} counts for nothing.
 */
export class RecentTrials {
  private readonly tried = new Map<string, Tried>();

  /** A simulation or a rehearsal of the case `key` ended at `at`. */
  note(kind: keyof Tried, key: string, at: number = Date.now()): void {
    const kept = this.tried.get(key) ?? {};
    this.tried.delete(key);
    this.tried.set(key, { ...kept, [kind]: at });
    for (const oldest of this.tried.keys()) {
      if (this.tried.size <= CASES_KEPT) break;
      this.tried.delete(oldest);
    }
  }

  /**
   * The minutes since the case's last simulation and rehearsal, each when it
   * ended within {@link TRIED_WITHIN_MS} of `now`. Rounded up, so a try a few
   * seconds before reads as a minute before rather than none.
   */
  before(
    key: string,
    now: number = Date.now(),
  ): Pick<AuditRunContext, 'simulatedMinutesBefore' | 'rehearsedMinutesBefore'> {
    const kept = this.tried.get(key);
    const minutes = (at: number | undefined): number | undefined =>
      at === undefined || now - at > TRIED_WITHIN_MS || now < at
        ? undefined
        : Math.max(1, Math.ceil((now - at) / 60_000));
    const simulated = minutes(kept?.simulation);
    const rehearsed = minutes(kept?.rehearsal);
    return {
      ...(simulated !== undefined ? { simulatedMinutesBefore: simulated } : {}),
      ...(rehearsed !== undefined ? { rehearsedMinutesBefore: rehearsed } : {}),
    };
  }
}

/**
 * What fires as the run inserts, by kind, as the gate put it to the user: from
 * the read of the target's automation the run went with, or none of it when
 * that read failed, which the gate says and asks about.
 */
export function firedOnInsertCounts(
  read: { automation: ForgeTargetAutomation } | { unread: string },
): AuditFiredOnInsert {
  const counts: AuditFiredOnInsert = {
    flow: 0,
    trigger: 0,
    process: 0,
    workflowRule: 0,
    unread: [],
  };
  if (!('automation' in read)) return { ...counts, unread: ['automation'] };
  for (const fired of firedOnInsertOf(read.automation)) counts[fired.kind]++;
  counts.unread = automationUnreadOf(read.automation).map((u) => u.part);
  return counts;
}

/**
 * The decisions a run's config holds, kind by kind, with the rows those the run
 * applied changed. A picklist value mapped to none and a field left out are
 * both left empty; a kind the config does not hold is not listed.
 *
 * @param config - The run's config.
 * @param applied - What the run said it applied, when it got that far.
 */
export function decisionCounts(
  config: ForgeConfig,
  applied: readonly ForgeDecisionApplied[] = [],
): AuditDecisionCount[] {
  const count = new Map<ForgeGapDecisionKind, number>();
  const add = (kind: ForgeGapDecisionKind, n: number): void => {
    if (n > 0) count.set(kind, (count.get(kind) ?? 0) + n);
  };
  const mappings = config.picklistValueMappings ?? [];
  add('map_value', mappings.filter((m) => m.to !== null).length);
  add('leave_empty', mappings.filter((m) => m.to === null).length);
  add(
    'leave_empty',
    Object.values(config.fieldExclusions ?? {}).reduce((sum, fields) => sum + fields.length, 0),
  );
  add('set_default', config.defaultValues?.length ?? 0);
  add('truncate', config.truncateFields?.length ?? 0);
  add('map_record_type', config.recordTypeMappings?.length ?? 0);
  add('exclude_object', config.excludedObjects?.length ?? 0);
  add('ignore', config.ignoredGaps?.length ?? 0);
  const rows = new Map<ForgeGapDecisionKind, number>();
  for (const decision of applied) {
    rows.set(decision.kind, (rows.get(decision.kind) ?? 0) + decision.rows);
  }
  return DECISION_ORDER.filter((kind) => count.has(kind) || rows.has(kind)).map((kind) => ({
    kind,
    count: count.get(kind) ?? 0,
    ...(rows.has(kind) ? { rows: rows.get(kind) } : {}),
  }));
}

/**
 * The context of one run's entry, filled in as the run meets its gate and
 * built for each entry the run records: one stopped at its first check knows
 * its config and what came before it, one that ran knows what fired, what was
 * confirmed and the rows its decisions changed.
 */
export class ForgeRunAudit {
  private readonly confirmed: AuditConfirmation[] = [];
  private fired?: AuditFiredOnInsert;

  /**
   * @param config - The run's config, as the request sent it.
   * @param before - Whether Review was skipped, and the simulation and
   *   rehearsal of the case that came before the run.
   */
  constructor(
    private readonly config: ForgeConfig,
    private readonly before: Pick<
      AuditRunContext,
      'reviewSkipped' | 'simulatedMinutesBefore' | 'rehearsedMinutesBefore'
    >,
  ) {}

  /** What fires as the run inserts, as the gate is about to put it to the user. */
  automationRead(read: { automation: ForgeTargetAutomation } | { unread: string }): void {
    this.fired = firedOnInsertCounts(read);
  }

  /** A person answered a question of the run's gate by going on. */
  confirm(question: AuditConfirmation): void {
    if (!this.confirmed.includes(question)) this.confirmed.push(question);
  }

  /**
   * The context, as the entry recorded now says it.
   *
   * @param applied - The decisions the run applied, when it reported them.
   */
  context(applied?: readonly ForgeDecisionApplied[]): AuditRunContext {
    const decisions = decisionCounts(this.config, applied);
    return {
      anonymized: this.config.anonymizePII,
      contactPoints: this.config.keepContactPoints === true ? 'kept' : 'neutralized',
      ...this.before,
      ...(this.fired ? { firedOnInsert: { ...this.fired, unread: [...this.fired.unread] } } : {}),
      ...(this.confirmed.length > 0 ? { confirmed: [...this.confirmed] } : {}),
      ...(decisions.length > 0 ? { decisions } : {}),
    };
  }
}
