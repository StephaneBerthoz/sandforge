import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GuidedFirstStepCard } from './GuidedFirstStepCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

describe('GuidedFirstStepCard', () => {
  const defaultProps = {
    icon: 'sync',
    titleKey: 'onboarding.syncFirstStepTitle',
    descKey: 'onboarding.syncFirstStepDesc',
    actionKey: 'onboarding.startQuickSync',
    onAction: vi.fn(),
    variant: 'sync' as const,
  };

  it('should render with title, description, and action', () => {
    render(<GuidedFirstStepCard {...defaultProps} />);
    expect(screen.getByTestId('guided-first-step-card')).toBeDefined();
    expect(screen.getByText('onboarding.syncFirstStepTitle')).toBeDefined();
    expect(screen.getByText('onboarding.syncFirstStepDesc')).toBeDefined();
    expect(screen.getByText('onboarding.startQuickSync')).toBeDefined();
  });

  it('should call onAction when button is clicked', () => {
    const onAction = vi.fn();
    render(<GuidedFirstStepCard {...defaultProps} onAction={onAction} />);
    fireEvent.click(screen.getByTestId('guided-first-step-action'));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('should render seed variant with green border', () => {
    render(<GuidedFirstStepCard {...defaultProps} variant="seed" />);
    const card = screen.getByTestId('guided-first-step-card');
    expect(card.className).toContain('border-l-green-500');
  });

  it('should render sync variant with blue border', () => {
    render(<GuidedFirstStepCard {...defaultProps} variant="sync" />);
    const card = screen.getByTestId('guided-first-step-card');
    expect(card.className).toContain('border-l-blue-500');
  });
});
