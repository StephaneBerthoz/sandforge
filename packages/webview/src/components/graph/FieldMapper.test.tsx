import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { FieldMapper } from './FieldMapper';
import type { FieldMapping } from './FieldMapper';

const sourceFields = ['Name', 'Email', 'Phone'];
const targetFields = ['Name', 'Email__c', 'Phone__c'];

const existingMappings: FieldMapping[] = [{ sourceField: 'Name', targetField: 'Name' }];

describe('FieldMapper', () => {
  it('should render source and target fields', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onMappingChange={onChange}
      />,
    );
    expect(screen.getByTestId('field-mapper')).toBeDefined();
    expect(screen.getByTestId('field-source-Name')).toBeDefined();
    expect(screen.getByTestId('field-source-Email')).toBeDefined();
    expect(screen.getByTestId('field-source-Phone')).toBeDefined();
    expect(screen.getByTestId('field-target-Name')).toBeDefined();
    expect(screen.getByTestId('field-target-Email__c')).toBeDefined();
    expect(screen.getByTestId('field-target-Phone__c')).toBeDefined();
  });

  it('should create a mapping on source + target click', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onMappingChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId('field-source-Email'));
    fireEvent.click(screen.getByTestId('field-target-Email__c'));

    expect(onChange).toHaveBeenCalledWith([{ sourceField: 'Email', targetField: 'Email__c' }]);
  });

  it('should remove a mapping when clicking the connection path', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={existingMappings}
        onMappingChange={onChange}
      />,
    );

    const path = screen.getByTestId('field-mapper-path-Name-Name');
    fireEvent.click(path);

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('should call onAutoMatch when auto match button is clicked', () => {
    const onAutoMatch = vi.fn();
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onMappingChange={onChange}
        onAutoMatch={onAutoMatch}
      />,
    );

    fireEvent.click(screen.getByTestId('auto-match-btn'));
    expect(onAutoMatch).toHaveBeenCalled();
  });

  it('should not show auto match button when onAutoMatch is not provided', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onMappingChange={onChange}
      />,
    );

    expect(screen.queryByTestId('auto-match-btn')).toBeNull();
  });

  it('should render SVG paths for existing mappings', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={existingMappings}
        onMappingChange={onChange}
      />,
    );

    expect(screen.getByTestId('field-mapper-path-Name-Name')).toBeDefined();
    expect(screen.getByTestId('field-mapper-svg')).toBeDefined();
  });

  it('should display mapping count in header', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={existingMappings}
        onMappingChange={onChange}
      />,
    );

    expect(screen.getByText('Field Mapping (1)')).toBeDefined();
  });

  it('should show hint text when no mappings exist', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onMappingChange={onChange}
      />,
    );

    expect(
      screen.getByText('Click a source field, then a target field to create a mapping'),
    ).toBeDefined();
  });

  it('should not allow already-mapped source fields to be selected', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={existingMappings}
        onMappingChange={onChange}
      />,
    );

    const sourceBtn = screen.getByTestId('field-source-Name');
    expect(sourceBtn).toHaveProperty('disabled', true);
  });

  it('should not allow already-mapped target fields to be clicked', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={existingMappings}
        onMappingChange={onChange}
      />,
    );

    const targetBtn = screen.getByTestId('field-target-Name');
    expect(targetBtn).toHaveProperty('disabled', true);
  });

  it('should deselect source on second click', () => {
    const onChange = vi.fn();
    render(
      <FieldMapper
        sourceFields={sourceFields}
        targetFields={targetFields}
        mappings={[]}
        onMappingChange={onChange}
      />,
    );

    // Select then deselect
    fireEvent.click(screen.getByTestId('field-source-Email'));
    fireEvent.click(screen.getByTestId('field-source-Email'));

    // Now clicking a target should not create a mapping
    fireEvent.click(screen.getByTestId('field-target-Email__c'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
