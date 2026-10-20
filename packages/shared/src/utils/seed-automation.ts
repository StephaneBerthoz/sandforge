import type { ForgeEmailLimit } from '../types/forge.types.js';
import type { SeedAutomationPreview, SeedEmailEstimate } from '../types/seed.types.js';

/**
 * The emails a seed's records make an org send, per daily limit, against what
 * the org has left today: the emails one record of each object sends, as the
 * read of the org's automation gave them, times the records the seed creates
 * of it. An object of no record sends nothing, and a limit nothing sends
 * against is left out.
 *
 * The confirmation counts them as the user changes a count, without reading
 * the org again; the seed's gate in the extension counts them the same way
 * from the same read before the first record is written, and refuses past
 * what is left.
 *
 * @param records - The records the seed creates, by object.
 */
export function seedEmailEstimates(
  preview: Pick<SeedAutomationPreview, 'emailsPerRecord' | 'limits' | 'limitsUnread'>,
  records: Readonly<Record<string, number>>,
): SeedEmailEstimate[] {
  const byLimit = new Map<ForgeEmailLimit, SeedEmailEstimate>();
  for (const sending of preview.emailsPerRecord) {
    const created = records[sending.objectApiName] ?? 0;
    if (created <= 0 || sending.perRecord <= 0) continue;
    const estimate = byLimit.get(sending.limit) ?? {
      limit: sending.limit,
      emails: 0,
      objects: [],
      verdict: 'unread' as const,
    };
    estimate.objects.push({
      objectApiName: sending.objectApiName,
      records: created,
      perRecord: sending.perRecord,
      sentBy: [...sending.sentBy],
    });
    estimate.emails += created * sending.perRecord;
    byLimit.set(sending.limit, estimate);
  }
  return [...byLimit.values()].map((estimate): SeedEmailEstimate => {
    const limit = preview.limitsUnread === undefined ? preview.limits?.[estimate.limit] : undefined;
    if (!limit) return { ...estimate, verdict: 'unread' };
    return {
      ...estimate,
      verdict: estimate.emails > limit.remaining ? 'exceeds' : 'fits',
      remaining: limit.remaining,
      max: limit.max,
    };
  });
}

/** Whether a seed's records would take an org past what it has left today of a daily email limit. */
export function seedEmailsRefused(estimates: readonly SeedEmailEstimate[]): boolean {
  return estimates.some((estimate) => estimate.verdict === 'exceeds');
}
