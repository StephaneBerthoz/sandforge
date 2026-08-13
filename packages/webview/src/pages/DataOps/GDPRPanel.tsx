/**
 * NOT MOUNTED. The DataOps tab for data-subject requests and the PII inventory renders `ComingSoon`
 * instead, because nothing in the codebase produces the data this
 * component expects — mounting it against a hardcoded empty array made
 * an unimplemented feature look like a scan that found nothing.
 *
 * Kept rather than deleted: it is the finished UI for when the backend
 * lands, and nothing imports it, so it is tree-shaken out of the build.
 * Re-mount it in DataOpsPage the moment a real producer exists.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { cn } from '../../theme';

/** DSR type for display. */
export type DSRTypeUI = 'access' | 'erasure' | 'rectification' | 'portability' | 'restriction';

/** DSR status for display. */
export type DSRStatusUI = 'pending' | 'in_progress' | 'completed' | 'rejected';

/** Data Subject Request for display. */
export interface DSRUI {
  id: string;
  type: DSRTypeUI;
  subjectEmail: string;
  subjectName: string;
  requestDate: string;
  dueDate: string;
  status: DSRStatusUI;
  recordsFound: number;
  recordsProcessed: number;
  notes: string;
}

/** PII field detection for display. */
export interface PIIFieldUI {
  objectApiName: string;
  fieldApiName: string;
  piiCategory: string;
  recordCount: number;
}

/** Compliance summary for display. */
export interface ComplianceSummaryUI {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  overdue: number;
  averageResolutionDays: number;
}

/** GDPRPanel props. */
export interface GDPRPanelProps {
  dsrs?: DSRUI[];
  piiFields?: PIIFieldUI[];
  complianceSummary?: ComplianceSummaryUI;
  onCreateDSR?: (type: DSRTypeUI, email: string, name: string) => void;
  onProcessDSR?: (dsrId: string) => void;
  onScanPII?: () => void;
  isScanning?: boolean;
  className?: string;
}

/** Badge variant for DSR status. */
function statusBadge(status: DSRStatusUI): BadgeVariant {
  switch (status) {
    case 'completed':
      return 'success';
    case 'in_progress':
      return 'info';
    case 'rejected':
      return 'error';
    default:
      return 'warning';
  }
}

/** Badge variant for DSR type. */
function typeBadge(type: DSRTypeUI): BadgeVariant {
  switch (type) {
    case 'erasure':
      return 'error';
    case 'access':
      return 'info';
    case 'portability':
      return 'info';
    default:
      return 'default';
  }
}

/**
 * GDPR/RGPD compliance panel showing Data Subject Requests,
 * PII field scanning, and compliance summary metrics.
 */
export const GDPRPanel: React.FC<GDPRPanelProps> = ({
  dsrs = [],
  piiFields = [],
  complianceSummary,
  onCreateDSR,
  onProcessDSR,
  onScanPII,
  isScanning = false,
  className,
}) => {
  const { t } = useTranslation();
  const [newDSRType, setNewDSRType] = useState<DSRTypeUI>('erasure');
  const [newDSREmail, setNewDSREmail] = useState('');
  const [newDSRName, setNewDSRName] = useState('');

  const overdueDSRs = dsrs.filter((dsr) => {
    if (dsr.status === 'completed' || dsr.status === 'rejected') return false;
    return new Date(dsr.dueDate) < new Date();
  });

  const handleCreateDSR = () => {
    if (onCreateDSR && newDSREmail.trim()) {
      onCreateDSR(newDSRType, newDSREmail.trim(), newDSRName.trim());
      setNewDSREmail('');
      setNewDSRName('');
    }
  };

  return (
    <div className={cn('flex flex-col gap-4', className)} data-testid="gdpr-panel">
      {/* Compliance Summary */}
      {complianceSummary && (
        <div data-testid="compliance-summary">
          <h3 className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)] mb-2">
            {t('dataops.complianceSummary', 'Compliance Summary')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div
              className="flex flex-col items-center p-2 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-card,#252526)]"
              data-testid="summary-total"
            >
              <span className="text-sm font-bold text-[var(--sf-text-primary,#d4d4d4)]">
                {complianceSummary.total}
              </span>
              <span className="text-[10px] text-[var(--sf-text-muted,#868686)]">
                {t('dataops.totalDSR', 'Total DSRs')}
              </span>
            </div>
            <div
              className="flex flex-col items-center p-2 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-card,#252526)]"
              data-testid="summary-pending"
            >
              <span className="text-sm font-bold" style={{ color: 'var(--sf-warning, #F59E0B)' }}>
                {complianceSummary.pending}
              </span>
              <span className="text-[10px] text-[var(--sf-text-muted,#868686)]">
                {t('dataops.pendingDSR', 'Pending')}
              </span>
            </div>
            <div
              className="flex flex-col items-center p-2 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-card,#252526)]"
              data-testid="summary-overdue"
            >
              <span
                className="text-sm font-bold"
                style={{
                  color:
                    complianceSummary.overdue > 0
                      ? 'var(--sf-error, #EF4444)'
                      : 'var(--sf-text-primary, #d4d4d4)',
                }}
              >
                {complianceSummary.overdue}
              </span>
              <span className="text-[10px] text-[var(--sf-text-muted,#868686)]">
                {t('dataops.overdueDSR', 'Overdue')}
              </span>
            </div>
          </div>
          {complianceSummary.averageResolutionDays > 0 && (
            <div
              className="text-[10px] text-[var(--sf-text-muted,#868686)] mt-1"
              data-testid="avg-resolution"
            >
              {t('dataops.avgResolution', 'Avg. resolution')}:{' '}
              {complianceSummary.averageResolutionDays} {t('dataops.days', 'days')}
            </div>
          )}
        </div>
      )}

      {/* Overdue warning */}
      {overdueDSRs.length > 0 && (
        <ErrorBanner
          message={`${overdueDSRs.length} ${t('dataops.overdueDSRWarning', 'overdue DSR(s) require immediate attention')}`}
          data-testid="overdue-warning"
        />
      )}

      {/* Create DSR form */}
      <div className="flex flex-col gap-2" data-testid="create-dsr-form">
        <h3 className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)]">
          {t('dataops.newDSR', 'New Data Subject Request')}
        </h3>
        <div className="flex gap-2 items-end flex-wrap">
          <select
            value={newDSRType}
            onChange={(e) => setNewDSRType(e.target.value as DSRTypeUI)}
            className="text-xs p-1.5 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-input,#1e1e1e)] text-[var(--sf-text-primary,#d4d4d4)]"
            data-testid="dsr-type-select"
          >
            <option value="erasure">{t('dataops.dsrErasure', 'Right to Erasure')}</option>
            <option value="access">{t('dataops.dsrAccess', 'Right of Access')}</option>
            <option value="rectification">{t('dataops.dsrRectification', 'Rectification')}</option>
            <option value="portability">{t('dataops.dsrPortability', 'Data Portability')}</option>
            <option value="restriction">{t('dataops.dsrRestriction', 'Restriction')}</option>
          </select>
          <input
            type="email"
            placeholder={t('dataops.subjectEmail', 'Subject email')}
            value={newDSREmail}
            onChange={(e) => setNewDSREmail(e.target.value)}
            className="text-xs p-1.5 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-input,#1e1e1e)] text-[var(--sf-text-primary,#d4d4d4)] flex-1 min-w-[160px]"
            data-testid="dsr-email-input"
          />
          <input
            type="text"
            placeholder={t('dataops.subjectName', 'Subject name')}
            value={newDSRName}
            onChange={(e) => setNewDSRName(e.target.value)}
            className="text-xs p-1.5 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-input,#1e1e1e)] text-[var(--sf-text-primary,#d4d4d4)] flex-1 min-w-[120px]"
            data-testid="dsr-name-input"
          />
          <button
            onClick={handleCreateDSR}
            disabled={!newDSREmail.trim()}
            className={cn(
              'text-xs px-3 py-1.5 rounded font-medium',
              newDSREmail.trim()
                ? 'bg-[var(--sf-info,#3B82F6)] text-white cursor-pointer'
                : 'bg-[var(--sf-bg-disabled)] text-[var(--sf-text-muted,#868686)] cursor-not-allowed',
            )}
            data-testid="create-dsr-btn"
          >
            {t('dataops.createDSR', 'Create DSR')}
          </button>
        </div>
      </div>

      {/* DSR List */}
      <div className="flex flex-col gap-1" data-testid="dsr-list">
        <h3 className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)]">
          {t('dataops.dsrList', 'Data Subject Requests')} ({dsrs.length})
        </h3>
        {dsrs.length === 0 ? (
          <div
            className="text-xs text-[var(--sf-text-muted,#868686)] py-4 text-center"
            data-testid="no-dsrs"
          >
            {t('dataops.noDSR', 'No data subject requests')}
          </div>
        ) : (
          dsrs.map((dsr) => (
            <div
              key={dsr.id}
              className={cn(
                'flex items-center justify-between px-2 py-1.5 rounded text-xs',
                'border border-[var(--sf-border,#3c3c3c)]',
              )}
              data-testid={`dsr-${dsr.id}`}
            >
              <div className="flex items-center gap-2">
                <span data-testid={`dsr-type-${dsr.id}`}>
                  <Badge variant={typeBadge(dsr.type)}>{dsr.type}</Badge>
                </span>
                <span className="text-[var(--sf-text-primary,#d4d4d4)]">
                  {dsr.subjectName || dsr.subjectEmail}
                </span>
                <span className="text-[var(--sf-text-muted,#868686)]">{dsr.subjectEmail}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[var(--sf-text-muted,#868686)]">
                  {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                    new Date(dsr.dueDate),
                  )}
                </span>
                <span data-testid={`dsr-status-${dsr.id}`}>
                  <Badge variant={statusBadge(dsr.status)}>{dsr.status}</Badge>
                </span>
                {(dsr.status === 'pending' || dsr.status === 'in_progress') && onProcessDSR && (
                  <button
                    onClick={() => onProcessDSR(dsr.id)}
                    className="text-[10px] px-2 py-0.5 rounded bg-[var(--sf-info,#3B82F6)] text-white cursor-pointer"
                    data-testid={`process-dsr-${dsr.id}`}
                  >
                    {t('dataops.processDSR', 'Process')}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* PII Scan Section */}
      <div className="flex flex-col gap-2" data-testid="pii-section">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)]">
            {t('dataops.piiScan', 'PII Field Scan')}
          </h3>
          {onScanPII && (
            <button
              onClick={onScanPII}
              disabled={isScanning}
              className={cn(
                'text-[10px] px-2 py-1 rounded font-medium',
                isScanning
                  ? 'bg-[var(--sf-bg-disabled)] text-[var(--sf-text-muted,#868686)] cursor-not-allowed'
                  : 'bg-[var(--sf-warning,#F59E0B)] text-black cursor-pointer',
              )}
              data-testid="scan-pii-btn"
            >
              {isScanning ? t('common.loading') : t('dataops.runPIIScan', 'Scan for PII')}
            </button>
          )}
        </div>

        {piiFields.length > 0 ? (
          <div className="flex flex-col gap-0.5" data-testid="pii-results">
            {piiFields.map((field, i) => (
              <div
                key={`${field.objectApiName}-${field.fieldApiName}`}
                className="flex items-center justify-between px-2 py-1 rounded text-xs border border-[var(--sf-border,#3c3c3c)]"
                data-testid={`pii-field-${i}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[var(--sf-text-primary,#d4d4d4)] font-medium">
                    {field.objectApiName}.{field.fieldApiName}
                  </span>
                  <Badge variant="warning">{field.piiCategory}</Badge>
                </div>
                <span className="text-[var(--sf-text-muted,#868686)]">
                  {field.recordCount.toLocaleString()} {t('seed.records', 'records')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="text-xs text-[var(--sf-text-muted,#868686)] py-2 text-center"
            data-testid="no-pii"
          >
            {t('dataops.noPII', 'No PII fields detected. Run a scan to check.')}
          </div>
        )}
      </div>
    </div>
  );
};
