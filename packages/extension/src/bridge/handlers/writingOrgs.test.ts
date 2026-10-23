import { describe, expect, it } from 'vitest';

import { payloadText, WritingOrgs } from './writingOrgs.js';

describe('WritingOrgs', () => {
  it('holds an org as written to while a run of it is under way, and no longer once it settled', async () => {
    const writing = new WritingOrgs();
    let finish: () => void = () => {};
    const run = writing.during(
      'org-a',
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve('done');
        }),
    );

    expect(writing.has('org-a')).toBe(true);
    expect(writing.has('org-b')).toBe(false);
    finish();
    await expect(run).resolves.toBe('done');
    expect(writing.has('org-a')).toBe(false);
  });

  it('lets an org go when its run throws, and holds it while another run of it is still under way', async () => {
    const writing = new WritingOrgs();
    let finishSecond: () => void = () => {};
    const second = writing.during(
      'org-a',
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        }),
    );
    await expect(
      writing.during('org-a', () => Promise.reject(new Error('the load failed'))),
    ).rejects.toThrow('the load failed');

    expect(writing.has('org-a')).toBe(true);
    finishSecond();
    await second;
    expect(writing.has('org-a')).toBe(false);
  });

  it('holds nothing for a run that names no org', async () => {
    const writing = new WritingOrgs();
    let seen: boolean | undefined;
    await writing.during(undefined, () => {
      seen = writing.has('');
      return Promise.resolve();
    });
    expect(seen).toBe(false);
  });
});

describe('payloadText', () => {
  it('reads the text a payload holds under a field, and nothing of anything else', () => {
    expect(payloadText({ payload: { targetOrgId: 'org-a' } }, 'targetOrgId')).toBe('org-a');
    expect(payloadText({ payload: { targetOrgId: 7 } }, 'targetOrgId')).toBeUndefined();
    expect(payloadText({ payload: { targetOrgId: '' } }, 'targetOrgId')).toBeUndefined();
    expect(payloadText({ payload: null }, 'targetOrgId')).toBeUndefined();
    expect(payloadText({}, 'targetOrgId')).toBeUndefined();
  });
});
