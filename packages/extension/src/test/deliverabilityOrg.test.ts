import { describe, expect, it } from 'vitest';

import { readEmailDeliverability } from '../modules/forge/targetDeliverability.js';
import { answeringDeliverability } from './deliverabilityOrg.js';

describe('answeringDeliverability', () => {
  it('answers an org on All email as the read takes it, in one request', async () => {
    const org = answeringDeliverability('all', async () => ({}));

    expect(await readEmailDeliverability(org)).toEqual({ reading: { level: 'all' }, requests: 1 });
    expect(org.asked).toEqual(['apex']);
  });

  it('answers an org that withholds them, its user holding Send Email, in two requests', async () => {
    const org = answeringDeliverability('withheld', async () => ({}));

    expect(await readEmailDeliverability(org)).toEqual({
      reading: { level: 'withheld' },
      requests: 2,
    });
    expect(org.asked).toEqual(['apex', 'sendEmail']);
  });

  it('hands every other request to the fake, and refuses Apex that is not the read', async () => {
    const org = answeringDeliverability('all', async () => ({ DataStorageMB: { Max: 5 } }));

    expect(await org.request({ method: 'GET', url: '/limits' })).toEqual({
      DataStorageMB: { Max: 5 },
    });
    await expect(
      org.request('/tooling/run?anonymousBody=delete%20%5BSELECT%20Id%5D%3B'),
    ).rejects.toThrow("Not the read's Apex");
    expect(org.asked).toEqual([]);
  });
});
