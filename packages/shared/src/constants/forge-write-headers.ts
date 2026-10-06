/**
 * The headers Forge sends with every record it creates or writes again in the
 * target, the wizard's run and the clone command's alike — and, through
 * `recordWriteHeaders`, every other module's REST writes.
 *
 * Two of the target's rules would otherwise act on what a clone writes:
 * - its duplicate rules, which a clone matches by construction — see
 *   `duplicate-rules.ts`;
 * - its assignment rules. Forge sets each record's owner itself, from the
 *   source or an owner mapping, and writes through REST, where a request that
 *   does not say `Sforce-Auto-Assign` has the target apply its active
 *   assignment rules: the Cases, Leads and Accounts a clone created went to
 *   whoever the rules routed them to, and the new owner could be mailed.
 *   `FALSE` keeps the owner the run set; applying the rules is a choice the
 *   run makes (`ForgeConfig.applyAssignmentRules`, `--apply-assignment-rules`).
 */
import { ALLOW_DUPLICATE_RULE_HEADER } from './duplicate-rules.js';

/** The REST header that says whether the target applies its assignment rules. */
export const AUTO_ASSIGN_HEADER = 'Sforce-Auto-Assign';

/** What a run asks of the target's rules as it writes. */
export interface ForgeWriteOptions {
  /** Whether the target's active assignment rules apply to the records the run writes. */
  applyAssignmentRules: boolean;
}

/**
 * The headers of a Forge write: duplicate rules waived, and the target's
 * assignment rules applied only when the run asks for them.
 */
export function forgeWriteHeaders(options: ForgeWriteOptions): Record<string, string> {
  return {
    ...ALLOW_DUPLICATE_RULE_HEADER,
    [AUTO_ASSIGN_HEADER]: options.applyAssignmentRules ? 'TRUE' : 'FALSE',
  };
}

/**
 * The headers of a record any other module creates or writes again over
 * REST — Seed, its record clone and CSV import, Sync and the real-time sync,
 * a Frozen dataset load, DataOps' masking, restore and removal edits,
 * Autopilot: duplicate rules waived, and the target's assignment rules off.
 *
 * None of them offers the choice Forge does. Each writes the owner it was
 * given, or leaves it to the running user, and a create or an update that
 * does not say `Sforce-Auto-Assign` had the target's rules reassign the Cases,
 * Leads and Accounts it wrote, and mail the new owners.
 *
 * Bulk API 2.0 needs no header: a job runs an assignment rule only when it
 * names one (`assignmentRuleId`), and no job these modules open does.
 */
export function recordWriteHeaders(): Record<string, string> {
  return forgeWriteHeaders({ applyAssignmentRules: false });
}
