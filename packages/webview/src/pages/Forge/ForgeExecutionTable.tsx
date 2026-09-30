import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { StatusIcon } from '../../components/graph/ProgressNode';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeGraphNode } from '../../stores/useForgeStore';
import { cn } from '../../theme';
import { uiLocale } from '../../utils/formatters';
import { statusColors } from './ForgeTableView';

/** The names of a store that holds no graph. */
const NO_OBJECTS: readonly string[] = [];

/**
 * The objects of the run on screen, in the graph's order. A progress event
 * changes a node, never the names: the list it gives is equal to the last one
 * item by item, and the table is not drawn again for the event.
 */
function useRunObjects(): readonly string[] {
  return useForgeStore(
    useShallow((s) => s.graph?.nodes.map((node) => node.objectApiName) ?? NO_OBJECTS),
  );
}

/**
 * The node of `objectApiName`, followed on its own. An event gives the one
 * node it is about a new value and leaves every other node as it was, so the
 * row of that node alone is drawn again. Looked up at its place in the graph
 * first, which a run does not change.
 */
function useRunNode(objectApiName: string, index: number): ForgeGraphNode | undefined {
  return useForgeStore((s) => {
    const nodes = s.graph?.nodes;
    const atIndex = nodes?.[index];
    return atIndex?.objectApiName === objectApiName
      ? atIndex
      : nodes?.find((node) => node.objectApiName === objectApiName);
  });
}

/** Props for one row of the table. */
interface ForgeExecutionRowProps {
  /** The object the row is about. */
  objectApiName: string;
  /** Where its node stands in the graph. */
  index: number;
}

/**
 * One object of the run: what its node on the graph says — its status, how
 * far it has gone while it is written, its records and fields, or that they
 * were not measured, its personal fields and the errors discovery met.
 */
const ForgeExecutionRow = memo(function ForgeExecutionRow({
  objectApiName,
  index,
}: ForgeExecutionRowProps) {
  const { t } = useTranslation();
  const node = useRunNode(objectApiName, index);
  const nameId = useId();
  if (!node) return null;
  // A described object always reports fields: none means its counts were
  // never measured, as the graph's node says rather than printing zeroes.
  const measured = node.fieldCount > 0;
  const moving = node.status === 'scanning' || node.status === 'running';
  return (
    <tr data-testid="forge-execution-row" className="border-b border-subtle">
      <th
        scope="row"
        id={nameId}
        className="px-3 py-1.5 text-left font-medium text-text-primary whitespace-nowrap"
      >
        {objectApiName}
        {/* Drawn with a dashed outline on the graph. */}
        {!node.included && (
          <span className="ml-1.5 text-[10px] font-normal text-text-secondary">
            {t('forge.executionTable.leftOut')}
          </span>
        )}
      </th>
      <td className="px-3 py-1.5">
        <span
          data-testid={`forge-execution-status-${objectApiName}`}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
            statusColors[node.status],
          )}
        >
          <StatusIcon status={node.status} />
          {t(`forge.nodeStatus.${node.status}`)}
        </span>
      </td>
      <td className="px-3 py-1.5">
        {moving && (
          <div className="flex items-center gap-2">
            <ProgressBar
              value={node.progress}
              size="sm"
              aria-labelledby={nameId}
              barClassName="bg-forge"
              className="w-20"
            />
            <span className="text-xs tabular-nums text-text-secondary">
              {Math.round(node.progress)}%
            </span>
          </div>
        )}
      </td>
      {measured ? (
        <>
          <td
            data-testid={`forge-execution-records-${objectApiName}`}
            className="px-3 py-1.5 tabular-nums text-text-secondary"
          >
            {node.recordCount.toLocaleString(uiLocale())}
          </td>
          <td className="px-3 py-1.5 tabular-nums text-text-secondary whitespace-nowrap">
            {t('forge.node.fieldsCloneable', {
              total: node.fieldCount,
              cloneable: node.createableFieldCount,
            })}
          </td>
        </>
      ) : (
        <td
          colSpan={2}
          data-testid={`forge-execution-records-${objectApiName}`}
          className="px-3 py-1.5 text-xs text-text-secondary"
        >
          {t('forge.node.notMeasured')}
        </td>
      )}
      <td className="px-3 py-1.5 tabular-nums text-text-secondary">
        {node.piiFields.length > 0 ? node.piiFields.length : '-'}
      </td>
      <td className="px-3 py-1.5 tabular-nums text-text-secondary">
        {node.errors.length > 0 ? node.errors.length : '-'}
      </td>
    </tr>
  );
});

/** Props for the ForgeExecutionTable component. */
export interface ForgeExecutionTableProps {
  /** Additional CSS classes. */
  className?: string;
}

/**
 * The run's objects as a table, in place of its graph: per object, what the
 * graph's node shows, followed live. Each row follows its own node, so a
 * progress event draws one row again, where the graph drew every node for
 * each event — a second per event at 400 objects.
 */
export const ForgeExecutionTable = memo(function ForgeExecutionTable({
  className,
}: ForgeExecutionTableProps) {
  const { t } = useTranslation();
  const objects = useRunObjects();
  const header = 'px-3 py-2 text-left text-xs font-medium text-text-secondary';
  return (
    <div
      data-testid="forge-execution-table"
      role="region"
      aria-label={t('forge.executionTable.label')}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a table of hundreds of rows scrolls, and none of its cells is a control to reach it by: the region takes the focus itself, so the keyboard can scroll it (axe scrollable-region-focusable).
      tabIndex={0}
      className={cn(
        'overflow-auto focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--sf-accent)',
        className,
      )}
    >
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface-1 border-b border-subtle">
          <tr>
            <th scope="col" className={header}>
              {t('forge.object')}
            </th>
            <th scope="col" className={header}>
              {t('forge.status')}
            </th>
            <th scope="col" className={header}>
              {t('common.progress')}
            </th>
            <th scope="col" className={header}>
              {t('forge.records')}
            </th>
            <th scope="col" className={header}>
              {t('forge.fields')}
            </th>
            <th scope="col" className={header}>
              PII
            </th>
            <th scope="col" className={header}>
              {t('forge.errors')}
            </th>
          </tr>
        </thead>
        <tbody>
          {objects.map((objectApiName, index) => (
            <ForgeExecutionRow key={objectApiName} objectApiName={objectApiName} index={index} />
          ))}
        </tbody>
      </table>
    </div>
  );
});
