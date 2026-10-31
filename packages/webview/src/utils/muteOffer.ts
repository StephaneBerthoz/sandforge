import type { MutePlan } from '@sandforge/shared';

/**
 * What a page can say of a mute before its run: the plan made from the read
 * of the target's automation the page shows (`mutePlanOf`), or `'atStart'`
 * where the page reads none — the run's gate reads it as the run starts, asks
 * only about what still runs, and the result says what was muted.
 *
 * Kept apart from the box that shows it (`AutomationMuteBox`), which holds
 * the words: a part that plans the offer and lets its owner draw the box
 * loads none of them.
 */
export type MuteOffer = MutePlan | 'atStart';

/** Whether `offer` says anything a box can offer: something the bypass silences, or a read at the run's start. */
export function muteOffered(offer: MuteOffer | null | undefined): boolean {
  return offer === 'atStart' || (offer != null && offer.silenced.length > 0);
}
