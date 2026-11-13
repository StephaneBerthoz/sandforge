import { describe, it, expect } from 'vitest';
import i18n from '../../i18n';
import { leftOutByReason, leftOutDetail, leftOutReasonLabel } from './forgeLeftOut';

describe('leftOutByReason', () => {
  it('groups the objects by why, what the target lacks first, each group by name', () => {
    const groups = leftOutByReason([
      { objectApiName: 'Order', reason: 'empty' },
      { objectApiName: 'AccountFeed', reason: 'chatter' },
      { objectApiName: 'Asset', reason: 'empty' },
      { objectApiName: 'Invoice__c', reason: 'missingInTarget' },
    ]);

    expect(groups.map((group) => group.reason)).toEqual(['missingInTarget', 'empty', 'chatter']);
    expect(groups[1].objects.map((object) => object.objectApiName)).toEqual(['Asset', 'Order']);
  });

  it('puts what the user left out first, and lists what only the platform creates', () => {
    const groups = leftOutByReason([
      { objectApiName: 'ProcessInstance', reason: 'platformCreated' },
      { objectApiName: 'Endpoints__c', reason: 'customSetting' },
      { objectApiName: 'Asset', reason: 'excludedByUser' },
    ]);

    expect(groups.map((group) => group.reason)).toEqual([
      'excludedByUser',
      'customSetting',
      'platformCreated',
    ]);
  });

  it('is empty of a graph that names none', () => {
    expect(leftOutByReason(undefined)).toEqual([]);
    expect(leftOutByReason([])).toEqual([]);
  });
});

describe('what the page says of an object left out', () => {
  const t = i18n.t.bind(i18n);

  it('names each reason in words', () => {
    expect(leftOutReasonLabel(t, 'notWritable')).toBe(
      'Not created, edited and deleted by you in the target org',
    );
    // An object the target creates is not said to be closed to the user.
    expect(leftOutReasonLabel(t, 'createOnly')).toMatch(
      /^Created by you in the target org, but not edited or deleted there/,
    );
    expect(
      leftOutByReason([
        { objectApiName: 'BusinessHours', reason: 'createOnly', detail: 'noDelete' },
        { objectApiName: 'AssetAction', reason: 'notWritable', detail: 'feature' },
        { objectApiName: 'Asset', reason: 'empty' },
      ]).map((group) => group.reason),
    ).toEqual(['notWritable', 'createOnly', 'empty']);
  });

  it('translates the two words it knows of a detail, and gives the org’s own as it said them', () => {
    expect(
      leftOutDetail(t, { objectApiName: 'UserRole', reason: 'setup', detail: 'noLayout' }),
    ).toBe('no page layout');
    expect(
      leftOutDetail(t, {
        objectApiName: 'ContentVersion',
        reason: 'files',
        detail: 'withTheirRecords',
      }),
    ).toBe('copied with the records it hangs on');
    expect(
      leftOutDetail(t, { objectApiName: 'Secret__c', reason: 'unreadable', detail: 'No access' }),
    ).toBe('No access');
    expect(leftOutDetail(t, { objectApiName: 'Asset', reason: 'empty' })).toBeUndefined();
    expect(
      leftOutDetail(t, { objectApiName: 'Quote', reason: 'notWritable', detail: 'feature' }),
    ).toBe('a feature the target has not turned on keeps it closed');
    expect(
      leftOutDetail(t, { objectApiName: 'Note', reason: 'notWritable', detail: 'parent' }),
    ).toBe('opened by the records it hangs from, if at all');
    expect(
      leftOutDetail(t, { objectApiName: 'AccountPartner', reason: 'createOnly', detail: 'noEdit' }),
    ).toBe('not edited by you');
    expect(
      leftOutDetail(t, {
        objectApiName: 'BusinessHours',
        reason: 'createOnly',
        detail: 'noDelete',
      }),
    ).toBe('not deleted by you');
    // A word of the org's that happens to name a property of every object is
    // still the org's word.
    expect(
      leftOutDetail(t, { objectApiName: 'X__c', reason: 'notDescribed', detail: 'constructor' }),
    ).toBe('constructor');
  });
});
