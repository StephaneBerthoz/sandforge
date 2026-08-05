import React, { useState } from 'react';

export type ActionKind = 'copy-soql' | 'open-file' | 'run-anonymous' | 'apply-fix' | 'manual';

export interface ActionProposalDisplay {
  label: string;
  kind: ActionKind;
  payload?: string;
  requiresApproval: boolean;
  riskNote?: string;
}

export interface DiagnoseResultDisplay {
  summary: string;
  rootCause: string;
  suggestedActions: ActionProposalDisplay[];
  confidence: 'low' | 'medium' | 'high';
  references?: string[];
}

export interface ActionCardProps {
  runId: string;
  result: DiagnoseResultDisplay;
  onApprove: (actionIndex: number, modifiedPayload?: string) => void;
  onReject: (actionIndex: number) => void;
  onExecute?: (actionIndex: number) => void;
  /** Per-action UI state from `ai:approve-action:response` envelopes. */
  actionStates?: Record<number, { status: 'executed' | 'rejected' | 'failed'; message?: string }>;
}

const CONFIDENCE_BADGE: Record<DiagnoseResultDisplay['confidence'], string> = {
  high: 'bg-[var(--sf-success)] text-white',
  medium: 'bg-[var(--sf-warning)] text-white',
  low: 'bg-[var(--sf-error)] text-white',
};

const KIND_LABELS: Record<ActionKind, string> = {
  'copy-soql': 'Copy SOQL',
  'open-file': 'Open file',
  'run-anonymous': 'Run anonymous Apex',
  'apply-fix': 'Apply fix',
  manual: 'Manual',
};

/**
 * Inline action card rendered in the AI chat panel after a diagnose
 * round-trip. Up to 5 actions; each is either auto-executable
 * (read-only) or gated behind an Approve / Reject / Modify trio.
 *
 * testid contract:
 *   - root: ai-action-card-${runId}
 *   - action row: ai-action-card-action-${index}
 *   - approve / reject / modify: ai-action-card-{approve,reject,modify}-${index}
 *   - execute (read-only): ai-action-card-execute-${index}
 */
export const ActionCard: React.FC<ActionCardProps> = ({
  runId,
  result,
  onApprove,
  onReject,
  onExecute,
  actionStates,
}) => {
  const actions = result.suggestedActions.slice(0, 5); // defense in depth — schema also caps at 5
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedValue, setEditedValue] = useState<string>('');

  const openModify = (index: number, currentPayload: string | undefined) => {
    setEditingIndex(index);
    setEditedValue(currentPayload ?? '');
  };

  const saveModify = (index: number) => {
    onApprove(index, editedValue);
    setEditingIndex(null);
    setEditedValue('');
  };

  return (
    <div
      data-testid={`ai-action-card-${runId}`}
      className="rounded border border-[var(--sf-border)] p-4 my-2 bg-[var(--sf-bg-card)]"
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`inline-block px-2 py-0.5 text-xs rounded-full ${CONFIDENCE_BADGE[result.confidence]}`}
          data-testid="ai-action-card-confidence"
        >
          {result.confidence.toUpperCase()}
        </span>
        <h3 className="font-semibold text-sm">{result.summary.slice(0, 120)}</h3>
      </div>
      <p className="text-xs text-[var(--sf-text-muted)] mb-3 max-h-32 overflow-y-auto">
        {result.rootCause}
      </p>

      <ul className="space-y-2">
        {actions.map((action, index) => {
          const state = actionStates?.[index];
          return (
            <li
              key={index}
              data-testid={`ai-action-card-action-${index}`}
              className="flex flex-col gap-1 p-2 rounded border border-[var(--sf-border-subtle)]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-[var(--sf-text-muted)]">
                    {KIND_LABELS[action.kind]}
                  </span>
                  <span className="font-medium">{action.label}</span>
                </div>
                {state ? (
                  <span className="text-xs" data-testid={`ai-action-card-state-${index}`}>
                    {state.status === 'executed'
                      ? 'Exécuté'
                      : state.status === 'rejected'
                        ? 'Rejeté'
                        : 'Échec'}
                  </span>
                ) : action.requiresApproval ? (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      data-testid={`ai-action-card-approve-${index}`}
                      onClick={() => onApprove(index)}
                      className="px-2 py-0.5 text-xs rounded bg-[var(--sf-button-bg)] text-white"
                    >
                      Approuver
                    </button>
                    <button
                      type="button"
                      data-testid={`ai-action-card-modify-${index}`}
                      onClick={() => openModify(index, action.payload)}
                      className="px-2 py-0.5 text-xs rounded border"
                    >
                      Modifier
                    </button>
                    <button
                      type="button"
                      data-testid={`ai-action-card-reject-${index}`}
                      onClick={() => onReject(index)}
                      className="px-2 py-0.5 text-xs rounded border"
                    >
                      Rejeter
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid={`ai-action-card-execute-${index}`}
                    onClick={() => onExecute?.(index)}
                    className="px-2 py-0.5 text-xs rounded bg-[var(--sf-button-secondary-bg)] text-white"
                  >
                    Exécuter
                  </button>
                )}
              </div>
              {action.riskNote && (
                <p className="text-xs text-[var(--sf-warning)]">⚠ {action.riskNote}</p>
              )}
              {editingIndex === index && (
                <div data-testid={`ai-action-card-modify-modal-${index}`} className="mt-2">
                  <textarea
                    className="w-full text-xs font-mono p-2 border rounded"
                    rows={6}
                    value={editedValue}
                    onChange={(e) => setEditedValue(e.target.value)}
                  />
                  <div className="flex gap-1 mt-1">
                    <button
                      type="button"
                      data-testid={`ai-action-card-modify-save-${index}`}
                      onClick={() => saveModify(index)}
                      className="px-2 py-0.5 text-xs rounded bg-[var(--sf-button-bg)] text-white"
                    >
                      Enregistrer & Approuver
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingIndex(null)}
                      className="px-2 py-0.5 text-xs rounded border"
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              )}
              {state?.message && (
                <p className="text-xs text-[var(--sf-text-muted)]">{state.message}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
