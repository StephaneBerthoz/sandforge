import { describe, expect, it } from 'vitest';

import {
  accordOf,
  dataOpsAutomationHelp,
  DATAOPS_AUTOMATION_SWITCHES,
  wouldBeRefusedLines,
} from './dataOpsAutomationCli.js';

describe('the automation flags of the DataOps command lines', () => {
  it('reads what the line accepts and asks for, and nothing it was not given', () => {
    expect(accordOf(['anonymize', '--accept-automation', '--mute-automation'])).toEqual({
      acceptAutomation: true,
      muteAutomation: true,
    });
    expect(accordOf(['--accept-emails'])).toEqual({ acceptEmails: true });
    expect(accordOf(['--yes'])).toEqual({});
    expect(DATAOPS_AUTOMATION_SWITCHES).toEqual([
      '--accept-automation',
      '--accept-emails',
      '--mute-automation',
    ]);
  });

  it('names each flag in its help, with the codes a run without it is refused under', () => {
    const help = dataOpsAutomationHelp('deleted', '--dry-run');
    for (const flag of DATAOPS_AUTOMATION_SWITCHES) expect(help).toContain(flag);
    for (const code of ['AUTOMATION_NOT_ACCEPTED', 'EMAILS_NOT_ACCEPTED', 'EMAILS_EXCEEDED']) {
      expect(help).toContain(code);
    }
    expect(help).toContain('as the records are\n                         deleted');
  });

  it('says in a dry run each refusal a real run would stop on, with its code', () => {
    expect(
      wouldBeRefusedLines({
        refusals: [{ code: 'AUTOMATION_NOT_ACCEPTED', message: 'TGT runs automation.' }],
      }),
    ).toEqual(['  a real run would be refused (AUTOMATION_NOT_ACCEPTED): TGT runs automation.']);
    expect(wouldBeRefusedLines({ refusals: [] })).toEqual([]);
  });
});
