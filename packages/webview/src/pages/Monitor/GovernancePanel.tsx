import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, CheckCircle, AlertTriangle, XCircle, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import type { BadgeVariant } from '../../components/ui/Badge';

/** A single governance rule result for display. */
export interface GovernanceRuleDisplay {
  ruleId: string;
  ruleName: string;
  category: string;
  status: 'pass' | 'warning' | 'fail';
  actualValue: number;
  threshold: number;
  message: string;
  remediation: string;
}

/** A governance policy summary for the list. */
export interface GovernancePolicySummary {
  id: string;
  name: string;
  description: string;
  ruleCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Props for the GovernancePanel component. */
export interface GovernancePanelProps {
  /** Available policies. */
  policies?: GovernancePolicySummary[];
  /** Current evaluation results. */
  ruleResults?: GovernanceRuleDisplay[];
  /** Overall compliance score (0-100). */
  complianceScore?: number;
  /** Remediation recommendations. */
  remediations?: string[];
  /** Whether an evaluation is in progress. */
  loading?: boolean;
  /** Callback to run evaluation for a policy. */
  onEvaluate?: (policyId: string) => void;
  /** Callback to delete a policy. */
  onDeletePolicy?: (policyId: string) => void;
  /** Callback to add a new policy from templates. */
  onAddPolicy?: () => void;
}

/** Map status to badge variant. */
function statusBadgeVariant(status: 'pass' | 'warning' | 'fail'): BadgeVariant {
  switch (status) {
    case 'pass': return 'success';
    case 'warning': return 'warning';
    case 'fail': return 'error';
  }
}

/** Map status to icon. */
function statusIcon(status: 'pass' | 'warning' | 'fail'): React.ReactNode {
  switch (status) {
    case 'pass': return <CheckCircle className="w-4 h-4 text-green-400" />;
    case 'warning': return <AlertTriangle className="w-4 h-4 text-amber-400" />;
    case 'fail': return <XCircle className="w-4 h-4 text-red-400" />;
  }
}

/** Score color based on compliance percentage. */
function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400';
  if (score >= 60) return 'text-amber-400';
  return 'text-red-400';
}

/**
 * Governance dashboard panel showing policy compliance status,
 * rule evaluation results, and remediation recommendations.
 */
export const GovernancePanel: React.FC<GovernancePanelProps> = ({
  policies = [],
  ruleResults = [],
  complianceScore,
  remediations = [],
  loading = false,
  onEvaluate,
  onDeletePolicy,
  onAddPolicy,
}) => {
  const { t } = useTranslation();
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null);

  const handleEvaluate = useCallback(() => {
    if (selectedPolicyId && onEvaluate) {
      onEvaluate(selectedPolicyId);
    }
  }, [selectedPolicyId, onEvaluate]);

  return (
    <div data-testid="governance-panel" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-[var(--vscode-editor-foreground,#d4d4d4)]" />
          <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {t('governance.title', 'Org Governance')}
          </h2>
        </div>
        <div className="flex gap-2">
          {onAddPolicy && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onAddPolicy}
              data-testid="add-policy-btn"
            >
              <Plus className="w-3 h-3 mr-1" />
              {t('governance.addPolicy', 'Add Policy')}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleEvaluate}
            disabled={!selectedPolicyId || loading}
            loading={loading}
            data-testid="evaluate-btn"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            {t('governance.evaluate', 'Evaluate')}
          </Button>
        </div>
      </div>

      {/* Compliance Score */}
      {complianceScore !== undefined && (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between" data-testid="compliance-score">
              <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {t('governance.complianceScore', 'Compliance Score')}
              </span>
              <span className={`text-2xl font-bold ${scoreColor(complianceScore)}`}>
                {complianceScore}%
              </span>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Policy List */}
      <Card>
        <CardHeader title={t('governance.policies', 'Policies')} />
        <CardBody>
          {policies.length === 0 ? (
            <p
              className="text-xs text-[var(--vscode-descriptionForeground,#868686)]"
              data-testid="no-policies"
            >
              {t('governance.noPolicies', 'No governance policies configured. Add a policy to get started.')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {policies.map((policy) => (
                <div
                  key={policy.id}
                  data-testid={`policy-${policy.id}`}
                  className={`flex items-center justify-between p-2 rounded border cursor-pointer transition-colors ${
                    selectedPolicyId === policy.id
                      ? 'border-[var(--vscode-focusBorder,#007acc)] bg-[var(--vscode-list-activeSelectionBackground,#04395e)]'
                      : 'border-[var(--vscode-panel-border,#2b2b2b)] bg-[var(--vscode-editor-background,#1e1e1e)]'
                  }`}
                  onClick={() => setSelectedPolicyId(policy.id)}
                >
                  <div className="flex flex-col">
                    <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {policy.name}
                    </span>
                    <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                      {policy.description} — {policy.ruleCount} {t('governance.rules', 'rules')}
                    </span>
                  </div>
                  {onDeletePolicy && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeletePolicy(policy.id);
                      }}
                      data-testid={`delete-policy-${policy.id}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Rule Results */}
      {ruleResults.length > 0 && (
        <Card>
          <CardHeader title={t('governance.ruleResults', 'Rule Results')} />
          <CardBody>
            <div className="flex flex-col gap-2" data-testid="rule-results">
              {ruleResults.map((result) => (
                <div
                  key={result.ruleId}
                  data-testid={`rule-result-${result.ruleId}`}
                  className="flex items-start gap-2 p-2 rounded border border-[var(--vscode-panel-border,#2b2b2b)] bg-[var(--vscode-editor-background,#1e1e1e)]"
                >
                  {statusIcon(result.status)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                        {result.ruleName}
                      </span>
                      <Badge variant={statusBadgeVariant(result.status)}>
                        {result.status}
                      </Badge>
                    </div>
                    <p className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] mt-0.5">
                      {result.message}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Remediations */}
      {remediations.length > 0 && (
        <Card>
          <CardHeader title={t('governance.remediations', 'Remediation Checklist')} />
          <CardBody>
            <ul className="flex flex-col gap-1" data-testid="remediations">
              {remediations.map((item, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2 text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]"
                >
                  <input type="checkbox" className="mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
};
