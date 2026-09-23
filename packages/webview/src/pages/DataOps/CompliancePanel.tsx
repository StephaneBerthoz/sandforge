import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { COMPLIANCE_MAX_OBJECTS } from '@sandforge/shared';
import type {
  PiiInventoryField,
  PiiInventoryObjectResult,
  PiiInventoryResult,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { formatNumber } from '../../utils/formatters';
import { ObjectPicker } from './ObjectPicker';
import { SubjectRequestLog } from './SubjectRequestLog';
import { SubjectRequestSection } from './SubjectRequestSection';

/** Props for {@link CompliancePanel}. */
export interface CompliancePanelProps {
  /** The org the inventory reads and a request searches. */
  orgId: string;
}

/** What the detector's patterns name, in a reader's words: the key of each. */
const HOLDS: Array<[RegExp, string]> = [
  [/email/, 'dataops.inventory.holds.email'],
  [/phone/, 'dataops.inventory.holds.phone'],
  [/street|address/, 'dataops.inventory.holds.address'],
  [/birth/, 'dataops.inventory.holds.birthdate'],
  [/ssn|social_security|national_id/, 'dataops.inventory.holds.nationalId'],
  [/credit_card|iban|bank_account/, 'dataops.inventory.holds.financial'],
  [/passport|driver/, 'dataops.inventory.holds.document'],
  [/medical|diagnos|health|patient/, 'dataops.inventory.holds.health'],
  [/person_name/, 'dataops.inventory.holds.name'],
];

/** What a field holds, as the detector's pattern says. */
export function holdsLabel(t: TFunction, pattern: string): string {
  const match = HOLDS.find(([regex]) => regex.test(pattern));
  return match ? t(match[1]) : pattern;
}

/**
 * The objects a subject search looks in: those the inventory read that have
 * a field to look in for an address, a number or a name.
 */
export function searchableObjects(objects: readonly PiiInventoryObjectResult[]): string[] {
  return objects.flatMap((object) =>
    object.status === 'scanned' &&
    (object.nameField !== null || object.fields.some((f) => f.searchedFor !== undefined))
      ? [object.objectApiName]
      : [],
  );
}

/**
 * The Compliance tab: which fields of the objects picked hold personal data,
 * and the data subject requests handled on the org — found, exported, erased —
 * with the local log of each.
 */
export const CompliancePanel: React.FC<CompliancePanelProps> = ({ orgId }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [logVersion, setLogVersion] = useState(0);

  const inventory = useBridgeMutation<PiiInventoryResult>('dataops:pii-inventory', {
    responseType: 'dataops:pii-inventory:response',
    errorType: 'dataops:error',
    // A describe and a sample read per object, one object after the other.
    timeoutMs: 300_000,
  });
  const result = inventory.data;

  return (
    <div className="flex flex-col gap-4" data-testid="compliance-panel">
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-text-primary">
          {t('dataops.inventory.title')}
        </h2>
        <p className="text-xs text-text-secondary">{t('dataops.inventory.intro')}</p>
        <ObjectPicker
          orgId={orgId}
          selected={selected}
          onChange={setSelected}
          max={COMPLIANCE_MAX_OBJECTS}
          legend={t('dataops.inventory.objectsLegend', { max: COMPLIANCE_MAX_OBJECTS })}
          testIdPrefix="compliance"
        />
        <div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => inventory.mutate({ orgId, objects: selected })}
            loading={inventory.loading}
            disabled={selected.length === 0}
            data-testid="inventory-run-btn"
          >
            {t('dataops.inventory.run')}
          </Button>
        </div>
        {inventory.error && <ErrorBanner message={inventory.error} data-testid="inventory-error" />}
        {result && (
          <div className="flex flex-col gap-3" data-testid="inventory-results">
            <p className="text-xs text-text-secondary">
              {t('dataops.inventory.method', { sample: formatNumber(result.sampleSize) })}
            </p>
            {result.objects.map((object) => (
              <InventoryObject key={object.objectApiName} object={object} />
            ))}
          </div>
        )}
      </section>

      <SubjectRequestSection
        orgId={orgId}
        objects={result ? searchableObjects(result.objects) : []}
        onLogged={() => setLogVersion((v) => v + 1)}
      />

      <SubjectRequestLog orgId={orgId} version={logVersion} />
    </div>
  );
};

const cell = 'py-1 pr-3 text-left';
const headerCell = `${cell} font-medium text-text-secondary`;

/** One object of an inventory: the fields that hold personal data, and what the sample says of each. */
const InventoryObject: React.FC<{ object: PiiInventoryObjectResult }> = ({ object }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const number = (n: number): string => formatNumber(n);

  if (object.status === 'failed') {
    return (
      <p
        className="text-xs text-status-error"
        data-testid={`inventory-object-${object.objectApiName}`}
      >
        {t('dataops.inventory.objectFailed', {
          object: object.objectApiName,
          message: object.message,
        })}
      </p>
    );
  }

  const foundFrom = (field: PiiInventoryField): string => {
    switch (field.detectedBy) {
      case 'name':
        return t('dataops.inventory.byName');
      case 'type':
        return t('dataops.inventory.byType');
      default:
        return t('dataops.inventory.byValues');
    }
  };
  const inSample = (field: PiiInventoryField): string =>
    field.matched !== undefined
      ? t('dataops.inventory.matched', {
          count: field.matched,
          formatted: number(field.matched),
          sampled: number(object.sampled),
        })
      : t('dataops.inventory.filled', {
          filled: number(field.filled),
          sampled: number(object.sampled),
        });

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-[var(--sf-border)] p-3"
      data-testid={`inventory-object-${object.objectApiName}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-text-primary">
          {object.label}{' '}
          {object.label !== object.objectApiName && (
            <span className="font-mono text-xs font-normal">{object.objectApiName}</span>
          )}
        </h3>
        <span className="text-xs text-text-secondary" data-testid="inventory-sampled">
          {t('dataops.inventory.sampled', {
            count: object.sampled,
            formatted: number(object.sampled),
          })}
        </span>
      </div>
      {object.sampleError && (
        <p className="text-xs text-status-warning" data-testid="inventory-sample-error">
          {t('dataops.inventory.sampleRefused', { message: object.sampleError })}
        </p>
      )}
      {object.fields.length === 0 ? (
        <p className="text-xs text-text-secondary" data-testid="inventory-none">
          {t('dataops.inventory.none')}
        </p>
      ) : (
        <table className="w-full text-xs" aria-labelledby={headingId}>
          <thead>
            <tr className="border-b border-[var(--sf-border)]">
              <th scope="col" className={headerCell}>
                {t('dataops.inventory.field')}
              </th>
              <th scope="col" className={headerCell}>
                {t('dataops.inventory.holdsColumn')}
              </th>
              <th scope="col" className={headerCell}>
                {t('dataops.inventory.foundFrom')}
              </th>
              <th scope="col" className={headerCell}>
                {t('dataops.inventory.inSample')}
              </th>
              <th scope="col" className={headerCell}>
                {t('dataops.inventory.searched')}
              </th>
            </tr>
          </thead>
          <tbody>
            {object.fields.map((field) => (
              <tr
                key={field.fieldApiName}
                className="border-b border-[var(--sf-border)] last:border-0"
                data-testid={`inventory-field-${field.fieldApiName}`}
              >
                <th scope="row" className={`${cell} font-normal text-text-primary`}>
                  <span>{field.label}</span>{' '}
                  {field.label !== field.fieldApiName && (
                    <span className="font-mono text-text-secondary">{field.fieldApiName}</span>
                  )}
                </th>
                <td className={`${cell} text-text-primary`}>
                  {holdsLabel(t, field.pattern)}{' '}
                  <Badge variant="default">{field.classification}</Badge>
                </td>
                <td className={`${cell} text-text-primary`}>{foundFrom(field)}</td>
                <td className={`${cell} text-text-primary`}>
                  {inSample(field)}
                  {field.filled === 0 && object.sampled > 0 && (
                    <Badge variant="warning" className="ml-1">
                      {t('dataops.inventory.emptyInSample')}
                    </Badge>
                  )}
                </td>
                <td className={`${cell} text-text-primary`}>
                  {field.searchedFor
                    ? t(`dataops.inventory.searchedFor.${field.searchedFor}`)
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {object.nameField && (
        <p className="text-xs text-text-secondary" data-testid="inventory-name-field">
          {t('dataops.inventory.nameField', { field: object.nameField.label })}
        </p>
      )}
    </section>
  );
};
