import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { FieldMappingCanvas } from './FieldMappingCanvas';
import type { FieldInfo } from './FieldMappingCanvas';
import type { FieldMapping } from '@sandforge/shared';

const sourceFields: FieldInfo[] = [
  { apiName: 'Name', label: 'Name', type: 'String' },
  { apiName: 'Email', label: 'Email', type: 'Email' },
  { apiName: 'Phone', label: 'Phone', type: 'Phone' },
];

const targetFields: FieldInfo[] = [
  { apiName: 'Name', label: 'Name', type: 'String' },
  { apiName: 'Email__c', label: 'Email', type: 'String' },
  { apiName: 'Phone__c', label: 'Phone', type: 'String' },
];

const mappings: FieldMapping[] = [
  { sourceField: 'Name', targetField: 'Name', type: 'direct' },
];

describe('FieldMappingCanvas', () => {
  it('should render the canvas', () => {
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={mappings}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
      />,
    );
    expect(screen.getByTestId('field-mapping-canvas')).toBeDefined();
  });

  it('should show existing mappings', () => {
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={mappings}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mapping-0')).toBeDefined();
  });

  it('should call onRemoveMapping when remove is clicked', () => {
    const onRemove = vi.fn();
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={mappings}
        onAddMapping={vi.fn()}
        onRemoveMapping={onRemove}
        onChangeMappingType={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('remove-mapping-0'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('should show auto map button', () => {
    const onAutoMap = vi.fn();
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
        onAutoMap={onAutoMap}
      />,
    );
    fireEvent.click(screen.getByTestId('auto-map-btn'));
    expect(onAutoMap).toHaveBeenCalled();
  });

  it('should show mapping count', () => {
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={mappings}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
      />,
    );
    expect(screen.getByText('Field Mapping (1)')).toBeDefined();
  });

  it('should show unmapped text when no mappings', () => {
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
      />,
    );
    expect(screen.getByText('Unmapped')).toBeDefined();
  });

  it('should show add mapping row', () => {
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
      />,
    );
    expect(screen.getByTestId('add-mapping-row')).toBeDefined();
    expect(screen.getByTestId('add-mapping-btn')).toBeDefined();
  });

  it('should display arrows between mapped fields', () => {
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={mappings}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
      />,
    );
    const row = screen.getByTestId('mapping-0');
    expect(row.textContent).toContain('\u2192');
  });

  it('should display auto-map suggestions when provided', () => {
    const suggestions = [
      { sourceField: 'Email', targetField: 'Email__c', confidence: 0.9, reason: 'normalized_name' },
      { sourceField: 'Phone', targetField: 'Phone__c', confidence: 0.85, reason: 'label_match' },
    ];
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
        autoMapSuggestions={suggestions}
      />,
    );
    expect(screen.getByTestId('auto-map-suggestions')).toBeDefined();
    expect(screen.getByTestId('suggestion-0')).toBeDefined();
    expect(screen.getByTestId('suggestion-1')).toBeDefined();
  });

  it('should show confidence percentage in suggestions', () => {
    const suggestions = [
      { sourceField: 'Email', targetField: 'Email__c', confidence: 0.9, reason: 'normalized_name' },
    ];
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
        autoMapSuggestions={suggestions}
      />,
    );
    const suggestion = screen.getByTestId('suggestion-0');
    expect(suggestion.textContent).toContain('90%');
  });

  it('should not show unmapped text when suggestions exist', () => {
    const suggestions = [
      { sourceField: 'Email', targetField: 'Email__c', confidence: 0.9, reason: 'normalized_name' },
    ];
    render(
      <FieldMappingCanvas
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onAddMapping={vi.fn()}
        onRemoveMapping={vi.fn()}
        onChangeMappingType={vi.fn()}
        autoMapSuggestions={suggestions}
      />,
    );
    expect(screen.queryByText('Unmapped')).toBeNull();
  });
});
