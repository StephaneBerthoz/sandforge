import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { Badge } from '../../components/ui/Badge';
import { Select } from '../../components/ui/Select';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ERDMiniMap } from './ERDMiniMap';
import type { ObjectNode, ERDEdge } from '@sandforge/shared';

/** Relation definition between seed objects. */
export interface SeedRelation {
  childObject: string;
  childField: string;
  parentObject: string;
  parentField: string;
}

/** Step4 props. */
export interface Step4ConfigureRelationsProps {
  relations: SeedRelation[];
  availableObjects: string[];
  onChangeRelation: (index: number, field: keyof SeedRelation, value: string) => void;
  onAddRelation: () => void;
  onRemoveRelation: (index: number) => void;
  /** ERD nodes for the mini-map visualization. */
  erdNodes?: ObjectNode[];
  /** ERD edges for the mini-map visualization. */
  erdEdges?: ERDEdge[];
  /** Insertion order from schema analysis. */
  insertionOrder?: string[];
  /** Currently selected objects in the wizard. */
  selectedObjects?: string[];
  /** Circular dependency chains detected. */
  circularDeps?: string[][];
  /** Warnings from schema analysis. */
  erdWarnings?: string[];
  /** Callback when clicking a node in the ERD mini-map. */
  onERDNodeClick?: (apiName: string) => void;
}

/** Step 4 — Configure reference links between objects with ERD visualization. */
export const Step4ConfigureRelations: React.FC<Step4ConfigureRelationsProps> = ({
  relations,
  availableObjects,
  onChangeRelation,
  onAddRelation,
  onRemoveRelation,
  erdNodes = [],
  erdEdges = [],
  insertionOrder = [],
  selectedObjects = [],
  circularDeps = [],
  erdWarnings = [],
  onERDNodeClick,
}) => {
  const { t } = useTranslation();

  const objectOptions = availableObjects.map((o) => ({ value: o, label: o }));

  /** Build order display items from insertionOrder. */
  const orderItems = useMemo(() => {
    return insertionOrder.map((name, i) => ({
      name,
      order: i + 1,
      isSelected: selectedObjects.includes(name),
    }));
  }, [insertionOrder, selectedObjects]);

  return (
    <div className="flex flex-col gap-3" data-testid="step-configure-relations">
      <p className="text-xs text-text-secondary">{t('seed.configureRelationsDesc')}</p>

      {/* ERD Mini-Map */}
      {erdNodes.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="erd-section">
          <span className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)]">
            {t('seed.erdTitle', 'Object Relationships')}
          </span>
          <ERDMiniMap
            nodes={erdNodes}
            edges={erdEdges}
            insertionOrder={insertionOrder}
            selectedObjects={selectedObjects}
            onObjectClick={onERDNodeClick ?? (() => {})}
            circularDeps={circularDeps}
          />

          {/* ERD Legend */}
          <div
            className="flex gap-4 text-[10px] text-[var(--sf-text-muted,#868686)]"
            data-testid="erd-legend"
          >
            <span className="flex items-center gap-1">
              <span
                style={{
                  width: 16,
                  height: 2,
                  background: 'var(--sf-info, #3B82F6)',
                  display: 'inline-block',
                  borderTop: '1px dashed var(--sf-info, #3B82F6)',
                }}
              />
              {t('seed.erdLookup', 'Lookup')}
            </span>
            <span className="flex items-center gap-1">
              <span
                style={{
                  width: 16,
                  height: 2,
                  background: 'var(--sf-error, #EF4444)',
                  display: 'inline-block',
                }}
              />
              {t('seed.erdMasterDetail', 'Master-Detail')}
            </span>
            <span className="flex items-center gap-1">
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  border: '1.5px solid var(--sf-error, #EF4444)',
                  display: 'inline-block',
                }}
              />
              {t('seed.erdCircular', 'Circular Dep')}
            </span>
          </div>
        </div>
      )}

      {/* Warnings */}
      {erdWarnings.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="erd-warnings">
          {erdWarnings.map((warning, i) => (
            <ErrorBanner key={i} message={warning} data-testid={`erd-warning-${i}`} />
          ))}
        </div>
      )}

      {/* Insertion Order */}
      {orderItems.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="insertion-order">
          <span className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)]">
            {t('seed.insertionOrderTitle', 'Insertion Order')}
          </span>
          <div className="flex flex-wrap gap-1">
            {orderItems.map((item) => (
              <span
                key={item.name}
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full border',
                  item.isSelected
                    ? 'border-[var(--sf-info,#3B82F6)] text-[var(--sf-info,#3B82F6)]'
                    : 'border-[var(--sf-border,#3c3c3c)] text-[var(--sf-text-muted,#868686)]',
                )}
                data-testid={`order-item-${item.name}`}
              >
                <span className="font-bold">{item.order}</span>
                {item.name}
                {!item.isSelected && (
                  <span className="text-[var(--sf-warning,#F59E0B)]">
                    {t('seed.autoAdded', 'auto')}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Manual relation configuration */}
      {relations.length === 0 && erdNodes.length === 0 && (
        <p className="text-xs text-center text-text-secondary py-4">{t('seed.noDependencies')}</p>
      )}

      <div className="flex flex-col gap-2">
        {relations.map((rel, i) => (
          <div
            key={i}
            className={cn(
              'flex items-center gap-2 p-2 rounded text-xs',
              'border border-[var(--sf-border)]',
            )}
            data-testid={`relation-${i}`}
          >
            <Select
              options={objectOptions}
              value={rel.childObject}
              onChange={(e) => onChangeRelation(i, 'childObject', e.target.value)}
              placeholder={t('seed.selectField')}
            />
            <span className="text-text-secondary">.</span>
            <input
              className="w-28 px-1.5 py-1 text-xs rounded bg-[var(--sf-bg-input)] text-[var(--sf-text-input)] border border-[var(--sf-border-input)]"
              value={rel.childField}
              onChange={(e) => onChangeRelation(i, 'childField', e.target.value)}
              placeholder="lookupField"
            />
            <Badge variant="default">{'\u2192'}</Badge>
            <Select
              options={objectOptions}
              value={rel.parentObject}
              onChange={(e) => onChangeRelation(i, 'parentObject', e.target.value)}
              placeholder={t('seed.selectField')}
            />
            <span className="text-text-secondary">.</span>
            <input
              className="w-28 px-1.5 py-1 text-xs rounded bg-[var(--sf-bg-input)] text-[var(--sf-text-input)] border border-[var(--sf-border-input)]"
              value={rel.parentField}
              onChange={(e) => onChangeRelation(i, 'parentField', e.target.value)}
              placeholder="Id"
            />
            <button
              className="text-[var(--sf-error)] hover:opacity-70 px-1"
              onClick={() => onRemoveRelation(i)}
              data-testid={`remove-relation-${i}`}
            >
              x
            </button>
          </div>
        ))}
      </div>

      <button
        className="text-xs text-[var(--sf-accent)] hover:underline self-start"
        onClick={onAddRelation}
        data-testid="add-relation-btn"
      >
        + {t('seed.addObject')}
      </button>
    </div>
  );
};
