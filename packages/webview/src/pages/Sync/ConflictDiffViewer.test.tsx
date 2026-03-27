import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ConflictDiffViewer } from './ConflictDiffViewer';
import type { UIConflict } from '@sandforge/shared';

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
  useVSCodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** Create a mock UIConflict for diff viewing. */
function makeDiffConflict(opts?: Partial<UIConflict>): UIConflict {
  return {
    id: 'Account:001:1',
    objectApiName: 'Account',
    recordId: '001',
    conflictType: 'edit/edit',
    sourceValues: { Name: 'Source Corp', Industry: 'Tech', Phone: '123' },
    targetValues: { Name: 'Target Corp', Industry: 'Finance', Phone: '123' },
    conflictFields: ['Name', 'Industry'],
    timestamp: '2026-03-27T00:00:00Z',
    resolved: false,
    ...opts,
  };
}

describe('ConflictDiffViewer', () => {
  it('should render field diffs with highlighting', () => {
    const conflict = makeDiffConflict();
    render(<ConflictDiffViewer conflict={conflict} />);

    expect(screen.getByTestId('conflict-diff-viewer')).toBeDefined();
    expect(screen.getByTestId('diff-table')).toBeDefined();

    // Conflict fields should have data-conflict="true"
    const nameRow = screen.getByTestId('diff-row-Name');
    expect(nameRow.getAttribute('data-conflict')).toBe('true');

    const industryRow = screen.getByTestId('diff-row-Industry');
    expect(industryRow.getAttribute('data-conflict')).toBe('true');
  });

  it('should show non-conflict fields without warning styling', () => {
    const conflict = makeDiffConflict();
    render(<ConflictDiffViewer conflict={conflict} />);

    const phoneRow = screen.getByTestId('diff-row-Phone');
    expect(phoneRow.getAttribute('data-conflict')).toBe('false');
  });

  it('should show base value column when baseValues present', () => {
    const conflict = makeDiffConflict({
      baseValues: { Name: 'Base Corp', Industry: 'Original', Phone: '123' },
    });
    render(<ConflictDiffViewer conflict={conflict} />);

    expect(screen.getByTestId('base-column-header')).toBeDefined();
  });

  it('should hide base column when baseValues not present', () => {
    const conflict = makeDiffConflict();
    render(<ConflictDiffViewer conflict={conflict} />);

    expect(screen.queryByTestId('base-column-header')).toBeNull();
  });

  it('should show auto-resolved section for three-way diff', () => {
    const conflict = makeDiffConflict({
      sourceValues: { Name: 'Source Corp', Industry: 'Tech', Phone: '456' },
      targetValues: { Name: 'Target Corp', Industry: 'Tech', Phone: '123' },
      baseValues: { Name: 'Base Corp', Industry: 'Tech', Phone: '123' },
      conflictFields: ['Name'],
    });
    render(<ConflictDiffViewer conflict={conflict} />);

    // Phone changed only in source, auto-resolved
    expect(screen.getByTestId('auto-resolved-section')).toBeDefined();
  });
});
