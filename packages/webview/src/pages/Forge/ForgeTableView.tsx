import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../../theme';
import type { ForgeGraphNode, ForgeGraph } from '../../stores/useForgeStore';

/** Sortable column fields for the table. */
type SortField = 'objectApiName' | 'recordCount' | 'fieldCount' | 'status';

/** Sort direction. */
type SortDirection = 'asc' | 'desc';

/** Status badge color mapping. */
const statusColors: Record<string, string> = {
  idle: 'bg-gray-500/20 text-gray-400',
  running: 'bg-blue-500/20 text-blue-400',
  done: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  queued: 'bg-yellow-500/20 text-yellow-400',
  skipped: 'bg-gray-500/20 text-gray-500',
};

/**
 * Props for the ForgeTableView component.
 */
export interface ForgeTableViewProps {
  /** The full forge graph containing nodes to display. */
  graph: ForgeGraph;
  /** Currently selected node name, if any. */
  selectedNodeName: string | null;
  /** Callback when a row is clicked (selects the node). */
  onNodeClick: (objectName: string) => void;
  /** Callback to toggle a node's included state. */
  onToggleIncluded: (objectName: string) => void;
  /** Search query to filter rows. */
  searchQuery?: string;
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Table view of forge graph nodes with sortable columns and include toggles.
 * Provides an alternative to the LiveGraph for scanning large numbers of objects.
 */
export const ForgeTableView: React.FC<ForgeTableViewProps> = ({
  graph,
  selectedNodeName,
  onNodeClick,
  onToggleIncluded,
  searchQuery = '',
  className,
}) => {
  const { t } = useTranslation();
  const [sortField, setSortField] = useState<SortField>('objectApiName');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  /** Toggle sort on a column header click. */
  const handleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
    },
    [sortField],
  );

  /** Filtered and sorted nodes. */
  const sortedNodes = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const filtered = query
      ? graph.nodes.filter((n) => n.objectApiName.toLowerCase().includes(query))
      : graph.nodes;

    return [...filtered].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      const cmp =
        typeof aVal === 'string'
          ? aVal.localeCompare(bVal as string)
          : (aVal as number) - (bVal as number);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [graph.nodes, searchQuery, sortField, sortDirection]);

  /** Render a sort indicator for a column header. */
  const renderSortIndicator = (field: SortField): React.ReactNode => {
    if (sortField !== field) return null;
    return sortDirection === 'asc' ? (
      <ChevronUp size={12} className="inline ml-0.5" />
    ) : (
      <ChevronDown size={12} className="inline ml-0.5" />
    );
  };

  /** Render a sortable column header. */
  const renderHeader = (field: SortField, label: string): React.ReactNode => (
    <th
      data-testid={`forge-table-sort-${field}`}
      className="cursor-pointer select-none px-3 py-2 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
      onClick={() => handleSort(field)}
    >
      {label}
      {renderSortIndicator(field)}
    </th>
  );

  if (sortedNodes.length === 0 && searchQuery) {
    return (
      <div
        data-testid="forge-table-view"
        className={cn(
          'flex items-center justify-center p-8 text-sm text-text-secondary',
          className,
        )}
      >
        {t('forge.noMatchingNodes')}
      </div>
    );
  }

  return (
    <div data-testid="forge-table-view" className={cn('overflow-auto', className)}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface-1 border-b border-subtle">
          <tr>
            <th className="w-8 px-3 py-2" />
            {renderHeader('objectApiName', t('forge.object'))}
            {renderHeader('recordCount', t('forge.records'))}
            {renderHeader('fieldCount', t('forge.fields'))}
            {renderHeader('status', t('forge.status'))}
            <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">PII</th>
          </tr>
        </thead>
        <tbody>
          {sortedNodes.map((node: ForgeGraphNode) => (
            <tr
              key={node.objectApiName}
              data-testid="forge-table-row"
              className={cn(
                'cursor-pointer border-b border-subtle/50 transition-colors hover:bg-surface-2',
                selectedNodeName === node.objectApiName && 'bg-forge/10 border-l-2 border-forge',
              )}
              onClick={() => onNodeClick(node.objectApiName)}
            >
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  data-testid={`forge-table-include-${node.objectApiName}`}
                  checked={node.included}
                  onChange={() => onToggleIncluded(node.objectApiName)}
                  className="accent-forge"
                  onClick={(e) => e.stopPropagation()}
                />
              </td>
              <td className="px-3 py-2 font-medium text-text-primary">{node.objectApiName}</td>
              <td className="px-3 py-2 text-text-secondary">{node.recordCount}</td>
              <td className="px-3 py-2 text-text-secondary">{node.fieldCount}</td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                    statusColors[node.status] ?? statusColors.idle,
                  )}
                >
                  {node.status}
                </span>
              </td>
              <td className="px-3 py-2 text-text-secondary">
                {node.piiFields.length > 0 ? node.piiFields.length : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
