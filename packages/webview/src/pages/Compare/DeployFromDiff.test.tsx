import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { DeploymentSuggestion } from '@sandforge/shared';
import { DeployFromDiff } from './DeployFromDiff';

const mockSuggestion: DeploymentSuggestion = {
  components: [
    {
      componentType: 'ApexClass',
      fullName: 'AccountController',
      action: 'deploy',
      reason: 'Modified',
    },
    {
      componentType: 'CustomField',
      fullName: 'Account.NewField__c',
      action: 'deploy',
      reason: 'Added',
    },
    { componentType: 'Flow', fullName: 'OldFlow', action: 'skip', reason: 'Risky' },
  ],
  estimatedDuration: 30000,
  risks: [{ component: 'AccountController', risk: 'medium', description: 'Has active triggers' }],
  order: ['AccountController', 'Account.NewField__c'],
};

describe('DeployFromDiff', () => {
  it('should render the deploy card', () => {
    render(<DeployFromDiff suggestion={mockSuggestion} />);
    expect(screen.getByText('Deploy from Diff')).toBeDefined();
  });

  it('should show deploy count in button', () => {
    render(<DeployFromDiff suggestion={mockSuggestion} onDeploy={vi.fn()} />);
    expect(screen.getByTestId('deploy-btn')).toBeDefined();
    expect(screen.getByText(/Build Deployment \(2\)/)).toBeDefined();
  });

  it('should render all components', () => {
    render(<DeployFromDiff suggestion={mockSuggestion} />);
    expect(screen.getByTestId('deploy-comp-AccountController')).toBeDefined();
    expect(screen.getByTestId('deploy-comp-Account.NewField__c')).toBeDefined();
    expect(screen.getByTestId('deploy-comp-OldFlow')).toBeDefined();
  });

  it('should show action badges', () => {
    render(<DeployFromDiff suggestion={mockSuggestion} />);
    const deployBadges = screen.getAllByText('deploy');
    expect(deployBadges.length).toBe(2);
    expect(screen.getByText('skip')).toBeDefined();
  });

  it('should show estimated duration', () => {
    render(<DeployFromDiff suggestion={mockSuggestion} />);
    expect(screen.getByText(/30s/)).toBeDefined();
  });

  it('should show risks', () => {
    render(<DeployFromDiff suggestion={mockSuggestion} />);
    expect(screen.getByTestId('deploy-risks')).toBeDefined();
    expect(screen.getByText(/Has active triggers/)).toBeDefined();
  });

  it('should call onToggleComponent when clicking a component', () => {
    const handler = vi.fn();
    render(<DeployFromDiff suggestion={mockSuggestion} onToggleComponent={handler} />);
    fireEvent.click(screen.getByTestId('deploy-comp-OldFlow'));
    expect(handler).toHaveBeenCalledWith('OldFlow');
  });

  it('should call onDeploy when deploy button clicked', () => {
    const handler = vi.fn();
    render(<DeployFromDiff suggestion={mockSuggestion} onDeploy={handler} />);
    fireEvent.click(screen.getByTestId('deploy-btn'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should show no data when no suggestion', () => {
    render(<DeployFromDiff />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should accept custom className', () => {
    const { container } = render(<DeployFromDiff suggestion={mockSuggestion} className="custom" />);
    expect((container.firstChild as HTMLElement).className).toContain('custom');
  });
});
