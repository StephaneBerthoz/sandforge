import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { formatNumber } from '../../utils/formatters';
import { SyncReadCutLine, readCutOf } from './SyncReadCutLine';

describe('SyncReadCutLine', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says below the most a run holds that raising the setting copies the rest, and names the sample that fits', () => {
    render(<SyncReadCutLine cap={1_000} testId="line" />);

    const line = screen.getByTestId('line');
    expect(line.textContent).toBe(
      'The read of the source org stopped at 1,000 records, the bound: this run copied part of ' +
        'this object. To copy the rest, raise sandforge.sync.maxRecordsPerObject (50,000 at ' +
        'most), or read it in slices with a filter on CreatedDate, one range per run. To copy a ' +
        'sample of the source that fits the target instead, use Forge with Depth ALL and Records ' +
        'per object set to A sample that fits the target.',
    );
    expect(line.className).toContain('text-status-warning');
    expect(line.className).not.toContain('status-error');
  });

  it('offers no higher bound at the most a run holds', () => {
    render(<SyncReadCutLine cap={50_000} testId="line" />);

    const text = screen.getByTestId('line').textContent ?? '';
    expect(text).toContain('the most a run holds of an object');
    expect(text).not.toContain('raise sandforge.sync.maxRecordsPerObject');
    expect(text).toContain('read it in slices');
  });

  it('says nothing of an object read whole', () => {
    const { container } = render(<SyncReadCutLine cap={undefined} testId="line" />);

    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('line')).toBeNull();
  });

  it('says it in the language of the panel', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });

    render(<SyncReadCutLine cap={1_000} testId="line" />);

    expect(screen.getByTestId('line').textContent).toBe(
      fr.syncParts.readCut.replace('{{cap}}', formatNumber(1_000, 'fr')),
    );
  });
});

describe('readCutOf', () => {
  it('gives the bound of an object the run cut, and nothing for one it read whole', () => {
    const result = { readCap: 100, cutAtReadCap: ['Contact'] };

    expect(readCutOf(result, 'Contact')).toBe(100);
    expect(readCutOf(result, 'Account')).toBeUndefined();
  });

  it('gives nothing for a result that names no cut, as one kept before runs named them', () => {
    expect(readCutOf({}, 'Contact')).toBeUndefined();
    expect(readCutOf({ cutAtReadCap: ['Contact'] }, 'Contact')).toBeUndefined();
  });
});
