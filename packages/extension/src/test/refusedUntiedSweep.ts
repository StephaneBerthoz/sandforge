/**
 * The real sweep of a removal on an org where it leaves part of what it was
 * asked to take: a contact of the run, a task the target's automation made on
 * it, and a task the run's user made in the run's window tied to nothing of it,
 * while another run of this machine wrote there — so `--sweep-untied` is
 * refused, as it was on a real org, where the sweep then ended a success and
 * the command exit 0 above the thirty tasks it left.
 *
 * Handed to a command line's removal in place of the sweep the command makes,
 * it keeps the options the command gives it: the test reads what the command
 * makes of the result. The sweep and the removal's org are passed in, the
 * real ones, as a command's tests mock the modules they come from.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import type { removalOrg } from '../modules/forge/ForgeRunRemoval.js';
import type {
  sweepParts,
  SweepInput,
  SweepOptions,
  SweepParts,
} from '../modules/forge/ForgeRunSweep.js';
import { tiedTargetOrg, type TiedRow, type TiedTargetOrg } from './tiedTargetOrg.js';

/** The user the run wrote as. */
export const REFUSED_UNTIED_USER = '005000000000077AAA';
/** The contact the run created. */
export const REFUSED_UNTIED_CONTACT = '003000000000077AAA';
/** The task the target's automation opened on the contact: tied to the run, taken. */
export const REFUSED_UNTIED_MADE = '00T000000000077AAA';
/** The task the run's user made in the window, tied to nothing of it: left. */
export const REFUSED_UNTIED_LOOSE = '00T000000000078AAA';

const FIRST = '2026-10-01T10:00:00.000Z';
const LAST = '2026-10-01T10:00:05.000Z';

const made = (
  recordId: string,
  created: string,
  lookups: Record<string, string> = {},
): TiedRow => ({
  Id: recordId,
  Name: recordId,
  CreatedById: REFUSED_UNTIED_USER,
  CreatedDate: created,
  LastModifiedDate: created,
  LastModifiedById: REFUSED_UNTIED_USER,
  SystemModstamp: created,
  ...lookups,
});

/**
 * The org, and the sweep a command's removal is handed in place of its own:
 * the real `sweepParts`, on that org as `removalOrg` reads it, told of the run
 * above and of another run of this machine in its window, with the options
 * the command gives.
 */
export function refusedUntiedSweep(real: {
  sweepParts: typeof sweepParts;
  removalOrg: typeof removalOrg;
}): {
  org: TiedTargetOrg;
  parts: (org: unknown, input: SweepInput, options: SweepOptions) => SweepParts;
} {
  const org = tiedTargetOrg(REFUSED_UNTIED_USER);
  org.shape('Contact', { children: [{ childSObject: 'Task', field: 'WhoId' }] });
  org.shape('Task', { references: { WhoId: ['Contact'] } });
  org.add('Contact', made(REFUSED_UNTIED_CONTACT, '2026-10-01T10:00:02.000+0000'));
  org.add(
    'Task',
    made(REFUSED_UNTIED_MADE, '2026-10-01T10:00:03.000+0000', { WhoId: REFUSED_UNTIED_CONTACT }),
    made(REFUSED_UNTIED_LOOSE, '2026-10-01T10:00:04.000+0000'),
  );
  const input: SweepInput = {
    writtenBetween: { first: FIRST, last: LAST },
    created: [{ objectApiName: 'Contact', ids: [REFUSED_UNTIED_CONTACT] }],
    remap: new Set([REFUSED_UNTIED_CONTACT.slice(0, 15)]),
    automation: { creates: [] },
    runUserId: REFUSED_UNTIED_USER,
    ties: { otherRuns: [{ ids: ['001000000000077AAA'] }] },
  };
  return {
    org,
    parts: (_org, _input, options) =>
      real.sweepParts(real.removalOrg(org.conn as never, 'test'), input, options),
  };
}
