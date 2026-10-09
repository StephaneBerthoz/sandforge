import { describe, it, expect, beforeEach } from 'vitest';
import type { AnonymizationTemplateRule } from '@sandforge/shared';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import {
  MAX_CHECKPOINT_REFUSED,
  MaskingCheckpointStore,
  maskingFingerprint,
} from './MaskingCheckpointStore.js';
import type { MaskingCheckpoint } from './MaskingCheckpointStore.js';

const RULES: AnonymizationTemplateRule[] = [
  { fieldPattern: 'Contact.Email', ruleType: 'hash', description: 'Hash the email' },
  { fieldPattern: 'Contact.Phone', ruleType: 'mask', description: '', config: { maskKeepLast: 4 } },
];

/** An id shaped as the org gives one, numbered. */
function recordId(n: number): string {
  return `003${String(n).padStart(12, '0')}`;
}

function checkpoint(overrides: Partial<MaskingCheckpoint> = {}): MaskingCheckpoint {
  return {
    id: 'run-1',
    orgId: 'org-1',
    templateId: 'tpl-1',
    fingerprint: maskingFingerprint(RULES, ['Contact']),
    savedAt: '2026-10-09T10:00:00.000Z',
    objects: [
      { objectApiName: 'Contact', done: false, afterId: recordId(2000), refused: [recordId(7)] },
    ],
    ...overrides,
  };
}

describe('maskingFingerprint', () => {
  it('is the same for the same rules and objects', () => {
    expect(maskingFingerprint(RULES, ['Contact'])).toBe(
      maskingFingerprint(
        RULES.map((r) => ({ ...r })),
        ['Contact'],
      ),
    );
  });

  it('changes with a rule’s method, its setting, or the objects, and not with its description', () => {
    const base = maskingFingerprint(RULES, ['Contact']);
    expect(maskingFingerprint([{ ...RULES[0], ruleType: 'fake' }, RULES[1]], ['Contact'])).not.toBe(
      base,
    );
    expect(
      maskingFingerprint([RULES[0], { ...RULES[1], config: { maskKeepLast: 2 } }], ['Contact']),
    ).not.toBe(base);
    expect(maskingFingerprint(RULES, ['Contact', 'Lead'])).not.toBe(base);
    expect(
      maskingFingerprint([{ ...RULES[0], description: 'Other words' }, RULES[1]], ['Contact']),
    ).toBe(base);
  });
});

describe('MaskingCheckpointStore', () => {
  let configStore: ConfigStore;
  let checkpoints: MaskingCheckpointStore;

  beforeEach(() => {
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    checkpoints = new MaskingCheckpointStore(configStore);
  });

  it('gives back the checkpoint saved for an org and a template whose rules are unchanged', () => {
    checkpoints.save(checkpoint());
    expect(checkpoints.load('org-1', 'tpl-1', maskingFingerprint(RULES, ['Contact']))).toEqual(
      checkpoint(),
    );
  });

  it('gives back nothing for another org, another template, or rules changed since', () => {
    checkpoints.save(checkpoint());
    const fingerprint = maskingFingerprint(RULES, ['Contact']);
    expect(checkpoints.load('org-2', 'tpl-1', fingerprint)).toBeUndefined();
    expect(checkpoints.load('org-1', 'tpl-2', fingerprint)).toBeUndefined();
    expect(
      checkpoints.load('org-1', 'tpl-1', maskingFingerprint([RULES[0]], ['Contact'])),
    ).toBeUndefined();
  });

  it('keeps one checkpoint per org and template, the last saved', () => {
    checkpoints.save(checkpoint());
    checkpoints.save(checkpoint({ id: 'run-2' }));
    expect(checkpoints.load('org-1', 'tpl-1', checkpoint().fingerprint)?.id).toBe('run-2');
  });

  it('forgets a checkpoint once cleared', () => {
    checkpoints.save(checkpoint());
    checkpoints.clear('org-1', 'tpl-1');
    expect(checkpoints.load('org-1', 'tpl-1', checkpoint().fingerprint)).toBeUndefined();
  });

  it('reads an entry that is no checkpoint as none', () => {
    configStore.set('anonymization:checkpoint:org-1:tpl-1', {
      ...checkpoint(),
      objects: [{ objectApiName: 'Contact', done: false, afterId: "x' OR Id != '", refused: [] }],
    });
    expect(checkpoints.load('org-1', 'tpl-1', checkpoint().fingerprint)).toBeUndefined();
  });

  it('refuses to keep more refused records than a resume would retry', () => {
    const refused = Array.from({ length: MAX_CHECKPOINT_REFUSED + 1 }, (_, i) => recordId(i));
    expect(() =>
      checkpoints.save(
        checkpoint({ objects: [{ objectApiName: 'Contact', done: true, refused }] }),
      ),
    ).toThrow(`at most ${MAX_CHECKPOINT_REFUSED} refused records`);
    expect(checkpoints.load('org-1', 'tpl-1', checkpoint().fingerprint)).toBeUndefined();
  });
});
