import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { FORGE_GUIDE_URL, translateForgeError } from './forgeErrorTranslator';
import type { TranslatedError } from './forgeErrorTranslator';
import { ForgeErrorHint } from './ForgeErrorHint';

/** What the translator makes of `raw`, which must be something. */
function hintOf(raw: string): TranslatedError {
  const hint = translateForgeError(raw);
  if (!hint) throw new Error(`no hint for ${raw}`);
  return hint;
}

describe('ForgeErrorHint', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('says what the error means and what to do about it', () => {
    render(
      <ForgeErrorHint hint={hintOf('UNABLE_TO_LOCK_ROW: unable to obtain exclusive access')} />,
    );

    const hint = screen.getByTestId('forge-error-translation');
    expect(hint.textContent).toContain(i18n.t('forge.error.rowLocked.explanation'));
    expect(hint.textContent).toContain(`→ ${i18n.t('forge.error.rowLocked.action')}`);
  });

  it("links a code the guide's table lists to its row, opened by VS Code in the browser", () => {
    render(
      <ForgeErrorHint hint={hintOf('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')} />,
    );

    const link = screen.getByRole('link', { name: 'REQUEST_LIMIT_EXCEEDED in the Forge guide' });
    expect(link.getAttribute('href')).toBe(`${FORGE_GUIDE_URL}#error-request-limit-exceeded`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(link.getAttribute('data-testid')).toBe('forge-error-guide-link');
  });

  it('names the link in the interface language', async () => {
    // A language other than English comes with its bundle, as the extension
    // sends it.
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(<ForgeErrorHint hint={hintOf('MALFORMED_ID: id value of incorrect type: North')} />);

    expect(screen.getByRole('link').textContent).toBe('MALFORMED_ID dans le guide Forge');
  });

  it('links nothing for a code the table has no row for', () => {
    render(<ForgeErrorHint hint={hintOf('SOMETHING_NEW: details about the new error')} />);

    expect(screen.getByTestId('forge-error-translation').textContent).toContain(
      'details about the new error',
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('tints the hint by what the error costs the clone', () => {
    const { rerender } = render(
      <ForgeErrorHint hint={hintOf('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')} />,
    );
    expect(screen.getByTestId('forge-error-translation').className).toContain(
      'border-status-error/30',
    );

    rerender(<ForgeErrorHint hint={hintOf('ENTITY_IS_DELETED: entity is deleted')} />);
    expect(screen.getByTestId('forge-error-translation').className).toContain(
      'border-status-warning/30',
    );
  });
});
