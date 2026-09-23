import { describe, it, expect } from 'vitest';
import type { SyncConfig } from '@sandforge/shared';
import { channelMembersOf, publishingObjects } from './publishingObjects';

/** What a sandbox answered, with no object selected in Setup. */
const MEMBER_ROWS = [
  { EventChannel: 'ActivityEngagementVirtualChannel', SelectedEntity: 'TaskChangeEvent' },
  { EventChannel: 'ActivityEngagementVirtualChannel', SelectedEntity: 'LeadChangeEvent' },
  { EventChannel: 'ActivityEngagementVirtualChannel', SelectedEntity: 'ContactChangeEvent' },
  { EventChannel: 'ChangeEvents', SelectedEntity: 'LeadChangeEvent' },
  { EventChannel: 'ChangeEvents', SelectedEntity: 'Invoice__ChangeEvent' },
  { EventChannel: 'ChangeEvents', SelectedEntity: 'NotAnEvent__e' },
];

function savedConfig(overrides: Partial<SyncConfig>): SyncConfig {
  return {
    id: 'cfg-1',
    name: 'Pair',
    description: '',
    sourceOrgId: 'org-source',
    targetOrgId: 'org-target',
    direction: 'source_to_target',
    mode: 'full',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as SyncConfig;
}

describe('channelMembersOf', () => {
  it('lists each object the org publishes once, with the channel it is on', () => {
    expect(channelMembersOf(MEMBER_ROWS)).toEqual([
      { objectApiName: 'Contact', channel: 'ActivityEngagementVirtualChannel' },
      { objectApiName: 'Invoice__c', channel: 'ChangeEvents' },
      { objectApiName: 'Lead', channel: 'ActivityEngagementVirtualChannel' },
      { objectApiName: 'Task', channel: 'ActivityEngagementVirtualChannel' },
    ]);
  });

  it('lists nothing for an org whose selection is empty', () => {
    expect(channelMembersOf([])).toEqual([]);
  });
});

describe('publishingObjects', () => {
  it('offers the external ids of the target and the saved configurations of the pair', async () => {
    const objects = await publishingObjects(
      [
        { objectApiName: 'Lead', channel: 'ChangeEvents' },
        { objectApiName: 'Invoice__c', channel: 'ChangeEvents' },
      ],
      async (objectApiName) => {
        if (objectApiName === 'Invoice__c') throw new Error('NOT_FOUND: Invoice__c');
        return {
          fields: [
            { name: 'Id' },
            { name: 'Legacy_Key__c', externalId: true },
            { name: 'Ext__c', externalId: true },
          ],
        };
      },
      [
        savedConfig({
          id: 'cfg-pair',
          name: 'Leads nightly',
          objects: [{ objectApiName: 'Lead' } as SyncConfig['objects'][number]],
        }),
        savedConfig({
          id: 'cfg-other',
          name: 'Elsewhere',
          targetOrgId: 'org-other',
          objects: [{ objectApiName: 'Lead' } as SyncConfig['objects'][number]],
        }),
      ],
      { sourceOrgId: 'org-source', targetOrgId: 'org-target' },
    );

    expect(objects).toEqual([
      {
        objectApiName: 'Lead',
        channel: 'ChangeEvents',
        inTarget: true,
        externalIdFields: ['Ext__c', 'Legacy_Key__c'],
        syncConfigs: [{ id: 'cfg-pair', name: 'Leads nightly' }],
      },
      {
        objectApiName: 'Invoice__c',
        channel: 'ChangeEvents',
        inTarget: false,
        externalIdFields: [],
        syncConfigs: [],
      },
    ]);
  });
});
