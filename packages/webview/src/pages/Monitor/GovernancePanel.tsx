import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, CheckCircle, AlertTriangle, XCircle, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import type { BadgeVariant } from '../../components/ui/Badge';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOrgStore } from '../../stores/useOrgStore';

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
    case 'pass':
      return 'success';
    case 'warning':
      return 'warning';
    case 'fail':
      return 'error';
  }
}

/** Map status to icon. */
function statusIcon(status: 'pass' | 'warning' | 'fail'): React.ReactNode {
  switch (status) {
    case 'pass':
      return <CheckCircle className="w-4 h-4 text-green-400" />;
    case 'warning':
      return <AlertTriangle className="w-4 h-4 text-amber-400" />;
    case 'fail':
      return <XCircle className="w-4 h-4 text-red-400" />;
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
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Shield className="w-5 h-5 text-text-primary shrink-0" />
          <h2 className="text-sm font-semibold text-text-primary truncate">
            {t('governance.title', 'Org Governance')}
          </h2>
        </div>
        <div className="flex gap-2 flex-wrap">
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
              <span className="text-xs text-text-primary">
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
            <p className="text-xs text-text-secondary" data-testid="no-policies">
              {t(
                'governance.noPolicies',
                'No governance policies configured. Add a policy to get started.',
              )}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {policies.map((policy) => (
                <div
                  key={policy.id}
                  data-testid={`policy-${policy.id}`}
                  className={`flex items-center justify-between p-2 rounded border cursor-pointer transition-colors ${
                    selectedPolicyId === policy.id
                      ? 'border-[var(--sf-accent)] bg-[var(--sf-bg-active)]'
                      : 'border-[var(--sf-border)] bg-[var(--sf-bg-primary)]'
                  }`}
                  onClick={() => setSelectedPolicyId(policy.id)}
                >
                  <div className="flex flex-col">
                    <span className="text-xs font-medium text-text-primary">{policy.name}</span>
                    <span className="text-[10px] text-text-secondary">
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
                  className="flex items-start gap-2 p-2 rounded border border-[var(--sf-border)] bg-[var(--sf-bg-primary)]"
                >
                  {statusIcon(result.status)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-text-primary">
                        {result.ruleName}
                      </span>
                      <Badge variant={statusBadgeVariant(result.status)}>{result.status}</Badge>
                    </div>
                    <p className="text-[10px] text-text-secondary mt-0.5">{result.message}</p>
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
                <li key={idx} className="flex items-start gap-2 text-xs text-text-primary">
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

/* ------------------------------------------------------------------ */
/* Bridge-connected wrapper (GovernancePanelConnected)                  */
/* ------------------------------------------------------------------ */

/** Shape of a governance policy from the templates endpoint. */
interface GovernancePolicyTemplate {
  id: string;
  name: string;
  description: string;
  rules: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    condition: Record<string, unknown>;
    remediation: string;
    enabled: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
}

/** Evaluation result shape from the governance:evaluate:response. */
interface GovernanceEvaluationResult {
  policyId: string;
  policyName: string;
  evaluatedAt: string;
  complianceScore: number;
  ruleResults: GovernanceRuleDisplay[];
  remediations: string[];
}

/**
 * Connected wrapper for GovernancePanel that wires bridge queries
 * for live CRUD, evaluation, and template operations.
 *
 * Fetches policies from governance:policies:list, evaluates via
 * governance:evaluate, deletes via governance:policy:delete, and
 * adds from templates via governance:policy:save + governance:templates.
 */
export const GovernancePanelConnected: React.FC = () => {
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const [evaluationResult, setEvaluationResult] = useState<GovernanceEvaluationResult | null>(null);

  /** Fetch policy list. */
  const policiesQuery = useBridgeQuery<{ policies: GovernancePolicySummary[] }>(
    'governance:policies:list',
    undefined,
    { responseType: 'governance:policies:result' },
  );

  /** Fetch templates for the add-policy flow. */
  const templatesQuery = useBridgeQuery<{ templates: GovernancePolicyTemplate[] }>(
    'governance:templates',
    undefined,
    { responseType: 'governance:templates:response' },
  );

  /** Evaluate mutation. */
  const evaluateMutation = useBridgeMutation<{
    success: boolean;
    result: GovernanceEvaluationResult;
  }>('governance:evaluate', { responseType: 'governance:evaluate:response' });

  /** Delete mutation. */
  const deleteMutation = useBridgeMutation<{ success: boolean }>('governance:policy:delete', {
    responseType: 'governance:policy:delete:response',
  });

  /** Save mutation (for adding from templates). */
  const saveMutation = useBridgeMutation<{ success: boolean }>('governance:policy:save', {
    responseType: 'governance:policy:save:response',
  });

  /** Evaluate a policy. */
  const handleEvaluate = useCallback(
    (policyId: string) => {
      if (!selectedOrgId) return;
      evaluateMutation.mutate({ policyId, orgId: selectedOrgId });
    },
    [selectedOrgId, evaluateMutation],
  );

  /** Store evaluation result when mutation completes. */
  React.useEffect(() => {
    if (evaluateMutation.data?.success && evaluateMutation.data.result) {
      setEvaluationResult(evaluateMutation.data.result);
    }
  }, [evaluateMutation.data]);

  /** Delete a policy and refetch list. */
  const handleDeletePolicy = useCallback(
    (policyId: string) => {
      deleteMutation.mutate({ policyId });
    },
    [deleteMutation],
  );

  /** Refetch policies after delete succeeds. */
  React.useEffect(() => {
    if (deleteMutation.data?.success) {
      policiesQuery.refetch();
      deleteMutation.reset();
    }
  }, [deleteMutation, policiesQuery]);

  /** Add all default templates as policies. */
  const handleAddPolicy = useCallback(() => {
    const templates = templatesQuery.data?.templates ?? [];
    const existingIds = new Set((policiesQuery.data?.policies ?? []).map((p) => p.id));
    for (const tmpl of templates) {
      if (!existingIds.has(tmpl.id)) {
        saveMutation.mutate({ policy: tmpl });
      }
    }
  }, [templatesQuery.data, policiesQuery.data, saveMutation]);

  /** Refetch policies after save succeeds. */
  React.useEffect(() => {
    if (saveMutation.data?.success) {
      policiesQuery.refetch();
      saveMutation.reset();
    }
  }, [saveMutation, policiesQuery]);

  const policies = policiesQuery.data?.policies ?? [];
  const ruleResults = evaluationResult?.ruleResults ?? [];
  const complianceScore = evaluationResult?.complianceScore;
  const remediations = evaluationResult?.remediations ?? [];

  return (
    <div data-testid="governance-panel-connected">
      <GovernancePanel
        policies={policies}
        ruleResults={ruleResults}
        complianceScore={complianceScore}
        remediations={remediations}
        loading={evaluateMutation.loading}
        onEvaluate={handleEvaluate}
        onDeletePolicy={handleDeletePolicy}
        onAddPolicy={handleAddPolicy}
      />
    </div>
  );
};
