import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { CheckpointsLink } from './CheckpointsLink';

describe('CheckpointsLink', () => {
  it('says where it goes back to, in the name of the page, and goes there', () => {
    const onClick = vi.fn();
    render(<CheckpointsLink onClick={onClick} testId="back" />);
    const link = screen.getByTestId('back');
    expect(link).toHaveAccessibleName('Checkpoints');
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('stays focusable and goes nowhere while a run keeps the view', () => {
    const onClick = vi.fn();
    render(<CheckpointsLink onClick={onClick} disabled testId="back" />);
    const link = screen.getByTestId('back');
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).not.toHaveAttribute('disabled');
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('names the page in the panel’s language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(() => i18n.changeLanguage('fr'));
    try {
      render(<CheckpointsLink onClick={vi.fn()} testId="back" />);
      expect(screen.getByTestId('back')).toHaveAccessibleName('Points de contrôle');
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });
});
