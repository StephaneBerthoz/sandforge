import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncOperation } from '@sandforge/shared';
import { cn } from '../../theme';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';

/** Object set entry for editing. */
export interface ObjectSetEntry {
  objectApiName: string;
  operation: SyncOperation;
  externalIdField: string;
  batchSize: number;
  where: string;
}

/** ObjectSetEditor component props. */
export interface ObjectSetEditorProps {
  entries: ObjectSetEntry[];
  availableObjects: string[];
  /**
   * The source's objects the target takes none of: it has not the object, or
   * the user SandForge writes as may neither create nor edit it there. Shown
   * in the list, not selectable, with why.
   */
  unwritableObjects?: ReadonlyArray<{
    objectApiName: string;
    why: 'notInTarget' | 'notCreateable';
  }>;
  onAdd: (objectApiName: string) => void;
  onRemove: (index: number) => void;
  onChange: (index: number, field: keyof ObjectSetEntry, value: string | number) => void;
  className?: string;
}

/**
 * The operations a row offers. Delete is not one: it deletes in the target
 * the records that hold the ids the source read, which between two sandboxes
 * refreshed from one production are the target's own records — set by
 * mistake, or to clear earlier copies, it deleted them without a question on
 * a sandbox or a Developer Edition. A delta configuration carries the
 * source's deletions where they are meant. A row that comes with it, from a
 * saved configuration or an import, still shows it, and Review says what it
 * does.
 */
const OPERATIONS: SyncOperation[] = ['insert', 'update', 'upsert'];

/**
 * Every row repeats the same four controls, so a bare field label ("Operation")
 * would name a dozen controls identically. Qualifying it with the object API
 * name — never translated — tells a screen reader which row it is reading.
 */
function rowLabel(field: string, objectApiName: string): string {
  return `${field} \u2014 ${objectApiName}`;
}

/** Object set management editor. */
export const ObjectSetEditor: React.FC<ObjectSetEditorProps> = ({
  entries,
  availableObjects,
  unwritableObjects = [],
  onAdd,
  onRemove,
  onChange,
  className,
}) => {
  const { t } = useTranslation();
  const [newObject, setNewObject] = React.useState('');

  const usedObjects = new Set(entries.map((e) => e.objectApiName));
  const objectOptions = [
    ...availableObjects.filter((o) => !usedObjects.has(o)).map((o) => ({ value: o, label: o })),
    ...unwritableObjects
      .filter(({ objectApiName }) => !usedObjects.has(objectApiName))
      .map(({ objectApiName, why }) => ({
        value: objectApiName,
        label: t(`sync.unwritableOption.${why}`, { object: objectApiName }),
        disabled: true,
      })),
  ];
  const opOptionsOf = (current: SyncOperation) =>
    (OPERATIONS.includes(current) ? OPERATIONS : [...OPERATIONS, current]).map((op) => ({
      value: op,
      label: t(`sync.operations.${op}`),
    }));

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="object-set-editor">
      <span className="text-xs font-medium text-text-primary">
        {t('sync.objectSet')} ({entries.length})
      </span>

      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
        {entries.map((entry, i) => (
          <div
            key={entry.objectApiName}
            className={cn(
              'flex flex-wrap items-center gap-2 px-2 py-2 rounded-sm text-xs',
              'border border-(--sf-border)',
            )}
            data-testid={`object-entry-${entry.objectApiName}`}
          >
            <Badge variant="default">{entry.objectApiName}</Badge>
            <Select
              options={opOptionsOf(entry.operation)}
              value={entry.operation}
              onChange={(e) => onChange(i, 'operation', e.target.value)}
              className="w-24"
              aria-label={rowLabel(t('sync.operation'), entry.objectApiName)}
            />
            <Input
              placeholder={t('sync.externalId')}
              value={entry.externalIdField}
              onChange={(e) => onChange(i, 'externalIdField', e.target.value)}
              className="w-28"
              aria-label={rowLabel(t('sync.externalId'), entry.objectApiName)}
            />
            <Input
              type="number"
              min={1}
              max={10000}
              placeholder={t('sync.batchSize')}
              value={entry.batchSize}
              onChange={(e) => onChange(i, 'batchSize', parseInt(e.target.value, 10) || 200)}
              className="w-20"
              aria-label={rowLabel(t('sync.batchSize'), entry.objectApiName)}
            />
            <Input
              placeholder={t('common.whereClause')}
              value={entry.where}
              onChange={(e) => onChange(i, 'where', e.target.value)}
              className="flex-1"
              aria-label={rowLabel(t('common.whereClause'), entry.objectApiName)}
            />
            <button
              className="text-status-error hover:underline px-1"
              onClick={() => onRemove(i)}
              data-testid={`remove-obj-${entry.objectApiName}`}
              aria-label={rowLabel(t('sync.removeObject'), entry.objectApiName)}
            >
              x
            </button>
          </div>
        ))}
      </div>

      {entries.length === 0 && (
        <p className="text-xs text-center text-text-secondary py-2">{t('sync.noObjects')}</p>
      )}

      {/* Add new object */}
      <div className="flex items-center gap-2" data-testid="add-object-row">
        <Select
          options={objectOptions}
          value={newObject}
          onChange={(e) => setNewObject(e.target.value)}
          placeholder={t('sync.addObject')}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            onAdd(newObject);
            setNewObject('');
          }}
          disabled={!newObject}
          data-testid="add-object-btn"
        >
          {t('sync.addObject')}
        </Button>
      </div>
      {unwritableObjects.length > 0 && (
        <p className="text-xs text-text-secondary" data-testid="unwritable-objects-note">
          {t('sync.unwritableNote', {
            objects: unwritableObjects.map((o) => o.objectApiName).join(', '),
          })}
        </p>
      )}
    </div>
  );
};
