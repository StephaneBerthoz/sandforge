/**
 * What the DataOps command lines — masking, restore and cleanup — say and
 * take of the org's automation: the three flags every other module's command
 * line takes (`--accept-automation`, `--accept-emails`, `--mute-automation`),
 * their help, and the lines a run and a dry run print from the read of what
 * the org runs (`readDataOpsAct`). One wording for the three, as their read
 * is one.
 */

import type { DataOpsAutomationAnswer, DataOpsWriteAccord } from '@sandforge/shared';
import { wouldBeRefusedLine } from './runRefused.js';

/** The switches the three command lines read. */
export const DATAOPS_AUTOMATION_SWITCHES = [
  '--accept-automation',
  '--accept-emails',
  '--mute-automation',
] as const;

/** What the line accepted and asked for, from its arguments. */
export function accordOf(args: readonly string[]): DataOpsWriteAccord {
  return {
    ...(args.includes('--accept-automation') ? { acceptAutomation: true } : {}),
    ...(args.includes('--accept-emails') ? { acceptEmails: true } : {}),
    ...(args.includes('--mute-automation') ? { muteAutomation: true } : {}),
  };
}

/**
 * The help of the three flags, in the words of the command that takes them.
 *
 * @param written - What the records go through, a word or two that fits the
 *   column: "written over", "deleted".
 * @param dryRun - The flag that says what a run would do, nothing written;
 *   absent for a command that has none.
 */
export function dataOpsAutomationHelp(written: string, dryRun?: string): string {
  const muteEnd = dryRun
    ? `exit 1; with ${dryRun}, says what
                         would be muted and assigns nothing`
    : 'exit 1';
  return `  --accept-automation    write although the org runs flows, Apex triggers,
                         processes or workflow rules as the records are
                         ${written}, or could not say what it runs:
                         AUTOMATION_NOT_ACCEPTED, exit 1, nothing written,
                         without it. What fires is said first, object by object.
                         An org the network did not reach as what it runs was
                         read refuses whatever is accepted:
                         ORG_TEMPORARILY_UNREACHABLE, exit 1, to be tried again
  --accept-emails        write although the org delivers every email of what
                         still runs as the records are ${written}, or would
                         not say whether it does: EMAILS_NOT_ACCEPTED, exit 1,
                         without it; --accept-automation never stands for it.
                         Asked only when what still runs sends one. Whether the
                         org delivers them is read with one line of anonymous
                         Apex that sends nothing
                         (Messaging.reserveSingleEmailCapacity(1)), never in a
                         production org; what an Apex trigger sends is read
                         nowhere. The emails are counted against what the org
                         has left today: past it, EMAILS_EXCEEDED, exit 1,
                         whatever is accepted
  --mute-automation      mute the org's automation for the run through its own
                         bypass: assign the user it writes as, for the run
                         alone, the permission sets holding the custom
                         permissions its flows, processes and workflow rules
                         test to stay quiet, and take them back as it ends.
                         What no bypass keeps quiet still runs, is named, and
                         still needs --accept-automation. Refused on a
                         production org and for a user who cannot assign
                         permission sets, ${muteEnd}
`;
}

/**
 * What a dry run says last of the read: each refusal a real run would stop
 * on, with its code, or that none would.
 */
export function wouldBeRefusedLines(answer: Pick<DataOpsAutomationAnswer, 'refusals'>): string[] {
  return answer.refusals.map((refusal) => `  ${wouldBeRefusedLine(refusal)}`);
}
