import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { organizationKey } from '../checkpoint/OrgCheckpointStore.js';
import { recoveryStatusOf } from './recoveryStatus.js';
import {
  RECOVERY_HANDOFF_FOLDER,
  journalDirOf,
  lastHandoffOf,
  recoveryHandoffFolderOf,
  recoveryHandoffNoteOf,
  recoveryHandoffPathOf,
  writeRecoveryHandoff,
} from './recoveryHandoff.js';

const BEFORE = '00Dxx00000AbCdE';
const AFTER = '00Dxx00000FgHiJ';
const POSIX = process.platform !== 'win32';

const ORG = {
  organizationId: AFTER,
  kind: 'sandbox' as const,
  alias: 'UAT',
  host: 'acme--uat.sandbox.my.salesforce.com',
};

function status() {
  return recoveryStatusOf({
    orgId: 'entry-uat',
    alias: 'UAT',
    tier: 'development',
    kind: 'sandbox',
    sandboxType: 'Full',
    organizationId: AFTER,
    refresh: {
      detectedAt: '2026-11-18T08:12:00.000Z',
      evidence: 'connection',
      previousOrganizationId: BEFORE,
      organizationId: AFTER,
      cachesForgotten: true,
    },
    acks: { steps: { endpoints: 'skipped' } },
    checkpointBefore: {
      checkpointId: 'ck-20261117-180000-a1b2',
      name: 'Before refresh',
      takenAt: '2026-11-17T18:00:00.000Z',
    },
    checkpointsNow: [{ takenAt: '2026-11-18T12:00:00.000Z', keptUntilDeleted: true }],
    lastUsersRun: { run: 2, at: '2026-11-18T09:00:00.000Z', status: 'success' },
  });
}

let journal: string;
beforeEach(() => {
  journal = mkdtempSync(join(tmpdir(), 'sandforge-recovery-handoff-'));
});
afterEach(() => rmSync(journal, { recursive: true, force: true }));

describe('the handoff note of Back into service', () => {
  it('says each step, the starting point, what is left and what SandForge leaves to others', () => {
    const note = recoveryHandoffNoteOf({
      status: status(),
      org: ORG,
      at: '2026-11-18T16:00:00.000Z',
      sandforgeVersion: '1.83.0',
    });
    expect(note.split('\n')[0]).toBe('# Handoff: `Back into service` on `UAT`');
    expect(note).toContain('- Org: `UAT`, sandbox `acme--uat`, `00Dxx00000FgHiJ`.');
    expect(note).toContain('the sandbox was `00Dxx00000AbCdE` before.');
    expect(note).toContain(
      '2. Users: done, ran on the sandbox since its refresh, 2026-11-18T09:00:00Z, last run 2, success.',
    );
    expect(note).toContain(
      '4. Replay of the checkpoint of before: to do, checkpoint `Before refresh` of 2026-11-17T18:00:00Z.',
    );
    expect(note).toContain('9. Endpoints that still name production: skipped.');
    expect(note).toContain('taken 2026-11-18T12:00:00Z: what the testers start from');
    // No audit read: each says which step of the page reads it.
    expect(note).toContain(
      '   - Not audited: step 9 of Back into service lists those that still name production.',
    );
    expect(note).toContain('## Not touched by SandForge');
  });

  it('says what the audits read, as the command line says it', () => {
    const note = recoveryHandoffNoteOf({
      status: status(),
      org: ORG,
      audits: {
        deliverability: { read: 'open' },
        schedules: { now: 1, jobs: [], kept: 0 },
        endpoints: {
          productionHosts: ['erp.acme.example'],
          found: [
            {
              source: 'namedCredential',
              name: 'Erp',
              url: 'https://erp.acme.example/api',
              host: 'erp.acme.example',
              why: 'listed',
            },
          ],
        },
      },
      at: '2026-11-18T16:00:00.000Z',
    });
    expect(note).toContain('   - Read open, All email');
    expect(note).toContain('`Erp` names `erp.acme.example`');
  });

  it('is kept beside the command line notes, in a folder no environment can be named, its owner alone reading it', async () => {
    const path = recoveryHandoffPathOf(journal, {
      organizationId: AFTER,
      at: '2026-11-18T16:00:00.000Z',
    });
    expect(path).toBe(
      join(
        journal,
        'handoff',
        RECOVERY_HANDOFF_FOLDER,
        `20261118T160000000Z-${organizationKey(AFTER)}.md`,
      ),
    );
    expect(/^[a-z][a-z0-9-]{0,62}$/.test(RECOVERY_HANDOFF_FOLDER)).toBe(false);
    await writeRecoveryHandoff(path, '# note\n');
    expect(readFileSync(path, 'utf8')).toBe('# note\n');
    if (POSIX) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(recoveryHandoffFolderOf(journal)).mode & 0o777).toBe(0o700);
    }
  });

  it('tells when the newest note of the org now was written, and nothing of another org', async () => {
    expect(await lastHandoffOf(journal, AFTER)).toBeUndefined();
    const folder = recoveryHandoffFolderOf(journal);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `20261118T160000000Z-${organizationKey(AFTER)}.md`), '');
    writeFileSync(join(folder, `20261118T170500250Z-${organizationKey(AFTER)}.md`), '');
    writeFileSync(join(folder, `20261119T090000000Z-${organizationKey(BEFORE)}.md`), '');
    writeFileSync(join(folder, 'notes.md'), '');
    expect(await lastHandoffOf(journal, AFTER)).toBe('2026-11-18T17:05:00.250Z');
    expect(await lastHandoffOf(journal, '00Dxx00000ZzZzZ')).toBeUndefined();
  });

  it('keeps its files where SANDFORGE_JOURNAL_DIR says, else in .sandforge of the home', () => {
    expect(journalDirOf({ SANDFORGE_JOURNAL_DIR: journal })).toBe(journal);
    expect(journalDirOf({})).toMatch(/\.sandforge$/);
  });
});
