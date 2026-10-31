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
    const describedBy = screen
      .getByTestId('forge-keep-contact-points-toggle')
      .getAttribute('aria-describedby')
      ?.split(' ');
    expect(describedBy).toEqual([
      screen.getByTestId('forge-contact-points-default').id,
      warning.id,
    ]);
  });

  it('draws each chip’s state with a box, checked only when the option is on', () => {
    // The chips said their state by a border colour alone; off, all four
    // looked alike.
    renderToggles({ anonymize: true, expandOrphanParents: true });

    const box = (testId: string) => screen.getByTestId(testId);
    expect(box('forge-anonymize-box').getAttribute('data-checked')).toBe('true');
    expect(box('forge-anonymize-box').querySelector('svg')).not.toBeNull();
    expect(box('forge-expand-orphan-parents-box').getAttribute('data-checked')).toBe('true');
    expect(box('forge-skip-empty-box').getAttribute('data-checked')).toBe('false');
    expect(box('forge-skip-empty-box').querySelector('svg')).toBeNull();
    expect(box('forge-keep-contact-points-box').getAttribute('data-checked')).toBe('false');
    // The box is for the eye: the checkbox already says its state.
    expect(box('forge-anonymize-box').getAttribute('aria-hidden')).toBe('true');
    expect((screen.getByTestId('forge-anonymize-toggle') as HTMLInputElement).checked).toBe(true);
  });

  it('says under the chips what Anonymize PII masks and that emails and phones are neutralized unless kept', () => {
    // The PII banner said to anonymize "to protect sensitive data", as if
    // emails went out raw, when Keep, off by default, neutralizes them.
    renderToggles();

    const anonymizeHint = screen.getByTestId('forge-anonymize-hint');
    expect(anonymizeHint.textContent).toBe(
      'Anonymize PII masks names, addresses and other personal fields.',
    );
    expect(screen.getByTestId('forge-anonymize-toggle').getAttribute('aria-describedby')).toBe(
      anonymizeHint.id,
    );
    const contactPoints = screen.getByTestId('forge-contact-points-default');
    expect(contactPoints.textContent).toBe(
      'Emails and phone numbers are neutralized (.invalid, fictional numbers) unless you tick Keep emails and phone numbers as they are.',
    );
    expect(
      screen.getByTestId('forge-keep-contact-points-toggle').getAttribute('aria-describedby'),
    ).toBe(contactPoints.id);
  });
});
