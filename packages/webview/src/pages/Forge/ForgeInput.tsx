import React from 'react';
import { useTranslation } from 'react-i18next';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Database,
  FileCode,
  Sparkles,
  Layers,
  Loader2,
  ArrowLeftRight,
  AlertTriangle,
  Flame,
  RefreshCw,
} from 'lucide-react';
import { cn } from '../../theme';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import type { ForgeInputMode } from '../../stores/useForgeStore';
import { useForgeForm } from './useForgeForm';
import { useForgeTemplates } from './useForgeTemplates';
import { ForgeTemplatePanel } from './ForgeTemplatePanel';
import { ForgeLivePreviewPanel } from './ForgeLivePreviewPanel';
import { ForgeOrgCard } from './ForgeOrgCard';
import { ForgeDepthChips } from './ForgeDepthChips';
import { ForgeOptionToggles } from './ForgeOptionToggles';
import { extractRecordId } from './forgeUtils';

/** Tab configuration for the Forge input modes. */
interface TabConfig {
  /** Tab identifier matching ForgeInputMode. */
  id: ForgeInputMode;
  /** i18n key for the tab label. */
  labelKey: string;
  /** Icon component rendered inside the trigger. */
  icon: React.ReactNode;
  /** data-testid for the tab trigger. */
  testId: string;
}

/** Static tab configuration. */
const TABS: TabConfig[] = [
  {
    id: 'record',
    labelKey: 'forge.recordTab',
    icon: <Database size={14} />,
    testId: 'forge-tab-record',
  },
  { id: 'soql', labelKey: 'forge.soqlTab', icon: <FileCode size={14} />, testId: 'forge-tab-soql' },
  {
    id: 'template',
    labelKey: 'forge.templateTab',
    icon: <Layers size={14} />,
    testId: 'forge-tab-template',
  },
  { id: 'ai', labelKey: 'forge.aiTab', icon: <Sparkles size={14} />, testId: 'forge-tab-ai' },
];

/**
 * Forge input form -- Mission Control + Live Preview hybrid layout.
 * Org cards with status indicators at top, tabbed input in a card,
 * depth chips, option toggles, and a live preview panel on the right.
 *
 * State lives in `useForgeForm` (form + preview) and `useForgeTemplates`
 * (template CRUD); this component only wires them to the JSX.
 */
export const ForgeInput: React.FC = () => {
  const { t } = useTranslation();
  const form = useForgeForm();
  const templates = useForgeTemplates({
    selectedTemplate: form.selectedTemplate,
    setSelectedTemplate: form.setSelectedTemplate,
  });

  return (
    <div className="flex flex-col gap-4" data-testid="forge-input">
      {/* ===== ORG CARDS ROW ===== */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
        <ForgeOrgCard
          labelKey="forge.sourceOrg"
          org={form.sourceOrg}
          orgId={form.sourceOrgId}
          onOrgChange={form.setSourceOrgId}
          orgs={form.orgs}
          testId="forge-source-org"
        />
        <button
          type="button"
          data-testid="forge-swap-orgs"
          onClick={form.handleSwapOrgs}
          className={cn(
            'text-forge hover:text-forge/80 transition-colors p-1 rounded-md',
            'hover:bg-forge/10',
          )}
          aria-label={t('forge.swapOrgs')}
          title={t('forge.swapOrgs')}
        >
          <ArrowLeftRight size={22} strokeWidth={2.5} />
        </button>
        <ForgeOrgCard
          labelKey="forge.targetOrg"
          org={form.targetOrg}
          orgId={form.targetOrgId}
          onOrgChange={form.setTargetOrgId}
          orgs={form.orgs}
          testId="forge-target-org"
        />
      </div>

      {/* UX-03: Same-org warning */}
      {form.sameOrgSelected && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20"
          data-testid="forge-same-org-warning"
        >
          <AlertTriangle size={14} />
          {t('forge.sameOrgWarning')}
        </div>
      )}

      {/* ===== MAIN GRID: Form + Preview ===== */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_260px] gap-4">
        {/* ---- LEFT: Form column ---- */}
        <div className="flex flex-col gap-3">
          {/* Tabs card */}
          <div className="rounded-lg border border-subtle bg-surface-1 overflow-hidden">
            <Tabs.Root
              value={form.inputMode}
              onValueChange={(v) => form.setInputMode(v as ForgeInputMode)}
            >
              <Tabs.List className="flex border-b border-subtle" aria-label={t('nav.forge')}>
                {TABS.map((tab) => (
                  <Tabs.Trigger
                    key={tab.id}
                    value={tab.id}
                    data-testid={tab.testId}
                    className={cn(
                      'flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm transition-colors',
                      'text-text-muted hover:text-text-primary',
                      'data-[state=active]:text-forge data-[state=active]:border-b-2 data-[state=active]:border-forge',
                      'data-[state=active]:bg-surface-2',
                    )}
                  >
                    {tab.icon}
                    {t(tab.labelKey)}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

              <div className="p-3">
                {/* Record tab */}
                <Tabs.Content value="record" className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <input
                      data-testid="forge-input-record"
                      type="text"
                      value={form.recordId}
                      onChange={(e) => form.handleRecordIdChange(e.target.value)}
                      placeholder={t('forge.recordIdPlaceholder')}
                      className={cn(
                        'flex-1 px-3 py-2 rounded-md text-sm font-mono',
                        'bg-[var(--sf-bg-input)]',
                        'text-[var(--sf-text-input)]',
                        'border border-[var(--sf-border-input)]',
                        'focus:outline-none focus:border-forge/50',
                      )}
                    />
                    <button
                      type="button"
                      data-testid="forge-preview-btn"
                      aria-label={t('forge.refreshPreview')}
                      disabled={
                        extractRecordId(form.recordId) === null ||
                        form.sourceOrgId.length === 0 ||
                        form.previewLoading
                      }
                      onClick={form.handlePreview}
                      title={t('forge.refreshPreview')}
                      className={cn(
                        'shrink-0 px-2.5 py-2 rounded-md text-sm transition-colors',
                        'border border-[var(--sf-border-input)]',
                        'bg-[var(--sf-bg-input)]',
                        'text-text-muted hover:text-forge hover:border-forge/50',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                      )}
                    >
                      {form.previewLoading ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                    </button>
                  </div>
                  {form.previewError && (
                    <div className="p-2 rounded-md text-sm text-red-400 bg-red-500/10 border border-red-500/20">
                      {form.previewError}
                    </div>
                  )}
                </Tabs.Content>

                {/* SOQL tab */}
                <Tabs.Content value="soql">
                  <textarea
                    data-testid="forge-input-soql"
                    value={form.soqlQuery}
                    onChange={(e) => form.setSoqlQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && form.canDiscover) {
                        e.preventDefault();
                        form.handleDiscover();
                      }
                    }}
                    placeholder={t('forge.soqlPlaceholder')}
                    rows={5}
                    className={cn(
                      'w-full px-3 py-2 rounded-md text-sm font-mono resize-y',
                      'bg-[var(--sf-bg-input)]',
                      'text-[var(--sf-text-input)]',
                      'border border-[var(--sf-border-input)]',
                      'focus:outline-none focus:border-forge/50',
                    )}
                  />
                </Tabs.Content>

                {/* Template tab — forceMount keeps state alive for CRUD management */}
                <Tabs.Content
                  value="template"
                  forceMount
                  className={form.inputMode !== 'template' ? 'hidden' : ''}
                >
                  <ForgeTemplatePanel
                    manager={templates}
                    selectedTemplate={form.selectedTemplate}
                    onSelectTemplate={form.setSelectedTemplate}
                    buildTemplateConfig={form.buildTemplateConfig}
                  />
                </Tabs.Content>

                {/* AI tab */}
                <Tabs.Content value="ai">
                  <textarea
                    data-testid="forge-input-ai"
                    value={form.aiPrompt}
                    onChange={(e) => form.setAiPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && form.canDiscover) {
                        e.preventDefault();
                        form.handleDiscover();
                      }
                    }}
                    placeholder={t('forge.aiPlaceholder')}
                    rows={4}
                    className={cn(
                      'w-full px-3 py-2 rounded-md text-sm resize-y',
                      'bg-[var(--sf-bg-input)]',
                      'text-[var(--sf-text-input)]',
                      'border border-[var(--sf-border-input)]',
                      'focus:outline-none focus:border-forge/50',
                    )}
                  />
                </Tabs.Content>
              </div>
            </Tabs.Root>
          </div>

          {/* Depth chips */}
          <ForgeDepthChips
            depth={form.depth}
            customDepth={form.customDepth}
            onDepthChange={form.setDepth}
            onCustomDepthChange={form.setCustomDepth}
            onDepthKeyDown={form.handleDepthKeyDown}
            depthRefs={form.depthRefs}
          />

          {/* Records-per-object cap — keeps big-org clones bounded */}
          <div>
            <div className="text-[10px] text-text-muted uppercase tracking-widest mb-2 flex items-center gap-2">
              {t('forge.recordLimit')}
              <span className="text-text-muted/60 normal-case tracking-normal text-[10px]">
                — {t('forge.recordLimitHint')}
              </span>
            </div>
            <select
              data-testid="forge-record-limit"
              value={form.recordLimit}
              onChange={(e) => form.setRecordLimit(e.target.value)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs',
                'bg-[var(--sf-bg-input)]',
                'text-[var(--sf-text-input)]',
                'border border-[var(--sf-border-input)]',
                'focus:outline-none focus:border-forge/50',
              )}
            >
              <option value="smart">{t('forge.recordLimitSmart')}</option>
              <option value="10">{t('forge.recordLimitOpt10')}</option>
              <option value="50">{t('forge.recordLimitOpt50')}</option>
              <option value="100">{t('forge.recordLimitOpt100')}</option>
              <option value="500">{t('forge.recordLimitOpt500')}</option>
              <option value="1000">{t('forge.recordLimitOpt1000')}</option>
              <option value="all">{t('forge.recordLimitAll')}</option>
            </select>
            {/* Smart-mode hint — surfaces what the auto cap will be */}
            {form.recordLimit === 'smart' && form.preview?.estimatedRecordCount != null && (
              <div
                className="mt-1.5 text-[10px] text-text-muted flex items-center gap-1.5"
                data-testid="forge-record-limit-smart-hint"
              >
                <span>
                  {t('forge.smartLimitSuggested', {
                    count: form.preview.estimatedRecordCount,
                    limit: form.recordLimitValue ?? t('forge.recordLimitAll'),
                  })}
                </span>
              </div>
            )}
          </div>

          {/* Option toggles */}
          <ForgeOptionToggles
            anonymize={form.anonymize}
            onAnonymizeChange={form.setAnonymize}
            skipEmpty={form.skipEmpty}
            onSkipEmptyChange={form.setSkipEmpty}
            expandOrphanParents={form.expandOrphanParents}
            onExpandOrphanParentsChange={form.setExpandOrphanParents}
          />

          {/* CTA -- gradient Discover button */}
          <button
            type="button"
            data-testid="forge-discover-btn"
            disabled={!form.canDiscover}
            onClick={form.handleDiscover}
            className={cn(
              'w-full py-3 rounded-lg text-white font-bold text-sm tracking-wide',
              'bg-gradient-to-br from-forge to-[#ea580c]',
              'hover:shadow-lg hover:shadow-forge/20',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none',
              'transition-all flex items-center justify-center gap-2',
            )}
          >
            <Flame size={16} />
            {t('forge.discoverGraph')}
          </button>
          {/* UX-05: Disabled CTA hint */}
          {!form.canDiscover && (
            <p
              className="text-[10px] text-text-muted text-center mt-1"
              data-testid="forge-discover-hint"
            >
              {!form.sourceOrgId
                ? t('forge.hintNoSource')
                : !form.targetOrgId
                  ? t('forge.hintNoTarget')
                  : form.sameOrgSelected
                    ? t('forge.hintSameOrg')
                    : t('forge.hintNoInput')}
            </p>
          )}

          {/* Reuse last graph — skip BFS rediscovery (~30s on REDACTED-CLIENT) */}
          {form.canReuseLastGraph && (
            <button
              type="button"
              data-testid="forge-reuse-last-graph-btn"
              onClick={form.handleReuseLastGraph}
              className={cn(
                'w-full py-2 mt-2 rounded-lg text-xs font-medium',
                'border border-forge/30 bg-forge/5 text-forge',
                'hover:bg-forge/10 hover:border-forge/50',
                'transition-all flex items-center justify-center gap-2',
              )}
              title={t(
                'forge.reuseLastGraphHint',
                'Skip the 30s+ discovery and reuse the graph from your last execution.',
              )}
            >
              <RefreshCw size={12} />
              {t('forge.reuseLastGraph', 'Reuse last graph (skip discovery)')}
            </button>
          )}

          {/* Quick start (skip-when-template) — synthetic graph, instant Review */}
          {form.canQuickStartTemplate && form.builtinTplCandidate && (
            <button
              type="button"
              data-testid="forge-quick-start-template-btn"
              onClick={form.handleQuickStartTemplate}
              className={cn(
                'w-full py-2 mt-2 rounded-lg text-xs font-medium',
                'border border-forge/30 bg-forge/5 text-forge',
                'hover:bg-forge/10 hover:border-forge/50',
                'transition-all flex items-center justify-center gap-2',
              )}
              title={t(
                'forge.quickStartTemplateHint',
                "Skip discovery and use the starter template's known object set. Record counts will be queried during execution.",
              )}
            >
              <Sparkles size={12} />
              {t('forge.quickStartTemplate', 'Quick start ({{name}})').replace(
                '{{name}}',
                form.builtinTplCandidate.name,
              )}
            </button>
          )}
        </div>

        {/* ---- RIGHT: Live Preview panel ---- */}
        <ForgeLivePreviewPanel
          preview={form.preview}
          inputMode={form.inputMode}
          sourceOrgId={form.sourceOrgId}
          anonymize={form.anonymize}
          onClosePreview={form.closePreview}
        />
      </div>

      {/* Delete template confirmation dialog */}
      <DangerConfirm
        open={templates.deleteConfirmId !== null}
        onClose={templates.cancelDeleteTemplate}
        onConfirm={templates.handleDeleteTemplate}
        title={t('forge.deleteTemplate')}
        description={t('forge.deleteTemplateConfirm')}
        confirmText={t('forge.deleteTemplate')}
      />
    </div>
  );
};
