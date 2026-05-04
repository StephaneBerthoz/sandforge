import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { Step3Compliance } from './Step3_Compliance';

describe('Step3_Compliance', () => {
  it('should render without crashing', () => {
    render(<Step3Compliance selectedFramework="none" onSelect={vi.fn()} />);
    expect(screen.getByTestId('step3-compliance')).toBeDefined();
  });

  it('should display all framework options', () => {
    render(<Step3Compliance selectedFramework="none" onSelect={vi.fn()} />);
    expect(screen.getByTestId('framework-none')).toBeDefined();
    expect(screen.getByTestId('framework-gdpr')).toBeDefined();
    expect(screen.getByTestId('framework-ccpa')).toBeDefined();
    expect(screen.getByTestId('framework-hipaa')).toBeDefined();
    expect(screen.getByTestId('framework-pci_dss')).toBeDefined();
  });

  it('should call onSelect when framework is clicked', () => {
    const onSelect = vi.fn();
    render(<Step3Compliance selectedFramework="none" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('framework-gdpr'));
    expect(onSelect).toHaveBeenCalledWith('gdpr');
  });

  it('should show selected framework as checked', () => {
    render(<Step3Compliance selectedFramework="hipaa" onSelect={vi.fn()} />);
    const hipaaOption = screen.getByTestId('framework-hipaa');
    const radioInput = hipaaOption.querySelector('input[type="radio"]') as HTMLInputElement;
    expect(radioInput.checked).toBe(true);
  });
});
