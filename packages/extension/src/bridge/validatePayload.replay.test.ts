import { describe, expect, it } from 'vitest';

import {
  frozenLoadPayloadSchema,
  frozenRemovePayloadSchema,
  frozenRemovePreviewPayloadSchema,
  frozenVerifyReplayPayloadSchema,
} from './validatePayload.js';

/*
 * A replay of a checkpoint names its checkpoint by the Organization Id of its
 * org and its id, each of the one shape that names a folder of this machine:
 * nothing a page sends reaches a path it does not name.
 */

const REPLAY = {
  organizationId: '00D000000000011EAA',
  checkpointId: 'ck-20261110-091400-a1b2',
};

const CHOICES = {
  owners: 'same',
  customSettings: false,
  mask: false,
  contactPoints: 'neutralized',
  objects: [],
  excluded: [],
  link: [],
};

describe('the requests of a replay', () => {
  it('takes a load and its preview of a checkpoint with its choices and a load configuration of its own', () => {
    const asked = frozenLoadPayloadSchema.safeParse({
      targetOrgId: 'org-target',
      maxRecords: 6,
      replay: {
        ...REPLAY,
        choices: { ...CHOICES, link: [{ objectApiName: 'Account', fields: ['AccountNumber'] }] },
        config: { requiredFieldDefaults: { 'Case.Subject': 'Replayed' } },
      },
    });

    expect(asked.success).toBe(true);
  });

  it('refuses a load of a replay without its choices, or with a key the choices do not have', () => {
    expect(
      frozenLoadPayloadSchema.safeParse({ targetOrgId: 'org-target', replay: REPLAY }).success,
    ).toBe(false);
    expect(
      frozenLoadPayloadSchema.safeParse({
        targetOrgId: 'org-target',
        replay: { ...REPLAY, choices: { ...CHOICES, keepIds: true } },
      }).success,
    ).toBe(false);
  });

  it('refuses a replay’s configuration that names what only a project’s selection reads', () => {
    expect(
      frozenLoadPayloadSchema.safeParse({
        targetOrgId: 'org-target',
        replay: { ...REPLAY, choices: CHOICES, config: { sasDir: '/tmp/elsewhere' } },
      }).success,
    ).toBe(false);
  });

  it('refuses a checkpoint or an org named otherwise than by its own shape', () => {
    for (const replay of [
      { ...REPLAY, checkpointId: '../../etc' },
      { ...REPLAY, organizationId: '001000000000011EAA' },
    ]) {
      expect(
        frozenRemovePayloadSchema.safeParse({
          targetOrgId: 'org-target',
          loadedAt: '2026-11-14T10:00:00.000Z',
          replay,
        }).success,
      ).toBe(false);
    }
  });

  it('takes a verification and a removal of a replay by its checkpoint alone', () => {
    expect(
      frozenVerifyReplayPayloadSchema.safeParse({ targetOrgId: 'org-target', replay: REPLAY })
        .success,
    ).toBe(true);
    expect(
      frozenRemovePreviewPayloadSchema.safeParse({
        targetOrgId: 'org-target',
        loadedAt: '2026-11-14T10:00:00.000Z',
        replay: REPLAY,
      }).success,
    ).toBe(true);
    expect(
      frozenRemovePayloadSchema.safeParse({
        targetOrgId: 'org-target',
        loadedAt: '2026-11-14T10:00:00.000Z',
        replay: { ...REPLAY, choices: CHOICES },
      }).success,
    ).toBe(false);
  });
});
