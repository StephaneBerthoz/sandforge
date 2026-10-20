import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FORGE_GUIDE_URL, helpSearchUrlOf, translateError } from '@sandforge/shared';
import type { ErrorHint, ErrorHintModule } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { ErrorExplanation } from './ErrorExplanation';

/** What the catalogue makes of `raw`, which must be something. */
function hintOf(raw: string, module?: ErrorHintModule): ErrorHint {
  const hint = translateError(raw, { module });
  if (!hint) throw new Error(`no hint for ${raw}`);
  return hint;
}

describe('ErrorExplanation', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('says what the error means and what to do about it', () => {
    render(
      <ErrorExplanation hint={hintOf('UNABLE_TO_LOCK_ROW: unable to obtain exclusive access')} />,
    );

    const hint = screen.getByTestId('error-hint');
    expect(hint.textContent).toContain(i18n.t('errors.rowLocked.explanation'));
    expect(hint.textContent).toContain(`→ ${i18n.t('errors.rowLocked.action')}`);
  });

  it("links a Forge code the guide's table lists to its row, opened by VS Code in the browser", () => {
    render(
      <ErrorExplanation
        hint={hintOf('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.', 'forge')}
      />,
    );

    const link = screen.getByRole('link', { name: 'REQUEST_LIMIT_EXCEEDED in the Forge guide' });
    expect(link.getAttribute('href')).toBe(`${FORGE_GUIDE_URL}#error-request-limit-exceeded`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(link.getAttribute('data-testid')).toBe('error-hint-link');
  });

  it('names the link in the interface language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(
      <ErrorExplanation
        hint={hintOf('MALFORMED_ID: id value of incorrect type: North', 'forge')}
      />,
    );

    expect(screen.getByRole('link').textContent).toBe('MALFORMED_ID dans le guide Forge');
  });

  it('shows a code it does not know by a search of Salesforce Help alone, repeating nothing', () => {
    render(<ErrorExplanation hint={hintOf('SOMETHING_NEW: details about the new error')} />);

    const hint = screen.getByTestId('error-hint');
    expect(hint.textContent).not.toContain('details about the new error');
    expect(hint.textContent).not.toContain('→');
    const link = screen.getByRole('link', { name: 'Search Salesforce Help for SOMETHING_NEW' });
    expect(link.getAttribute('href')).toBe(helpSearchUrlOf('SOMETHING_NEW'));
  });

  it('links nothing for a code of SandForge’s own', () => {
    render(
      <ErrorExplanation
        hint={hintOf(
          'CRUD_FLS_DENIED: FLS violation on Account: fields [Rating] are not updateable',
        )}
      />,
    );
    expect(screen.getByTestId('error-hint').textContent).toContain(
      i18n.t('errors.permissionDenied.action'),
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('tints the hint by what the error costs the run', () => {
    const { rerender } = render(
      <ErrorExplanation hint={hintOf('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')} />,
    );
    expect(screen.getByTestId('error-hint').className).toContain('border-status-error/30');

    rerender(<ErrorExplanation hint={hintOf('ENTITY_IS_DELETED: entity is deleted')} />);
    expect(screen.getByTestId('error-hint').className).toContain('border-status-warning/30');
  });
});
