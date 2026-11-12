import { describe, expect, it } from 'vitest';

import { removalOrg } from '../modules/forge/ForgeRunRemoval.js';
import { sweepParts } from '../modules/forge/ForgeRunSweep.js';
import {
  REFUSED_UNTIED_LOOSE,
  REFUSED_UNTIED_MADE,
  refusedUntiedSweep,
} from './refusedUntiedSweep.js';

describe('refusedUntiedSweep', () => {
  it('takes the task made for the run and leaves the loose one, its --sweep-untied refused', async () => {
    const { org, parts } = refusedUntiedSweep({ sweepParts, removalOrg });
    const sweep = parts(undefined, undefined as never, {
      includeChanged: false,
      removalSpans: [],
      sweepUntied: true,
    });
    await sweep.first();
    await sweep.afterRemoval();

    expect(org.ids('Task')).toEqual([REFUSED_UNTIED_LOOSE]);
    expect(org.deletes.flatMap((call) => call.ids)).toEqual([REFUSED_UNTIED_MADE]);
    expect(sweep.result().left).toEqual([
      expect.objectContaining({
        class: 'untied',
        objects: [{ objectApiName: 'Task', count: 1 }],
        refusal: expect.stringContaining('Another run of this machine'),
      }),
    ]);
  });

  it('keeps the options it is given: unasked, it takes the loose task no more', async () => {
    const { org, parts } = refusedUntiedSweep({ sweepParts, removalOrg });
    const sweep = parts(undefined, undefined as never, { includeChanged: false, removalSpans: [] });
    await sweep.first();

    expect(org.ids('Task')).toEqual([REFUSED_UNTIED_LOOSE]);
    expect(sweep.result().left).toEqual([expect.objectContaining({ class: 'untied' })]);
  });
});
