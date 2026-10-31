import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncOperation } from '@sandforge/shared';
import { cn } from '../../theme';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Icon } from '../../components/ui/Icon';

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
  /**
   * A line under an object's row, for what it carries that the row does not
   * show: the field mappings, transform rules and excluded fields of an
   * import. Migration listed those apart, every object twice on the page.
   */
  rowDetail?: (entry: ObjectSetEntry) => string | undefined;
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

/** The columns' header cells: the same padding as the cells under them. */
const HEADER_CELL = 'px-1 pb-1 font-medium text-left text-text-secondary whitespace-nowrap';
const CELL = 'px-1 py-1.5 align-middle';

/**
 * Object set management editor: one row per object, under headers naming
 * each column. The inputs had placeholders alone, so once filled a bare
 * "200" no longer said it was the batch size.
 */
export const ObjectSetEditor: React.FC<ObjectSetEditorProps> = ({
  entries,
  availableObjects,
  unwritableObjects = [],
  onAdd,
  onRemove,
  onChange,
  rowDetail,
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
        label: t(`syncParts.unwritableOption.${why}`, { object: objectApiName }),
        disabled: true,
      })),
  ];
  const opOptionsOf = (current: SyncOperation) =>
    (OPERATIONS.includes(current) ? OPERATIONS : [...OPERATIONS, current]).map((op) => ({
      value: op,
      label: t(`syncParts.operations.${op}`),
    }));

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="object-set-editor">
      <span className="text-xs font-medium text-text-primary">
        {t('syncParts.objectSet')} ({entries.length})
      </span>

      {entries.length > 0 && (
        // Scrolls inside itself when the panel is narrower than the columns.
        <div className="max-h-64 overflow-auto">
          <table className="w-full border-collapse text-xs" data-testid="object-set-table">
            <thead>
              <tr>
                <th scope="col" className={HEADER_CELL}>
                  {t('common.object')}
                </th>
                <th scope="col" className={HEADER_CELL}>
                  {t('syncParts.operation')}
                </th>
                <th scope="col" className={HEADER_CELL}>
                  {t('syncParts.externalId')}
                </th>
                <th scope="col" className={HEADER_CELL}>
                  {t('syncParts.batchSize')}
                </th>
                <th scope="col" className={HEADER_CELL}>
                  {t('common.whereClause')}
                </th>
                <th scope="col" className={HEADER_CELL}>
                  <span className="sr-only">{t('syncParts.removeObject')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => {
                const detail = rowDetail?.(entry);
                const removeLabel = rowLabel(t('syncParts.removeObject'), entry.objectApiName);
                return (
                  <React.Fragment key={entry.objectApiName}>
                    <tr
                      className={cn(!detail && 'border-b border-(--sf-border)')}
                      data-testid={`object-entry-${entry.objectApiName}`}
                    >
                      <td className={CELL}>
                        <Badge variant="default">{entry.objectApiName}</Badge>
                      </td>
                      <td className={CELL}>
                        <Select
                          options={opOptionsOf(entry.operation)}
                          value={entry.operation}
                          onChange={(e) => onChange(i, 'operation', e.target.value)}
                          className="w-24"
                          aria-label={rowLabel(t('syncParts.operation'), entry.objectApiName)}
                        />
                      </td>
                      <td className={CELL}>
                        <Input
                          placeholder={t('syncParts.externalId')}
                          value={entry.externalIdField}
                          onChange={(e) => onChange(i, 'externalIdField', e.target.value)}
                          className="w-28"
                          aria-label={rowLabel(t('syncParts.externalId'), entry.objectApiName)}
                        />
                      </td>
                      <td className={CELL}>
                        <Input
                          type="number"
                          min={1}
                          max={10000}
                          placeholder={t('syncParts.batchSize')}
                          value={entry.batchSize}
                          onChange={(e) =>
                            onChange(i, 'batchSize', parseInt(e.target.value, 10) || 200)
                          }
                          className="w-20"
                          aria-label={rowLabel(t('syncParts.batchSize'), entry.objectApiName)}
                        />
                      </td>
                      <td className={cn(CELL, 'w-full')}>
                        <Input
                          placeholder={t('common.whereClause')}
                          value={entry.where}
                          onChange={(e) => onChange(i, 'where', e.target.value)}
                          className="min-w-32"
                          aria-label={rowLabel(t('common.whereClause'), entry.objectApiName)}
                        />
                      </td>
                      <td className={CELL}>
                        {/* A trash icon, named: a bare red "x" said nothing on screen. */}
                        <button
                          type="button"
                          className="flex items-center justify-center rounded-sm p-1 text-status-error hover:bg-(--sf-bg-hover)"
                          onClick={() => onRemove(i)}
                          data-testid={`remove-obj-${entry.objectApiName}`}
                          aria-label={removeLabel}
                          title={removeLabel}
                        >
                          <Icon name="trash" className="text-sm" />
                        </button>
                      </td>
                    </tr>
                    {detail && (
                      <tr
                        className="border-b border-(--sf-border)"
                        data-testid={`object-detail-${entry.objectApiName}`}
                      >
                        <td colSpan={6} className="px-1 pb-1.5 text-text-secondary">
                          {detail}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {entries.length === 0 && (
        <p className="text-xs text-center text-text-secondary py-2">{t('syncParts.noObjects')}</p>
      )}

      {/* Add new object: shown while there is one to choose. Its picker read
          "Add Object" beside a button reading the same, and in Migration was
          empty until an object was left out. */}
      {objectOptions.length > 0 && (
        <div className="flex items-center gap-2" data-testid="add-object-row">
          <Select
            options={objectOptions}
            value={newObject}
            onChange={(e) => setNewObject(e.target.value)}
            placeholder={t('syncParts.chooseObject')}
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
            {t('syncParts.addObject')}
          </Button>
        </div>
      )}
      {unwritableObjects.length > 0 && (
        <p className="text-xs text-text-secondary" data-testid="unwritable-objects-note">
          {t('syncParts.unwritableNote', {
            objects: unwritableObjects.map((o) => o.objectApiName).join(', '),
          })}
        </p>
      )}
    </div>
  );
};
