/**
 * The strategies a bidirectional sync run settles a conflict with, in the
 * order the page offers them. `manual` is left out on purpose: see
 * `SyncConflictStrategy`.
 *
 * A list of its own, which the schema of a configuration is built from
 * (`syncConflictStrategySchema`): the Sync page offers these, and taking them
 * from the schema's module made the page parse zod, 94 kB, before it painted.
 */
export const SYNC_CONFLICT_STRATEGIES = [
  'source_wins',
  'target_wins',
  'newest_wins',
  'merge',
] as const;
