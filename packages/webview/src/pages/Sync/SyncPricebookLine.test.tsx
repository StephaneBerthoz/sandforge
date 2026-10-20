import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { SyncPricebookLine } from './SyncPricebookLine';

describe('SyncPricebookLine', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says the standard price book was matched to the target, in no colour of a refusal', () => {
    render(<SyncPricebookLine testId="line" />);

    const line = screen.getByTestId('line');
    expect(line.textContent).toBe(
      "Standard price book: matched to the target org's, never written.",
    );
    expect(line.className).toContain('text-text-secondary');
    expect(line.className).not.toContain('status-error');
  });

  it('says it in the language of the panel', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });

    render(<SyncPricebookLine testId="line" />);

    expect(screen.getByTestId('line').textContent).toBe(fr.sync.standardPricebookMatched);
  });
});
