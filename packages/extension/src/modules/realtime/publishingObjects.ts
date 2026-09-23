import type { RealTimePublishingObject, SyncConfig } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { objectOfChangeEntity } from './changeEvent.js';

/**
 * The Tooling query that says which objects publish change events, and on
 * which channel.
 *
 * On a sandbox where nobody had selected an object in Setup → Change Data
 * Capture, it still answered six members — Task, Lead, Contact, EmailMessage,
 * ListEmail, ListEmailSentResult — all on `ActivityEngagementVirtualChannel`, a
 * channel the platform manages for its activity features. Their per-object
 * channels delivered every change; `/data/ChangeEvents`, which carries only
 * what Setup selects, accepted the subscription and delivered nothing.
 */
export const CHANNEL_MEMBERS_QUERY =
  'SELECT EventChannel, SelectedEntity FROM PlatformEventChannelMember';

/** An object the source org publishes change events for. */
export interface ChannelMember {
  objectApiName: string;
  channel: string;
}

/**
 * The objects a `PlatformEventChannelMember` answer lists, each once, with the
 * channel it is listed on (the first one, when it is on several).
 *
 * @param rows - Records of {@link CHANNEL_MEMBERS_QUERY}.
 */
export function channelMembersOf(rows: ReadonlyArray<Record<string, unknown>>): ChannelMember[] {
  const members = new Map<string, ChannelMember>();
  for (const row of rows) {
    const entity = typeof row['SelectedEntity'] === 'string' ? row['SelectedEntity'] : '';
    const objectApiName = objectOfChangeEntity(entity);
    if (!objectApiName || members.has(objectApiName)) continue;
    const channel = typeof row['EventChannel'] === 'string' ? row['EventChannel'] : '';
    members.set(objectApiName, { objectApiName, channel });
  }
  return [...members.values()].sort((a, b) => a.objectApiName.localeCompare(b.objectApiName));
}

/** One field of a target describe, as far as the key choice reads it. */
interface KeyField {
  name: string;
  externalId?: boolean;
}

/**
 * What the page offers for each publishing object: whether the target has it,
 * the external ids a change can be matched on there, and the saved Sync
 * configurations between the two orgs that carry it.
 *
 * @param members - The objects the source publishes.
 * @param describeTarget - Describes an object in the target org.
 * @param savedConfigs - Every saved Sync configuration.
 * @param orgs - The pair the session would run between.
 */
export async function publishingObjects(
  members: readonly ChannelMember[],
  describeTarget: (objectApiName: string) => Promise<{ fields: readonly KeyField[] }>,
  savedConfigs: readonly SyncConfig[],
  orgs: { sourceOrgId: string; targetOrgId: string },
  log: (message: string) => void = () => {},
): Promise<RealTimePublishingObject[]> {
  const pairConfigs = savedConfigs.filter(
    (c) => c.sourceOrgId === orgs.sourceOrgId && c.targetOrgId === orgs.targetOrgId,
  );
  return Promise.all(
    members.map(async ({ objectApiName, channel }) => {
      let inTarget = true;
      let externalIdFields: string[] = [];
      try {
        const described = await describeTarget(objectApiName);
        externalIdFields = described.fields
          .filter((f) => f.externalId === true)
          .map((f) => f.name)
          .sort();
      } catch (err: unknown) {
        inTarget = false;
        log(
          `[realtime] ${objectApiName} could not be described in the target: ${extractErrorMessage(err)}`,
        );
      }
      return {
        objectApiName,
        channel,
        inTarget,
        externalIdFields,
        syncConfigs: pairConfigs
          .filter((c) => c.objects.some((o) => o.objectApiName === objectApiName))
          .map((c) => ({ id: c.id, name: c.name })),
      };
    }),
  );
}
