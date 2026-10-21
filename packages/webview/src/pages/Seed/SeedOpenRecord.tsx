import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedExecutionResult, SeedOpenRecordResponse } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { objectLabelOf, type ObjectLabels } from '../../utils/objectLabels';

/** A record a run created, as its results list it. */
export interface CreatedRecord {
  objectApiName: string;
  id: string;
}

/**
 * The record a seed's results open: the first account it created, since an
 * account is where a seed's contacts and opportunities are seen together;
 * else the first record of the first object that created one; null for a run
 * that created nothing the results list.
 */
export function recordToOpen(result: SeedExecutionResult): CreatedRecord | null {
  const withIds = result.objectResults.filter((object) => object.createdIds.length > 0);
  const chosen = withIds.find((object) => object.objectApiName === 'Account') ?? withIds[0];
  return chosen ? { objectApiName: chosen.objectApiName, id: chosen.createdIds[0] } : null;
}

/** Props for the SeedOpenRecord action. */
export interface SeedOpenRecordProps {
  /** The run's result: its id, and the records it created. */
  result: SeedExecutionResult;
  /** How the org the run wrote to is named: its alias, or its username. */
  orgName: string;
  /**
   * The labels of the org's objects, from a describe the page holds: the
   * button names the record's object by its label, else by its API name.
   */
  objectLabels?: ObjectLabels;
}

/**
 * Open in Salesforce a record the run created: the results' way to the data
 * they announce, which a user otherwise went looking for in the org by hand.
 *
 * The page names the run and the record; the extension finds the org and the
 * object in what the run kept, and builds the address (`seed:open-record`).
 * Nothing is shown for a run that created nothing.
 */
export const SeedOpenRecord: React.FC<SeedOpenRecordProps> = ({
  result,
  orgName,
  objectLabels,
}) => {
  const { t } = useTranslation();
  const opener = useBridgeMutation<SeedOpenRecordResponse['payload']>('seed:open-record', {
    responseType: 'seed:open-record:response',
    errorType: 'seed:open-record:error',
  });
  const record = useMemo(() => recordToOpen(result), [result]);
  const openRequest = opener.mutate;
  const runId = result.operationId;
  const open = useCallback(() => {
    if (record) openRequest({ runId, recordId: record.id });
  }, [record, runId, openRequest]);
  if (!record) return null;

  /** Why the record did not open, or null. */
  const failure = opener.error ?? (opener.data?.status === 'error' ? opener.data.message : null);

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={open}
        disabled={opener.loading}
        data-testid="btn-seed-open-record"
      >
        {t('seed.results.openRecord', {
          object: objectLabelOf(record.objectApiName, objectLabels),
          org: orgName,
        })}
      </Button>
      {failure && (
        <span
          className="self-center text-[10px] text-status-error"
          role="alert"
          data-testid="seed-open-record-error"
        >
          {failure}
        </span>
      )}
    </>
  );
};
