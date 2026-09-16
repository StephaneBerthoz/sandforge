import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ComingSoon } from './ComingSoon';

describe('ComingSoon', () => {
  it('says what is missing and what it is called, as a panel', () => {
    render(<ComingSoon description="Cleanup finds nothing yet" data-testid="cleanup-soon" />);
    const notice = screen.getByTestId('cleanup-soon');
    expect(notice.textContent).toContain('Coming soon');
    expect(notice.textContent).toContain('Cleanup finds nothing yet');
  });

  it('keeps the same test id and the same words when it is a banner', () => {
    // The banner sits above a surface that works, so it loses the panel's
    // height — but a reader and a test must still find the same notice.
    render(
      <ComingSoon
        variant="banner"
        description="Steps report success without touching an org"
        data-testid="steps-soon"
      />,
    );
    const notice = screen.getByTestId('steps-soon');
    expect(notice.textContent).toContain('Coming soon');
    expect(notice.textContent).toContain('Steps report success without touching an org');
    expect(notice.getAttribute('role')).toBe('note');
    expect(notice.className).toContain('py-2');
  });

  it('is a panel when no variant is given', () => {
    render(<ComingSoon description="Planned" data-testid="default-soon" />);
    const notice = screen.getByTestId('default-soon');
    expect(notice.className).toContain('py-10');
    expect(notice.getAttribute('role')).toBeNull();
  });
});
