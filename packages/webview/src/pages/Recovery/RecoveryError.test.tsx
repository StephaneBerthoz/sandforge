import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { RECOVERY_ERROR_CODES } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import { RecoveryError } from './RecoveryError';

describe('RecoveryError', () => {
  it('words every code of the domain, never the English the extension logs', () => {
    for (const code of RECOVERY_ERROR_CODES) {
      const { unmount } = render(
        <RecoveryError error="English from the host" errorCode={code} alias="UAT" testId="e" />,
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        en.recovery.error[code].replace(/{{alias}}/g, 'UAT'),
      );
      expect(screen.getByRole('alert')).not.toHaveTextContent('English from the host');
      unmount();
    }
  });

  it('says the bridge’s own words for an error that carried no code of the domain', () => {
    render(<RecoveryError error="The request timed out" errorCode={null} alias="UAT" testId="e" />);
    expect(screen.getByRole('alert')).toHaveTextContent('The request timed out');
  });

  it('asks again on Try again, where asking again can change something', () => {
    const onRetry = vi.fn();
    render(<RecoveryError error="x" errorCode="FAILED" alias="UAT" onRetry={onRetry} testId="e" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
