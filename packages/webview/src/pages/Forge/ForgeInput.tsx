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
import { ForgeHistoryPanel } from './ForgeHistoryPanel';
import { ForgeLivePreviewPanel } from './ForgeLivePreviewPanel';
import { ForgeOrgCard } from './ForgeOrgCard';
import { ForgeDepthChips } from './ForgeDepthChips';
import { ForgeOptionToggles } from './ForgeOptionToggles';
import {
  extractRecordId,
  soqlFilterRefused,
  soqlRootFilter,
  SOQL_UNSCOPED_RECORD_CAP,
} from './forgeUtils';

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
  /** Shown as coming soon and cannot be opened. */
  comingSoon?: boolean;
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
  /* Nothing turns a prompt into a seed plan yet: discovery resolves a root
     object from a record id or a query only, and refuses this mode. */
  {
    id: 'ai',
    labelKey: 'forge.aiTab',
    icon: <Sparkles size={14} />,
    testId: 'forge-tab-ai',
    comingSoon: true,
  },
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

  /*
   * An id the parser cannot read at all — a half-copied paste, an id with a
   * space in the middle, a Salesforce URL that carries no id. `handleDiscover`
   * still fires: it sends the config with `recordId: undefined`, and the org
   * round trip comes back with "Cannot resolve root object for inputMode
   * record" after a describeGlobal call. Say it under the field instead,
   * before the trip.
   */
  /*
   * A built-in template clones one record's graph, so the Template tab asks
   * for the root record exactly as the Record tab does — it had no way to,
   * and the run went out unscoped.
   */
  const templateNeedsRoot = form.inputMode === 'template' && !!form.builtinTplCandidate;
  const recordIdInvalid =
    (form.inputMode === 'record' || templateNeedsRoot) &&
    form.recordId.trim().length > 0 &&
    extractRecordId(form.recordId) === null;
  /** The CTA gate: everything `canDiscover` asks, plus a record id that parses. */
  const canDiscoverNow = form.canDiscover && !recordIdInvalid;
  /** The object the SOQL query reads and the WHERE clause that will filter it. */
  const soqlRoot = soqlRootFilter(form.soqlQuery);
  /** The WHERE clause breaks the filter rules the extension checks before a run. */
  const soqlWhereRefused = soqlFilterRefused(form.soqlQuery);
  /** The same two checks over the query a selected SOQL template saved. */
  const templateRoot = form.templateSoqlQuery ? soqlRootFilter(form.templateSoqlQuery) : null;
  const templateWhereRefused =
    form.templateSoqlQuery !== null && soqlFilterRefused(form.templateSoqlQuery);
  /**
   * The refusal is about the FROM clause, not the WHERE one: an alias there
   * stands for a relationship that starts from no declared alias, so nothing
   * can rewrite the paths headed by it. Saying "shorten the WHERE clause"
   * would name a clause that may be faultless, and point at the wrong fix.
   */
  const aliasRefused =
    form.inputMode === 'soql'
      ? Boolean(soqlRoot?.unresolvedAlias)
      : Boolean(templateRoot?.unresolvedAlias);

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
            'text-hue-forge hover:text-hue-forge transition-colors p-1 rounded-md',
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

      {/* Same-org warning */}
      {form.sameOrgSelected && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-status-warning bg-yellow-500/10 border border-yellow-500/20"
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
                    disabled={tab.comingSoon}
                    className={cn(
                      'flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm transition-colors',
                      'text-text-secondary hover:text-text-primary',
                      'data-[state=active]:text-hue-forge data-[state=active]:border-b-2 data-[state=active]:border-forge',
                      'data-[state=active]:bg-surface-2',
                      'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-text-muted',
                    )}
                  >
                    {tab.icon}
                    {t(tab.labelKey)}
                    {tab.comingSoon && (
                      <span className="rounded-full border border-subtle px-1.5 text-[10px] leading-4">
                        {t('common.comingSoon')}
                      </span>
                    )}
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
                      /* The SOQL tab launches discovery from the keyboard;
                         the record tab — the one people actually paste into —
                         had no shortcut, so the flagship path forced a trip to
                         the mouse. Enter (bare or with Ctrl/Cmd) submits. */
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && canDiscoverNow) {
                          e.preventDefault();
                          form.handleDiscover();
                        }
                      }}
                      placeholder={t('forge.recordIdPlaceholder')}
                      // A placeholder is not a name: it disappears on the first
                      // keystroke and screen readers are not required to read
                      // it. The Home hero's record input has carried the same
                      // label through `t()` since it shipped; this one, the
                      // flagship path's own field, had none.
                      aria-label={t('forge.recordIdPlaceholder')}
                      aria-invalid={recordIdInvalid}
                      aria-describedby={recordIdInvalid ? 'forge-record-id-error' : undefined}
                      className={cn(
                        'flex-1 px-3 py-2 rounded-md text-sm font-mono',
                        'bg-[var(--sf-bg-input)]',
                        'text-[var(--sf-text-input)]',
                        'border',
                        recordIdInvalid
                          ? 'border-status-error/40'
                          : 'border-[var(--sf-border-input)]',
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
                        'text-text-secondary hover:text-hue-forge hover:border-forge/50',
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
                  {recordIdInvalid && (
                    <p
                      id="forge-record-id-error"
                      role="alert"
                      data-testid="forge-record-id-error"
                      className="text-xs text-status-error"
                    >
                      {/* Same wording as the Home hero, which already refuses an
                          unreadable id — reusing its key rather than adding a
                          seventh translation of the same sentence. */}
                      {t('home.invalidRecordId')}
                    </p>
                  )}
                  {form.previewError && (
                    <div className="p-2 rounded-md text-sm text-status-error bg-red-500/10 border border-red-500/20">
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
                  {/* The WHERE clause filters the object after FROM, and nothing
                      else: related objects are read from their whole tables. A
                      user who wrote a filter would otherwise expect the whole
                      graph to follow it. */}
                  {soqlWhereRefused && (
                    <div
                      data-testid="forge-soql-filter-refused"
                      role="alert"
                      className="mt-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
                    >
                      {t(
                        soqlRoot?.unresolvedAlias
                          ? 'forge.soqlAliasRefused'
                          : 'forge.soqlFilterRefused',
                      )}
                    </div>
                  )}
                  {/* The clause travels under the object's own name, which has
                      its own rule: a name the schema refuses made the extension
                      refuse Discover with nothing said here. */}
                  {form.objectNameRefused && soqlRoot && (
                    <div
                      data-testid="forge-soql-object-invalid"
                      role="alert"
                      className="mt-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
                    >
                      {t('forge.soqlObjectNameInvalid', { object: soqlRoot.objectApiName })}
                    </div>
                  )}
                  {soqlRoot?.where && !soqlWhereRefused && !form.objectNameRefused && (
                    <div
                      data-testid="forge-soql-where-warning"
                      role="status"
                      className="mt-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary"
                    >
                      <strong className="font-semibold">
                        {t('forge.soqlUnscopedWarnTitle', { object: soqlRoot.objectApiName })}
                      </strong>{' '}
                      {t('forge.soqlUnscopedWarnBody', { cap: SOQL_UNSCOPED_RECORD_CAP })}
                    </div>
                  )}
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
                  {/* The root record a built-in template clones from. A saved
                      template carries its own input, so it asks for nothing. */}
                  {templateNeedsRoot && (
                    <div className="mt-3 flex flex-col gap-1">
                      <label
                        htmlFor="forge-template-record-id"
                        className="text-[10px] uppercase tracking-widest text-text-secondary"
                      >
                        {t('forge.templateRootRecord')}
                      </label>
                      <input
                        id="forge-template-record-id"
                        data-testid="forge-template-record-id"
                        type="text"
                        value={form.recordId}
                        onChange={(e) => form.handleRecordIdChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && canDiscoverNow) {
                            e.preventDefault();
                            form.handleDiscover();
                          }
                        }}
                        placeholder={t('forge.recordIdPlaceholder')}
                        aria-invalid={recordIdInvalid}
                        aria-describedby="forge-template-record-id-hint"
                        className={cn(
                          'px-3 py-2 rounded-md text-sm font-mono',
                          'bg-[var(--sf-bg-input)]',
                          'text-[var(--sf-text-input)]',
                          'border',
                          recordIdInvalid
                            ? 'border-status-error/40'
                            : 'border-[var(--sf-border-input)]',
                          'focus:outline-none focus:border-forge/50',
                        )}
                      />
                      <p
                        id="forge-template-record-id-hint"
                        className="text-[10px] text-text-secondary"
                      >
                        {t('forge.templateRootRecordHint')}
                      </p>
                    </div>
                  )}
                  {/* A template that saved a SOQL query runs it exactly as the
                      SOQL tab would, so it carries the same two verdicts —
                      which the picker used to show neither of. */}
                  {templateWhereRefused && (
                    <div
                      data-testid="forge-soql-filter-refused"
                      role="alert"
                      className="mt-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
                    >
                      {t(
                        templateRoot?.unresolvedAlias
                          ? 'forge.soqlAliasRefused'
                          : 'forge.soqlFilterRefused',
                      )}
                    </div>
                  )}
                  {form.objectNameRefused && templateRoot && (
                    <div
                      data-testid="forge-soql-object-invalid"
                      role="alert"
                      className="mt-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
                    >
                      {t('forge.soqlObjectNameInvalid', { object: templateRoot.objectApiName })}
                    </div>
                  )}
                  {templateRoot?.where && !templateWhereRefused && !form.objectNameRefused && (
                    <div
                      data-testid="forge-soql-where-warning"
                      role="status"
                      className="mt-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary"
                    >
                      <strong className="font-semibold">
                        {t('forge.soqlUnscopedWarnTitle', { object: templateRoot.objectApiName })}
                      </strong>{' '}
                      {t('forge.soqlUnscopedWarnBody', { cap: SOQL_UNSCOPED_RECORD_CAP })}
                    </div>
                  )}
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

          {/* Object cap — how WIDE discovery may go, where depth says how far.
              A CRM graph is wide as well as deep, and the preview announced a
              truncated graph with nothing here to answer it. */}
          <div>
            <div className="text-[10px] text-text-secondary uppercase tracking-widest mb-2 flex items-center gap-2">
              <label htmlFor="forge-max-nodes">{t('forge.objectCap')}</label>
              <span
                id="forge-max-nodes-hint"
                className="text-text-secondary normal-case tracking-normal text-[10px]"
              >
                — {t('forge.objectCapHint')}
              </span>
            </div>
            <select
              id="forge-max-nodes"
              aria-describedby="forge-max-nodes-hint"
              data-testid="forge-max-nodes"
              value={form.maxNodes === undefined ? 'default' : String(form.maxNodes)}
              onChange={(e) =>
                form.setMaxNodes(e.target.value === 'default' ? undefined : Number(e.target.value))
              }
              className={cn(
                'px-3 py-1.5 rounded-md text-xs',
                'bg-[var(--sf-bg-input)]',
                'text-[var(--sf-text-input)]',
                'border border-[var(--sf-border-input)]',
                'focus:outline-none focus:border-forge/50',
              )}
            >
              <option value="default">{t('forge.objectCapDefault')}</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="350">350</option>
              <option value="500">500</option>
            </select>
          </div>

          {/* Records-per-object cap — keeps big-org clones bounded */}
          <div>
            <div className="text-[10px] text-text-secondary uppercase tracking-widest mb-2 flex items-center gap-2">
              {/* A real <label for>, not a styled <div>: the select had no
                  accessible name at all, so a screen reader announced only
                  "combo box". The name comes from the visible text so voice
                  control matches what the user reads on screen, and the hint
                  is a description rather than part of the name. */}
              <label htmlFor="forge-record-limit">{t('forge.recordLimit')}</label>
              <span
                id="forge-record-limit-hint"
                className="text-text-secondary normal-case tracking-normal text-[10px]"
              >
                — {t('forge.recordLimitHint')}
              </span>
            </div>
            <select
              id="forge-record-limit"
              aria-describedby="forge-record-limit-hint"
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
                className="mt-1.5 text-[10px] text-text-secondary flex items-center gap-1.5"
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
            disabled={!canDiscoverNow}
            onClick={form.handleDiscover}
            className={cn(
              'w-full py-3 rounded-lg font-bold text-sm tracking-wide',
              // A flat fill: a label on a gradient has no one background to be read on.
              'bg-hue-forge text-[var(--sf-bg-primary)]',
              'hover:shadow-lg hover:shadow-forge/20',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none',
              'transition-all flex items-center justify-center gap-2',
            )}
          >
            <Flame size={16} />
            {t('forge.discoverGraph')}
          </button>
          {/* Disabled CTA hint */}
          {!form.canDiscover && (
            <p
              className="text-[10px] text-text-secondary text-center mt-1"
              data-testid="forge-discover-hint"
            >
              {!form.sourceOrgId
                ? t('forge.hintNoSource')
                : !form.targetOrgId
                  ? t('forge.hintNoTarget')
                  : form.sameOrgSelected
                    ? t('forge.hintSameOrg')
                    : form.whereClauseRefused
                      ? t(
                          aliasRefused
                            ? 'forge.hintSoqlAliasRefused'
                            : 'forge.hintSoqlFilterRefused',
                        )
                      : form.objectNameRefused
                        ? t('forge.hintSoqlObjectNameInvalid')
                        : t('forge.hintNoInput')}
            </p>
          )}

          {/* Reuse last graph — skip BFS rediscovery (~30s on large orgs) */}
          {form.canReuseLastGraph && (
            <button
              type="button"
              data-testid="forge-reuse-last-graph-btn"
              onClick={form.handleReuseLastGraph}
              className={cn(
                'w-full py-2 mt-2 rounded-lg text-xs font-medium',
                'border border-forge/30 bg-forge/5 text-hue-forge',
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
                'border border-forge/30 bg-forge/5 text-hue-forge',
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

          {/* Past runs — refill the form from a run the extension kept */}
          <ForgeHistoryPanel
            entries={form.runHistory}
            error={form.historyError}
            onReuseConfig={form.applyHistoryConfig}
          />
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
