import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ForgeOptionToggles, type ForgeOptionTogglesProps } from './ForgeOptionToggles';

/** The toggles with every option off, and a spy behind each change. */
function renderToggles(overrides: Partial<ForgeOptionTogglesProps> = {}) {
  const props: ForgeOptionTogglesProps = {
    anonymize: false,
    onAnonymizeChange: vi.fn(),
    skipEmpty: false,
    onSkipEmptyChange: vi.fn(),
    expandOrphanParents: false,
    onExpandOrphanParentsChange: vi.fn(),
    keepContactPoints: false,
    onKeepContactPointsChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ForgeOptionToggles {...props} />) };
}

describe('ForgeOptionToggles', () => {
  it('offers to keep emails and phone numbers as they are, off by default, saying what off does', () => {
    renderToggles();

    const toggle = screen.getByLabelText('Keep emails and phone numbers as they are');
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(toggle.closest('label')?.getAttribute('title')).toBe(
      "Off, the clone writes every email address under .invalid and every phone number as a fictional one, so the target org's automation reaches no one.",
    );
    expect(screen.queryByTestId('forge-keep-contact-points-warning')).toBeNull();
  });

  it('asks for the choice to change when the toggle is clicked', () => {
    const { props } = renderToggles();

    fireEvent.click(screen.getByTestId('forge-keep-contact-points-toggle'));

    expect(props.onKeepContactPointsChange).toHaveBeenCalledWith(true);
  });

  it('warns, once on, that the target’s automation may then reach real people', () => {
    renderToggles({ keepContactPoints: true });

    const warning = screen.getByRole('alert');
    expect(warning.textContent).toBe(
      "Emails and phone numbers will be written as the source holds them: the target org's flows, triggers and email alerts may then email or text real people.",
    );
    expect(
      screen.getByTestId('forge-keep-contact-points-toggle').getAttribute('aria-describedby'),
    ).toBe(warning.id);
  });
});
