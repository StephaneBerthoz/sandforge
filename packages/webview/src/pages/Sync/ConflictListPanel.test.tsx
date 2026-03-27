import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ConflictListPanel } from './ConflictListPanel';
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
function makeMockConflict(index: number, opts?: Partial<UIConflict>): UIConflict {
  return {
    id: `Account:001${String(index).padStart(15, '0')}:${index}`,
    objectApiName: 'Account',
    recordId: `001${String(index).padStart(15, '0')}`,
    conflictType: 'edit/edit',
    sourceValues: { Name: `Source ${index}` },
    targetValues: { Name: `Target ${index}` },
    conflictFields: ['Name'],
    timestamp: `2026-03-27T00:00:${String(index % 60).padStart(2, '0')}Z`,
    resolved: false,
    ...opts,
  };
}

describe('ConflictListPanel', () => {
  beforeEach(() => {
    useConflictStore.setState({
      conflicts: [],
      selectedConflictId: null,
      filterObject: null,
      filterType: null,
    });
    mockPostMessage.mockClear();
  });

  it('should render empty state when no conflicts', () => {
    render(<ConflictListPanel />);
    expect(screen.getByText('No conflicts detected')).toBeDefined();
  });

  it('should render list of conflicts with correct columns', () => {
    const conflicts = [makeMockConflict(1), makeMockConflict(2)];
    useConflictStore.setState({ conflicts });

    render(<ConflictListPanel />);
    expect(screen.getByTestId('conflict-list-panel')).toBeDefined();
    expect(screen.getByTestId('data-table')).toBeDefined();
  });

  it('should filter by object when dropdown changes', () => {
    const conflicts = [
      makeMockConflict(1, { objectApiName: 'Account' }),
      makeMockConflict(2, { objectApiName: 'Contact' }),
    ];
    useConflictStore.setState({ conflicts });

    render(<ConflictListPanel />);
    const objectFilter = screen.getByTestId('filter-object');
    fireEvent.change(objectFilter, { target: { value: 'Account' } });

    expect(useConflictStore.getState().filterObject).toBe('Account');
  });

  it('should select a conflict when row is clicked', () => {
    const conflicts = [makeMockConflict(1)];
    useConflictStore.setState({ conflicts });

    render(<ConflictListPanel />);
    const row = screen.getByTestId('table-row-0');
    fireEvent.click(row);

    expect(useConflictStore.getState().selectedConflictId).toBe(conflicts[0].id);
  });

  it('should show pagination when enough conflicts', () => {
    const conflicts: UIConflict[] = [];
    for (let i = 1; i <= 25; i++) {
      conflicts.push(makeMockConflict(i));
    }
    useConflictStore.setState({ conflicts });

    render(<ConflictListPanel />);
    expect(screen.getByTestId('pagination-summary')).toBeDefined();
  });

  it('should call clearResolved when clear button is clicked', () => {
    const conflicts = [
      makeMockConflict(1, { resolved: true, resolution: 'source_wins' }),
      makeMockConflict(2),
    ];
    useConflictStore.setState({ conflicts });

    render(<ConflictListPanel />);
    const clearBtn = screen.getByTestId('clear-resolved-btn');
    fireEvent.click(clearBtn);

    expect(useConflictStore.getState().conflicts).toHaveLength(1);
    expect(useConflictStore.getState().conflicts[0].resolved).toBe(false);
  });
});
