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
  });
});
