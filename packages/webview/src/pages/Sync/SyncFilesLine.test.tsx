import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import type { SyncFilesOutcome } from '@sandforge/shared';
import { SyncFilesLine, SyncFilesStorageLine, SyncFilesSummary } from './SyncFilesLine';

const MB = 1_048_576;

function outcome(overrides: Partial<SyncFilesOutcome> = {}): SyncFilesOutcome {
  return {
    copied: 0,
    versions: 0,
    bytes: 0,
    links: 0,
    unchanged: 0,
    tooLarge: 0,
    pastRunCap: 0,
    external: 0,
    recordNotWritten: 0,
    failed: 0,
    ...overrides,
  };
}

function textOf(element: React.ReactElement): string {
  render(element);
  return screen.getByTestId('line').textContent ?? '';
}

describe('SyncFilesLine', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says the files copied, the versions added and what they took', () => {
    expect(
      textOf(
        <SyncFilesLine
          files={outcome({ copied: 2, versions: 1, bytes: 52, unchanged: 3 })}
          testId="line"
        />,
      ),
    ).toBe('2 files copied · 1 new version · 52 B · 3 already copied, unchanged');
  });

  it('says the attachments whose copy was replaced, a run and a simulation alike', () => {
    expect(
      textOf(<SyncFilesLine files={outcome({ replaced: 2, bytes: 30 })} testId="line" />),
    ).toBe('0 files copied · 2 changed attachments replaced · 30 B');
  });

  it('says what a simulation would replace', () => {
    expect(
      textOf(<SyncFilesLine files={outcome({ replaced: 1, bytes: 30 })} simulated testId="line" />),
    ).toContain('1 changed attachment would be replaced');
  });

  it('says what the caps skipped and what was not copied, never leaving it out', () => {
    const text = textOf(
      <SyncFilesLine
        files={outcome({
          copied: 1,
          bytes: MB,
          tooLarge: 1,
          pastRunCap: 2,
          recordNotWritten: 1,
          failed: 1,
        })}
        testId="line"
      />,
    );

    expect(text).toContain('1 skipped: larger than the largest file');
    expect(text).toContain('2 skipped: past the most a run copies');
    expect(text).toContain('1 not copied: no record it hangs on was written');
    expect(text).toContain('1 file could not be copied: the notes below say why');
  });

  it("says what a simulation's run would copy", () => {
    expect(
      textOf(
        <SyncFilesLine
          files={outcome({ copied: 3, versions: 2, bytes: 2 * MB })}
          simulated
          testId="line"
        />,
      ),
    ).toBe('3 files would be copied · 2 new versions would be added · 2 MB');
  });

  it('says it in the language of the interface', async () => {
    i18n.addResourceBundle('fr', 'translation', fr);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });

    expect(textOf(<SyncFilesLine files={outcome({ copied: 2, bytes: 52 })} testId="line" />)).toBe(
      '2 fichiers copiés · 52 B',
    );
  });
});

describe('SyncFilesSummary', () => {
  it('adds up the files of every object, and what the caps skipped', () => {
    expect(
      textOf(
        <SyncFilesSummary
          outcomes={[
            outcome({ copied: 2, versions: 1, bytes: MB, tooLarge: 1 }),
            outcome({ copied: 0, pastRunCap: 2 }),
          ]}
          testId="line"
        />,
      ),
    ).toBe('3 files, 1 MB copied, 3 skipped past the caps');
  });
});

describe('SyncFilesStorageLine', () => {
  it("says what the files take of the target's file storage", () => {
    expect(
      textOf(
        <SyncFilesStorageLine
          storage={{ remainingBytes: 20 * MB, plannedBytes: 52 }}
          testId="line"
        />,
      ),
    ).toBe('These files take 52 B of the 20 MB of file storage the target has left.');
  });

  it('says a run would be refused when they do not fit', () => {
    render(
      <SyncFilesStorageLine
        storage={{ remainingBytes: MB, plannedBytes: 2 * MB, shortfall: 'do not fit' }}
        testId="line"
      />,
    );

    expect(screen.getByRole('alert').textContent).toBe(
      'These files take 2 MB and the target has 1 MB of file storage left: a run would be refused before writing anything.',
    );
  });
});
