import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { Step5SetVolumes } from './Step5_SetVolumes';
import type { ObjectVolume } from './Step5_SetVolumes';

const volumes: ObjectVolume[] = [
  { objectApiName: 'Account', label: 'Account', recordCount: 500, batchSize: 200 },
  { objectApiName: 'Contact', label: 'Contact', recordCount: 1000, batchSize: 200 },
];

describe('Step5SetVolumes', () => {
  it('should render the step', () => {
    render(
      <Step5SetVolumes volumes={volumes} onChangeCount={vi.fn()} onChangeBatchSize={vi.fn()} />,
    );
    expect(screen.getByTestId('step-set-volumes')).toBeDefined();
  });

  it('should display total records', () => {
    render(
      <Step5SetVolumes volumes={volumes} onChangeCount={vi.fn()} onChangeBatchSize={vi.fn()} />,
    );
    expect(screen.getByTestId('total-records').textContent).toContain('1500');
  });

  it('should display count inputs', () => {
    render(
      <Step5SetVolumes volumes={volumes} onChangeCount={vi.fn()} onChangeBatchSize={vi.fn()} />,
    );
    expect(screen.getByTestId('count-Account')).toBeDefined();
    expect(screen.getByTestId('count-Contact')).toBeDefined();
  });

  it('should display batch size inputs', () => {
    render(
      <Step5SetVolumes volumes={volumes} onChangeCount={vi.fn()} onChangeBatchSize={vi.fn()} />,
    );
    expect(screen.getByTestId('batch-Account')).toBeDefined();
    expect(screen.getByTestId('batch-Contact')).toBeDefined();
  });

  it('should call onChangeCount when count changes', () => {
    const onChange = vi.fn();
    render(
      <Step5SetVolumes volumes={volumes} onChangeCount={onChange} onChangeBatchSize={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('count-Account'), { target: { value: '1000' } });
    expect(onChange).toHaveBeenCalledWith('Account', 1000);
  });

  it('should call onChangeBatchSize when batch size changes', () => {
    const onChange = vi.fn();
    render(
      <Step5SetVolumes volumes={volumes} onChangeCount={vi.fn()} onChangeBatchSize={onChange} />,
    );
    fireEvent.change(screen.getByTestId('batch-Account'), { target: { value: '500' } });
    expect(onChange).toHaveBeenCalledWith('Account', 500);
  });

  it('should show object labels', () => {
    render(
      <Step5SetVolumes volumes={volumes} onChangeCount={vi.fn()} onChangeBatchSize={vi.fn()} />,
    );
    expect(screen.getByText('Account (Account)')).toBeDefined();
    expect(screen.getByText('Contact (Contact)')).toBeDefined();
  });
});
