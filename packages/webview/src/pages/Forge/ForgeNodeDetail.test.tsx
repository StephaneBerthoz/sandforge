import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import i18n from '../../i18n';
import ja from '../../i18n/locales/ja.json';
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
    // In words: the badge printed the code itself, in every language.
    expect(badge.textContent).toBe('Running');
  });

  it('names the status in the language the panel is set to', async () => {
    i18n.addResourceBundle('ja', 'translation', ja, true, true);
    await i18n.changeLanguage('ja');
    try {
      render(
        <ForgeNodeDetail
          node={makeNode({ status: 'skipped' })}
          onToggleIncluded={vi.fn()}
          onToggleAnonymize={vi.fn()}
        />,
      );
      expect(screen.getByTestId('node-status-badge').textContent).toBe(ja.forge.nodeStatus.skipped);
    } finally {
      await i18n.changeLanguage('en');
    }
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
    expect(fieldCountEl.textContent).toBe('25 fields');
    expect(fieldCountEl.textContent).not.toContain('Object');
  });

  it('writes one record and one field in the singular', () => {
    // "1 Records · 1 Fields": the count and its noun were written apart.
    render(
      <ForgeNodeDetail
        node={makeNode({ recordCount: 1, fieldCount: 1 })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    expect(screen.getByTestId('node-record-count').textContent).toBe('1 record');
    expect(screen.getByTestId('node-field-count').textContent).toBe('1 field');
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
    expect(within(list).getByText('Email')).toBeDefined();
    expect(within(list).getByText('Phone')).toBeDefined();
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
      <ForgeNodeDetail node={makeNode()} onToggleIncluded={onToggle} onToggleAnonymize={vi.fn()} />,
    );
    const toggle = screen.getByTestId('node-include-toggle');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  /** What the preview says the run writes in one field: its sample, then what replaces it. */
  const previewOf = (field: string): string[] =>
    [...screen.getByTestId(`anonymization-preview-${field}`).querySelectorAll('td')].map(
      (cell) => cell.textContent ?? '',
    );

  it('shows what an anonymizing run writes: an address under .invalid, a number of the fictional range', () => {
    // It showed u***@***.com and +1-***-****, which no run writes.
    render(
      <ForgeNodeDetail
        node={makeNode({
          piiFields: ['Email', 'Phone', 'SSN'],
          anonymizeFields: ['Email', 'Phone', 'SSN'],
        })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
        anonymize
      />,
    );

    expect(screen.getByTestId('anonymization-preview-title').textContent).toBe(
      'Anonymization Preview',
    );
    expect(previewOf('Email')).toEqual([
      'Email',
      'john.doe@acme.com',
      'alex.smith@example.invalid',
    ]);
    expect(previewOf('Phone')[2]).toMatch(/^\+3363998\d{4}$/);
    expect(previewOf('SSN')[2]).toBe('[REDACTED]');
    expect(screen.getByTestId('anonymization-preview').textContent).not.toContain('***');
  });

  it('shows the emails and phone numbers every run neutralizes, with anonymization off', () => {
    // Nothing was shown with anonymization off, when every address and number
    // is changed all the same; a box ticked on a field anonymizes nothing then.
    render(
      <ForgeNodeDetail
        node={makeNode({
          piiFields: ['Email', 'MobilePhone', 'FirstName'],
          anonymizeFields: ['Email', 'FirstName'],
        })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );

    expect(screen.getByTestId('anonymization-preview-title').textContent).toBe(
      'Emails and phone numbers, as the run writes them',
    );
    expect(previewOf('Email')).toEqual(['Email', 'john.doe@acme.com', 'john.doe@acme.com.invalid']);
    expect(previewOf('MobilePhone')[2]).toMatch(/^\+3363998\d{4}$/);
    // A name is written as the source holds it when the run does not anonymize.
    expect(screen.queryByTestId('anonymization-preview-FirstName')).toBeNull();
  });

  it('neutralizes a phone number an anonymizing run leaves unselected', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ piiFields: ['FirstName', 'HomePhone'], anonymizeFields: ['FirstName'] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
        anonymize
      />,
    );

    expect(previewOf('FirstName')).toEqual(['FirstName', 'John', 'Alex']);
    expect(previewOf('HomePhone')[2]).toMatch(/^\+3363998\d{4}$/);
  });

  it('shows no preview of the fields the run writes as the source holds them', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ piiFields: ['Email', 'FirstName'], anonymizeFields: ['Email'] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
        keepContactPoints
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

  /* ---- Legible on light themes too: theme tokens, not fixed light shades ---- */
  it('writes the skipped status badge in the editor foreground', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ status: 'skipped' })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const badge = screen.getByTestId('node-status-badge');
    expect(badge.className).toContain('text-text-primary');
    expect(badge.className).not.toMatch(/\btext-gray-\d+\b/);
  });

  it('writes the status of a node a cancel stopped in the warning token', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ status: 'stopped' })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const badge = screen.getByTestId('node-status-badge');
    expect(badge.textContent).toBe('Stopped');
    expect(badge.className).toContain('text-status-warning');
  });

  it('writes each error in the error token', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'] })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const item = screen.getByText('FIELD_CUSTOM_VALIDATION_EXCEPTION').closest('li');
    expect(item?.className).toContain('text-status-error');
    expect(item?.className).not.toMatch(/\btext-red-\d+\b/);
  });
});
