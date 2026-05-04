import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { Step4ConfigureRelations } from './Step4_ConfigureRelations';
import type { SeedRelation } from './Step4_ConfigureRelations';
import type { ObjectNode, ERDEdge } from '@sandforge/shared';

const relations: SeedRelation[] = [
  { childObject: 'Contact', childField: 'AccountId', parentObject: 'Account', parentField: 'Id' },
];

const erdNodes: ObjectNode[] = [
  { apiName: 'Account', label: 'Account', recordCount: 500, fields: [], relationships: [] },
  {
    apiName: 'Contact',
    label: 'Contact',
    recordCount: 1200,
    fields: [],
    relationships: [
      { fieldName: 'AccountId', targetObject: 'Account', type: 'Lookup', required: false },
    ],
  },
];

const erdEdges: ERDEdge[] = [
  { source: 'Contact', target: 'Account', field: 'AccountId', type: 'Lookup' },
];

describe('Step4ConfigureRelations', () => {
  it('should render the step', () => {
    render(
      <Step4ConfigureRelations
        relations={relations}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
      />,
    );
    expect(screen.getByTestId('step-configure-relations')).toBeDefined();
  });

  it('should render existing relations', () => {
    render(
      <Step4ConfigureRelations
        relations={relations}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
      />,
    );
    expect(screen.getByTestId('relation-0')).toBeDefined();
  });

  it('should call onAddRelation when add button is clicked', () => {
    const onAdd = vi.fn();
    render(
      <Step4ConfigureRelations
        relations={relations}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={onAdd}
        onRemoveRelation={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('add-relation-btn'));
    expect(onAdd).toHaveBeenCalled();
  });

  it('should call onRemoveRelation when remove button is clicked', () => {
    const onRemove = vi.fn();
    render(
      <Step4ConfigureRelations
        relations={relations}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={onRemove}
      />,
    );
    fireEvent.click(screen.getByTestId('remove-relation-0'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('should show empty state when no relations and no ERD nodes', () => {
    render(
      <Step4ConfigureRelations
        relations={[]}
        availableObjects={['Account']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
      />,
    );
    expect(screen.getByText('No dependencies')).toBeDefined();
  });

  it('should display arrow badge between objects', () => {
    render(
      <Step4ConfigureRelations
        relations={relations}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
      />,
    );
    const relationRow = screen.getByTestId('relation-0');
    expect(relationRow.textContent).toContain('\u2192');
  });

  it('should render ERD mini-map when erdNodes are provided', () => {
    render(
      <Step4ConfigureRelations
        relations={[]}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
        erdNodes={erdNodes}
        erdEdges={erdEdges}
        insertionOrder={['Account', 'Contact']}
        selectedObjects={['Account', 'Contact']}
      />,
    );
    expect(screen.getByTestId('erd-section')).toBeDefined();
    expect(screen.getByTestId('erd-minimap')).toBeDefined();
  });

  it('should render ERD legend', () => {
    render(
      <Step4ConfigureRelations
        relations={[]}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
        erdNodes={erdNodes}
        erdEdges={erdEdges}
        insertionOrder={['Account', 'Contact']}
        selectedObjects={['Account', 'Contact']}
      />,
    );
    expect(screen.getByTestId('erd-legend')).toBeDefined();
    expect(screen.getByText('Lookup')).toBeDefined();
    expect(screen.getByText('Master-Detail')).toBeDefined();
  });

  it('should render insertion order items', () => {
    render(
      <Step4ConfigureRelations
        relations={[]}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
        erdNodes={erdNodes}
        erdEdges={erdEdges}
        insertionOrder={['Account', 'Contact']}
        selectedObjects={['Account', 'Contact']}
      />,
    );
    expect(screen.getByTestId('insertion-order')).toBeDefined();
    expect(screen.getByTestId('order-item-Account')).toBeDefined();
    expect(screen.getByTestId('order-item-Contact')).toBeDefined();
  });

  it('should show auto label for non-selected objects in insertion order', () => {
    render(
      <Step4ConfigureRelations
        relations={[]}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
        erdNodes={erdNodes}
        erdEdges={erdEdges}
        insertionOrder={['Account', 'Contact']}
        selectedObjects={['Contact']}
      />,
    );
    const accountItem = screen.getByTestId('order-item-Account');
    expect(accountItem.textContent).toContain('auto');
  });

  it('should render ERD warnings', () => {
    render(
      <Step4ConfigureRelations
        relations={[]}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
        erdNodes={erdNodes}
        erdEdges={erdEdges}
        insertionOrder={['Account', 'Contact']}
        selectedObjects={['Account', 'Contact']}
        erdWarnings={['Circular dependency detected: Account → Contact']}
      />,
    );
    expect(screen.getByTestId('erd-warnings')).toBeDefined();
    expect(screen.getByTestId('erd-warning-0')).toBeDefined();
  });

  it('should call onERDNodeClick when ERD node is clicked', () => {
    const onClick = vi.fn();
    render(
      <Step4ConfigureRelations
        relations={[]}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
        erdNodes={erdNodes}
        erdEdges={erdEdges}
        insertionOrder={['Account', 'Contact']}
        selectedObjects={['Account', 'Contact']}
        onERDNodeClick={onClick}
      />,
    );
    fireEvent.click(screen.getByTestId('erd-node-Account'));
    expect(onClick).toHaveBeenCalledWith('Account');
  });

  it('should not show empty state when ERD nodes are provided but relations are empty', () => {
    render(
      <Step4ConfigureRelations
        relations={[]}
        availableObjects={['Account', 'Contact']}
        onChangeRelation={vi.fn()}
        onAddRelation={vi.fn()}
        onRemoveRelation={vi.fn()}
        erdNodes={erdNodes}
        erdEdges={erdEdges}
        insertionOrder={['Account', 'Contact']}
        selectedObjects={['Account', 'Contact']}
      />,
    );
    expect(screen.queryByText('No dependencies')).toBeNull();
  });
});
