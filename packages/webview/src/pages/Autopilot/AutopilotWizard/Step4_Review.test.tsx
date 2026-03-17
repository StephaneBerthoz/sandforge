import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { Step4Review } from './Step4_Review';

const defaultProps = {
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  selectedObjects: ['Account', 'Contact', 'Opportunity'],
  totalRecords: 20700,
  estimatedApiCalls: 414,
  estimatedDurationMin: 5,
  complianceFramework: 'gdpr' as const,
  isExecuting: false,
  onExecute: vi.fn(),
};

describe('Step4_Review', () => {
  it('should render without crashing', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('step4-review')).toBeDefined();
  });

  it('should display stat cards', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('stat-objects')).toBeDefined();
    expect(screen.getByTestId('stat-records')).toBeDefined();
    expect(screen.getByTestId('stat-duration')).toBeDefined();
    expect(screen.getByTestId('stat-api-calls')).toBeDefined();
    expect(screen.getByTestId('stat-compliance')).toBeDefined();
  });

  it('should show object count', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('stat-objects').textContent).toContain('3');
  });

  it('should show compliance framework', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('stat-compliance').textContent).toContain('GDPR');
  });

  it('should show selected objects as badges', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
    expect(screen.getByText('Opportunity')).toBeDefined();
  });

  it('should show execute button', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('execute-button')).toBeDefined();
  });

  it('should call onExecute when execute button clicked', () => {
    const onExecute = vi.fn();
    render(<Step4Review {...defaultProps} onExecute={onExecute} />);
    fireEvent.click(screen.getByTestId('execute-button'));
    expect(onExecute).toHaveBeenCalled();
  });

  it('should disable execute button when executing', () => {
    render(<Step4Review {...defaultProps} isExecuting />);
    expect(screen.getByTestId('execute-button')).toHaveProperty('disabled', true);
  });
});
