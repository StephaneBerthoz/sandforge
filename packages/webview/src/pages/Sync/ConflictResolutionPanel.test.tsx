import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ConflictResolutionPanel } from './ConflictResolutionPanel';
import { useConflictStore } from '../../stores/useConflictStore';
import type { UIConflict } from '@sandforge/shared';

const mockPostMessage = vi.fn();

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** Create a mock UIConflict. */
function makeMockConflict(opts?: Partial<UIConflict>): UIConflict {
  return {
    id: 'Account:001:1',
    objectApiName: 'Account',
    recordId: '001',
    conflictType: 'edit/edit',
    sourceValues: { Name: 'Source Corp', Industry: 'Tech' },
    targetValues: { Name: 'Target Corp', Industry: 'Finance' },
    conflictFields: ['Name', 'Industry'],
    timestamp: '2026-03-27T00:00:00Z',
    resolved: false,
    ...opts,
  };
}

describe('ConflictResolutionPanel', () => {
  beforeEach(() => {
    useConflictStore.setState({
      conflicts: [makeMockConflict()],
      selectedConflictId: null,
      filterObject: null,
      filterType: null,
    });
    mockPostMessage.mockClear();
  });

  it('should render per-field resolution controls', () => {
    render(<ConflictResolutionPanel conflict={makeMockConflict()} />);

    expect(screen.getByTestId('conflict-resolution-panel')).toBeDefined();
    expect(screen.getByTestId('field-resolutions')).toBeDefined();
    expect(screen.getByTestId('field-resolution-Name')).toBeDefined();
    expect(screen.getByTestId('field-resolution-Industry')).toBeDefined();
  });

  it('should update local state when selecting source for a field', () => {
    render(<ConflictResolutionPanel conflict={makeMockConflict()} />);

    const pickSource = screen.getByTestId('pick-source-Name');
    fireEvent.click(pickSource);

    // The button should now have the selected styling (border-blue-500)
    expect(pickSource.className).toContain('border-blue-500');
  });

  it('should update local state when selecting target for a field', () => {
    render(<ConflictResolutionPanel conflict={makeMockConflict()} />);

    const pickTarget = screen.getByTestId('pick-target-Industry');
    fireEvent.click(pickTarget);

    expect(pickTarget.className).toContain('border-emerald-500');
  });

  it('should disable Apply button until all fields have a resolution', () => {
    render(<ConflictResolutionPanel conflict={makeMockConflict()} />);

    const applyBtn = screen.getByTestId('apply-resolution-btn');
    expect(applyBtn).toHaveProperty('disabled', true);

    // Resolve one field
    fireEvent.click(screen.getByTestId('pick-source-Name'));
    expect(applyBtn).toHaveProperty('disabled', true);

    // Resolve second field
    fireEvent.click(screen.getByTestId('pick-target-Industry'));
    expect(applyBtn).toHaveProperty('disabled', false);
  });

  it('should send resolve message when Apply is clicked with all fields resolved', () => {
    render(<ConflictResolutionPanel conflict={makeMockConflict()} />);

    fireEvent.click(screen.getByTestId('pick-source-Name'));
    fireEvent.click(screen.getByTestId('pick-target-Industry'));

    const applyBtn = screen.getByTestId('apply-resolution-btn');
    fireEvent.click(applyBtn);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const msg = mockPostMessage.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(msg.type).toBe('realtime:resolve-conflict');
    expect(msg.payload.conflictId).toBe('Account:001:1');
  });

  it('should show bulk source button that opens DangerConfirm', () => {
    render(<ConflictResolutionPanel conflict={makeMockConflict()} />);

    const bulkBtn = screen.getByTestId('bulk-source-btn');
    expect(bulkBtn).toBeDefined();
    fireEvent.click(bulkBtn);

    // DangerConfirm should appear
    expect(screen.getByTestId('danger-title')).toBeDefined();
  });

  it('should show bulk target button that opens DangerConfirm', () => {
    render(<ConflictResolutionPanel conflict={makeMockConflict()} />);

    const bulkBtn = screen.getByTestId('bulk-target-btn');
    expect(bulkBtn).toBeDefined();
    fireEvent.click(bulkBtn);

    expect(screen.getByTestId('danger-title')).toBeDefined();
  });

  it('should show read-only summary for resolved conflicts', () => {
    const resolved = makeMockConflict({
      resolved: true,
      resolution: 'manual',
      fieldResolutions: {
        Name: { value: 'Custom Name', source: 'manual' },
        Industry: { value: 'Tech', source: 'source' },
      },
    });

    render(<ConflictResolutionPanel conflict={resolved} />);

    expect(screen.getByTestId('resolved-summary')).toBeDefined();
    // Should not show field resolution controls
    expect(screen.queryByTestId('field-resolutions')).toBeNull();
  });

  it('should allow manual edit for a field', () => {
    render(<ConflictResolutionPanel conflict={makeMockConflict()} />);

    // Click manual edit for Name
    fireEvent.click(screen.getByTestId('pick-manual-Name'));

    // Should show input
    const input = screen.getByTestId('manual-input-Name');
    expect(input).toBeDefined();

    fireEvent.change(input, { target: { value: 'Custom Value' } });
    fireEvent.click(screen.getByTestId('manual-confirm-Name'));

    // Manual button should now show the custom value
    const manualBtn = screen.getByTestId('pick-manual-Name');
    expect(manualBtn.textContent).toBe('Custom Value');
  });
});
