import { describe, expect, it } from 'vitest';

import { compositeOver } from './compositeOver.js';

const subrequest = (route: string, soql: string, referenceId: string) => ({
  method: 'GET',
  url: `/services/data/v66.0/${route}?q=${encodeURIComponent(soql)}`,
  referenceId,
});

const composite = (subrequests: unknown[]) => ({
  method: 'POST',
  url: '/composite',
  body: JSON.stringify({ compositeRequest: subrequests }),
});

describe('compositeOver', () => {
  it('answers each query as the fake’s query answers it, the recycle bin read by queryAll', async () => {
    const asked: Array<[string, boolean | undefined]> = [];
    const org = compositeOver(async (soql, options) => {
      asked.push([soql, options?.scanAll]);
      return { totalSize: 1, done: true, records: [] };
    });

    const answered = await org.request(
      composite([
        subrequest('query', 'SELECT COUNT() FROM Task', 'a'),
        subrequest('queryAll', 'SELECT Id FROM Task WHERE IsDeleted = true', 'b'),
      ]),
    );

    expect(answered).toEqual({
      compositeResponse: [
        expect.objectContaining({ referenceId: 'a', httpStatusCode: 200 }),
        expect.objectContaining({ referenceId: 'b', httpStatusCode: 200 }),
      ],
    });
    expect(asked).toEqual([
      ['SELECT COUNT() FROM Task', false],
      ['SELECT Id FROM Task WHERE IsDeleted = true', true],
    ]);
    expect(org.calls).toEqual([2]);
  });

  it('answers a statement the fake refuses as the org answers one, while the call answers 200', async () => {
    const org = compositeOver(async () => {
      throw new Error('No such column');
    });

    const answered = (await org.request(
      composite([subrequest('query', 'SELECT Nope FROM Task', 'a')]),
    )) as { compositeResponse: Array<{ httpStatusCode: number; body: unknown }> };

    expect(answered.compositeResponse[0]).toMatchObject({
      httpStatusCode: 400,
      body: [{ errorCode: 'MALFORMED_QUERY', message: 'No such column' }],
    });
  });

  it('refuses a call that is no composite, and a subrequest that is no query', async () => {
    const org = compositeOver(async () => ({}));

    await expect(org.request({ url: '/limits' })).rejects.toThrow(/unexpected request/);
    await expect(
      org.request(
        composite([{ method: 'GET', url: '/services/data/v66.0/limits', referenceId: 'a' }]),
      ),
    ).rejects.toThrow(/unexpected subrequest/);
  });
});
