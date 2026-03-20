import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ForgeNodeDetail } from './ForgeNodeDetail';
import type { ForgeGraphNode } from '../../stores/useForgeStore';

/** Factory to create a test node with sane defaults. */
function makeNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: 'Account',
    recordCount: 150,
    fieldCount: 25,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

describe('ForgeNodeDetail', () => {
  it('should render the node object name', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ objectApiName: 'Contact' })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    expect(screen.getByText('Contact')).toBeDefined();
  });

  it('should display the status badge', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ status: 'running' })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const badge = screen.getByTestId('node-status-badge');
    expect(badge.textContent).toBe('running');
  });

  it('should display record count', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ recordCount: 42 })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    expect(screen.getByTestId('node-record-count').textContent).toContain('42');
  });

  it('should display field count with Fields label, not Object', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ fieldCount: 25 })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const fieldCountEl = screen.getByTestId('node-field-count');
    expect(fieldCountEl.textContent).toContain('25');
    expect(fieldCountEl.textContent).toContain('Fields');
    expect(fieldCountEl.textContent).not.toContain('Object');
  });

  it('should show PII fields when present', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ piiFields: ['Email', 'Phone'] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const list = screen.getByTestId('pii-fields-list');
    expect(list).toBeDefined();
    expect(screen.getByText('Email')).toBeDefined();
    expect(screen.getByText('Phone')).toBeDefined();
  });

  it('should not show PII section when no PII fields', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ piiFields: [] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('pii-fields-list')).toBeNull();
  });

  it('should call onToggleAnonymize when checkbox is clicked', () => {
    const onToggle = vi.fn();
    render(
      <ForgeNodeDetail
        node={makeNode({ piiFields: ['Email'], anonymizeFields: [] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={onToggle}
      />,
    );
    const checkbox = screen.getByTestId('anonymize-toggle-Email');
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith('Email');
  });

  it('should call onToggleIncluded when include toggle is clicked', () => {
    const onToggle = vi.fn();
    render(
      <ForgeNodeDetail
        node={makeNode()}
        onToggleIncluded={onToggle}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId('node-include-toggle');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('should show anonymization preview when anonymizeFields has entries', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ piiFields: ['Email'], anonymizeFields: ['Email'] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    expect(screen.getByTestId('anonymization-preview')).toBeDefined();
  });

  it('should not show anonymization preview when no fields are anonymized', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ piiFields: ['Email'], anonymizeFields: [] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('anonymization-preview')).toBeNull();
  });

  it('should show errors when present', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const list = screen.getByTestId('node-errors-list');
    expect(list).toBeDefined();
    expect(screen.getByText('FIELD_CUSTOM_VALIDATION_EXCEPTION')).toBeDefined();
  });

  it('should not show errors section when errors array is empty', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ errors: [] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('node-errors-list')).toBeNull();
  });

  /* ---- A11Y-07: Contrast fix for skipped status ---- */
  it('should use text-gray-400 for skipped status badge', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ status: 'skipped' })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const badge = screen.getByTestId('node-status-badge');
    expect(badge.className).toContain('text-gray-400');
    expect(badge.className).not.toContain('text-gray-500');
  });
});
