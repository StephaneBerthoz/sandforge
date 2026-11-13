/**
 * Whether a sandbox is a Partial Copy or a Full one, read live, for the
 * command line, which cannot see the Staging mark the extension keeps.
 *
 * A sandbox marked Staging holds real data, and the panel never empties the
 * whole of it (`emptyGuard.ts`). The command line registers the org afresh at
 * each run, from what the org says it is, and knows no mark: a whole org's
 * emptying there would have emptied a full copy of production as readily as a
 * developer's sandbox. So it refuses the whole org of a sandbox that copies
 * production's records — a Partial Copy or a Full sandbox — and sends to the
 * panel, which knows the mark. Objects picked stay allowed, Production Guard
 * asked as for every delete.
 *
 * Nothing the org says names its sandbox's license. Its data storage does,
 * as Salesforce documents it: 200 MB for a Developer sandbox, 1 GB for a
 * Developer Pro, 5 GB for a Partial Copy, production's own for a Full
 * sandbox; a scratch org was read at 500 MB. Past a Developer Pro's, it is
 * taken for a copy; a sandbox whose storage cannot be read is too.
 */

import * as z from 'zod';
import type { DataOpsEmptyRefusal, OrgType } from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { NOTHING_READ } from './emptyGuard.js';

/** The data storage of a Developer Pro sandbox, in MB: past it, a sandbox copies production's records. */
export const DEVELOPER_PRO_DATA_STORAGE_MB = 1024;

/** The code the whole org of a copy sandbox is refused under, on the command line. */
export const COPY_SANDBOX = 'COPY_SANDBOX';

const limitsSchema = z.object({ DataStorageMB: z.object({ Max: z.number() }).loose() }).loose();

/** What the org is, as the command line knows it, and how its limits are read. */
export interface CopySandboxInput {
  /** The org's alias, as the command line was given it. */
  target: string;
  /** What the org said it is as it was connected: `Sandbox` for a sandbox or a scratch org. */
  orgType: OrgType;
  /** The org's `/limits`. */
  limits: () => Promise<unknown>;
}

/**
 * The refusal of a whole org's emptying from the command line on a Partial
 * Copy or Full sandbox, or one whose data storage could not be read; nothing
 * for any other org, whose limits are not read.
 */
export async function copySandboxRefusal(
  input: CopySandboxInput,
): Promise<DataOpsEmptyRefusal | undefined> {
  if (input.orgType !== 'Sandbox') return undefined;
  const instead =
    'Empty it whole from DataOps Cleanup in the panel, which knows whether it is marked ' +
    'Staging, or pick the objects to empty with --objects, which Production Guard asks about. ' +
    NOTHING_READ;
  let storage: number;
  try {
    storage = limitsSchema.parse(await input.limits()).DataStorageMB.Max;
  } catch (err: unknown) {
    return {
      code: COPY_SANDBOX,
      message:
        `${input.target} is a sandbox whose data storage could not be read ` +
        `(${extractErrorMessage(err)}): this command cannot tell a Partial Copy or Full ` +
        `sandbox, which may hold real data, from a developer's. ${instead}`,
    };
  }
  if (storage <= DEVELOPER_PRO_DATA_STORAGE_MB) return undefined;
  return {
    code: COPY_SANDBOX,
    message:
      `${input.target} is a Partial Copy or Full sandbox, by its data storage ` +
      `(${storage.toLocaleString('en-US')} MB, past the ` +
      `${DEVELOPER_PRO_DATA_STORAGE_MB.toLocaleString('en-US')} MB of a Developer Pro): it may ` +
      'hold real data, and this command cannot see whether it is marked Staging in the ' +
      `extension, where such a sandbox is never emptied whole. ${instead}`,
  };
}
