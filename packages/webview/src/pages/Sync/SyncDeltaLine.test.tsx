import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import type { SyncDeltaOutcome } from '@sandforge/shared';
import { SyncDeltaLine } from './SyncDeltaLine';

function outcome(overrides: Partial<SyncDeltaOutcome> = {}): SyncDeltaOutcome {
  return {
    read: 'delta',
    since: '2026-10-13T09:00:00.000Z',
    changed: 3,
    deletionsChecked: false,
    deleted: 0,
    deleteFailed: 0,
    ...overrides,
  };
}

function lineText(delta: SyncDeltaOutcome, simulated?: boolean): string {
  render(<SyncDeltaLine delta={delta} simulated={simulated} testId="line" />);
  return screen.getByTestId('line').textContent ?? '';
}

describe('SyncDeltaLine', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says a delta read since its watermark, what changed, what it deleted, and where the next run reads from', () => {
    const text = lineText(
      outcome({ deletionsChecked: true, deleted: 1, recorded: '2026-10-13T10:00:00.000Z' }),
    );
    expect(text).toMatch(/^Delta since 2026-10-13 \d\d:00:00 · 3 changed · 1 deleted/);
    expect(text).toMatch(/The next run reads the changes since 2026-10-13 \d\d:00:00\./);
  });

  it('leaves deletions unsaid when the configuration does not carry them', () => {
    expect(lineText(outcome())).not.toContain('deleted');
  });

  it('says a full read with its reason', () => {
    expect(lineText(outcome({ read: 'full', since: undefined, reason: 'scope_changed' }))).toMatch(
      /^Full read \(filter, fields, key, mapping or files changed\) · 3 changed/,
    );
  });

  it('says the watermark was kept when the object did not finish', () => {
    expect(lineText(outcome())).toContain('Watermark kept');
  });

  it('says why the watermark was kept when the run left records without a lookup it was to set', () => {
    // Moved past them, the next run never read them again, and their lookup
    // stayed unset for good: the line said only "kept".
    const text = lineText(outcome({ lookupsOwed: 2 }));
    expect(text).toContain('Watermark kept');
    expect(screen.getByTestId('line-owed').textContent).toBe(
      '2 records are still without a lookup this run was to set: the watermark does not move ' +
        'past them, so the next run reads them again.',
    );
  });

  it('says nothing of lookups owed in a simulation, nor when none are', () => {
    lineText(outcome({ lookupsOwed: 1 }), true);
    expect(screen.queryByTestId('line-owed')).toBeNull();
  });

  it('says nothing of a watermark where none is ever kept', () => {
    const text = lineText(outcome({ read: 'full', since: undefined, reason: 'not_saved' }));
    expect(text).toContain('not a saved configuration');
    expect(text).not.toContain('Watermark');
    expect(text).not.toContain('next run');
  });

  it('says the deletions a simulation would carry, and no watermark', () => {
    const text = lineText(outcome({ deletionsChecked: true, deleted: 2 }), true);
    expect(text).toContain('2 would be deleted');
    expect(text).not.toContain('Watermark');
  });

  it('says deletions the target refused, and deletions that could not be read', () => {
    const text = lineText(
      outcome({ deletionsChecked: true, deleteFailed: 2, deletionError: 'INVALID_QUERY_LOCATOR' }),
    );
    expect(text).toContain('2 deletions refused by the target');
    expect(text).toContain('Deletions were not carried this time');
  });

  it('reads in the interface language', async () => {
    // Bundles other than English are loaded on demand.
    i18n.addResourceBundle('fr', 'translation', fr);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    expect(lineText(outcome({ changed: 1, deletionsChecked: true, deleted: 2 }))).toMatch(
      /^Delta depuis le .* · 1 modifié · 2 supprimés/,
    );
  });
});
