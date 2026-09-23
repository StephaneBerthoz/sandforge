import type { EnrichedDiff } from '@sandforge/shared';
import type { BadgeVariant } from '../../components/ui/Badge';

/** A difference between the two orgs, in DiffEngine's terms. */
export type ChangeKind = EnrichedDiff['changeType'];

/** How one kind of difference is drawn: its badge, its symbol and the class of the symbol. */
export interface ChangeLook {
  readonly variant: BadgeVariant;
  readonly symbol: string;
  readonly textClass: string;
}

/**
 * Each kind of difference as a deployment from the source to the target reads it.
 *
 * `removed` is a component only the source holds: a deployment creates it in
 * the target, so it is drawn as an addition. `added` is one only the target
 * holds: a deployment leaves it, and taking it out to match the source is the
 * destructive change the risk card weighs heaviest, so it is drawn as a
 * removal. The diff views drew them after the codes' names, the other way
 * round: what a deployment would create was red, under a minus.
 */
export const CHANGE_LOOK: Readonly<Record<ChangeKind, ChangeLook>> = {
  removed: { variant: 'success', symbol: '+', textClass: 'text-status-success' },
  added: { variant: 'error', symbol: '-', textClass: 'text-status-error' },
  modified: { variant: 'warning', symbol: '~', textClass: 'text-status-warning' },
};

/** The order the kinds are counted in: what a deployment creates, leaves, then replaces. */
export const CHANGE_ORDER: readonly ChangeKind[] = ['removed', 'added', 'modified'];
