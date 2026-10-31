import { describe, it, expect } from 'vitest';
import en from '../i18n/locales/en.json';
import { isMuteRefusalCode, muteRefusalWords } from './muteRefusal';

/** Reads a key of the English catalogue, `{{reason}}` filled in: what i18next does with it. */
function t(key: string, options?: Record<string, unknown>): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en);
  return String(value).replace('{{reason}}', String(options?.reason ?? ''));
}

/** The host's sentence of a set the org refused, which the panel keeps after its own. */
const FAILED =
  'The permission set Bypass_Automation could not be assigned (DUPLICATE_VALUE: duplicate value found). Nothing was assigned.';

describe('muteRefusalWords', () => {
  it('says a production target whole, the host’s English left out', () => {
    expect(
      muteRefusalWords(
        'MUTE_PRODUCTION',
        'The target is a production org: its automation is never muted there.',
        t,
      ),
    ).toBe(en.common.refusal.muteProduction);
  });

  it('says a user who cannot assign permission sets whole', () => {
    expect(muteRefusalWords('MUTE_NO_RIGHT', 'The target’s automation cannot be muted.', t)).toBe(
      en.common.refusal.muteNoRight,
    );
  });

  it('keeps what the org answered after its own words for a set that could not be assigned', () => {
    expect(muteRefusalWords('MUTE_FAILED', FAILED, t)).toBe(
      `The target's automation couldn't be muted, so nothing was written: ${FAILED}`,
    );
  });

  it('keeps a checkpoint’s refusal, which names no kind, after its own words', () => {
    expect(muteRefusalWords('MUTE', 'The target is a production org.', t)).toBe(
      "The org's automation couldn't be muted, so nothing was written: The target is a production org.",
    );
  });

  it('says nothing of any other code', () => {
    expect(muteRefusalWords('GUARD_BLOCKED', 'Operation blocked', t)).toBeUndefined();
    expect(muteRefusalWords(null, 'no code', t)).toBeUndefined();
    expect(muteRefusalWords('constructor', 'no code', t)).toBeUndefined();
    expect(isMuteRefusalCode('MUTE_FAILED')).toBe(true);
    expect(isMuteRefusalCode('MUTED')).toBe(false);
  });
});
