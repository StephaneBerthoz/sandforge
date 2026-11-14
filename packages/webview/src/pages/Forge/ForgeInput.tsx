import React, { Suspense } from 'react';
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
  FastForward,
  Flame,
  RefreshCw,
} from 'lucide-react';
import { cn } from '../../theme';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { SeedInsteadHint } from '../../components/ui/SeedInsteadHint';
import { useAppStore } from '../../stores/useAppStore';
import { useForgeForm } from './useForgeForm';
import type { ForgeTabMode } from './useForgeForm';
import { useForgeTemplates } from './useForgeTemplates';
import { ForgeSoqlNotices } from './ForgeSoqlNotices';
import { ForgeAIPanel, ForgeHistoryPanel, ForgeTemplatePanel } from './forgeInputPanels';
import { PartBoundary } from '../../components/ui/PartBoundary';
import { ForgeLivePreviewPanel } from './ForgeLivePreviewPanel';
import { ForgeOrgCard } from './ForgeOrgCard';
import { ForgeDepthChips } from './ForgeDepthChips';
import { ForgeOptionToggles } from './ForgeOptionToggles';
import { soqlRootFilter, starterTemplateKeys } from './forgeUtils';
import { extractRecordId } from '../../utils/recordId';
import { orgDisplayName } from '@sandforge/shared';

/** A starter template's name in the panel's language, as its Template tab says it. */
function starterName(
  t: ReturnType<typeof useTranslation>['t'],
  template: { id: string; name: string },
): string {
  const keys = starterTemplateKeys(template.id);
  return keys ? t(keys.name) : template.name;
}

/** Tab configuration for the Forge input modes. */
interface TabConfig {
  /** Tab identifier matching the input mode it runs from. */
  id: ForgeTabMode;
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
  /* The model drafts the query discovery starts from; the user checks and
     confirms it, and the run is sent as the SOQL run it is. */
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
  const aiAvailable = useAppStore((s) => s.aiAvailable);
  const navigate = useAppStore((s) => s.navigate);
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
  // A clone of the whole org reads no record id: one left in a greyed tab is
  // neither asked for nor refused.
  const templateNeedsRoot =
    !form.wholeOrg && form.inputMode === 'template' && !!form.builtinTplCandidate;
  const recordIdInvalid =
    !form.wholeOrg &&
    (form.inputMode === 'record' || templateNeedsRoot) &&
    form.recordId.trim().length > 0 &&
    extractRecordId(form.recordId) === null;
  /** The CTA gate: everything `canDiscover` asks, plus a record id that parses. */
  const canDiscoverNow = form.canDiscover && !recordIdInvalid;
  /**
   * The query the run would send in this mode: typed, drafted by the AI, or
   * saved in the selected template.
   */
  const runQuery =
    form.inputMode === 'soql'
      ? form.soqlQuery
      : form.inputMode === 'ai'
        ? form.ai.draft
        : (form.templateSoqlQuery ?? '');
  /**
   * The refusal is about the FROM clause, not the WHERE one: an alias there
   * stands for a relationship that starts from no declared alias, so nothing
   * can rewrite the paths headed by it. Saying "shorten the WHERE clause"
   * would name a clause that may be faultless, and point at the wrong fix.
   */
  const aliasRefused = Boolean(soqlRootFilter(runQuery)?.unresolvedAlias);
  /** The carried choices a clone of the whole org still keeps, listed in its note. */
  const narrowing = form.carriedNarrowing;
  /** Each kind of carried choice the note lists, with the objects it names. */
  const narrowingLines = narrowing
    ? (
        [
          ['forge.allCarriedFiltered', narrowing.filtered],
          ['forge.allCarriedExcluded', narrowing.excluded],
          ['forge.allCarriedHeldBack', narrowing.heldBack],
          ['forge.allCarriedFields', narrowing.fields],
        ] as const
      ).filter(([, objects]) => objects.length > 0)
    : [];

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
          className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-status-warning bg-status-warning/10 border border-status-warning/20"
          data-testid="forge-same-org-warning"
        >
          <AlertTriangle size={14} />
          {t('forge.sameOrgWarning')}
        </div>
      )}
      {/* Forge copies from one org into another: with one org, its form can
          only end on "Source and target must be different". */}
      {(form.sameOrgSelected || form.orgs.filter((o) => o.status === 'connected').length < 2) && (
        <SeedInsteadHint testId="forge-seed-instead" />
      )}

      {/* ===== MAIN GRID: Form + Preview ===== */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_260px] gap-4">
        {/* ---- LEFT: Form column ---- */}
        <div className="flex flex-col gap-3">
          {/* Tabs card */}
          <div className="rounded-lg border border-subtle bg-surface-1 overflow-hidden">
            <Tabs.Root
              value={form.inputMode}
              onValueChange={(v) => form.setInputMode(v as ForgeTabMode)}
            >
              <Tabs.List className="flex border-b border-subtle" aria-label={t('nav.forge')}>
                {/* ALL starts from none of these inputs: the tabs are greyed,
                    out of the keyboard's way, and say why on hover. */}
                {TABS.map((tab) => (
                  <Tabs.Trigger
                    key={tab.id}
                    value={tab.id}
                    data-testid={tab.testId}
                    disabled={form.wholeOrg}
                    title={form.wholeOrg ? t('forge.allInputDisabled') : undefined}
                    className={cn(
                      'flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm transition-colors',
                      'text-text-secondary hover:text-text-primary',
                      'data-[state=active]:text-hue-forge data-[state=active]:border-b-2 data-[state=active]:border-forge',
                      'data-[state=active]:bg-surface-2',
                      'disabled:opacity-40 disabled:cursor-not-allowed',
                    )}
                  >
                    {tab.icon}
                    {t(tab.labelKey)}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

              <div className="p-3">
                {/* ALL: in place of the tab's input, why there is none, and
                    what a template or a past run put back in the form still
                    narrows of the whole org, with a way to drop it. Without
                    it, a clone of the whole org went out filtered, or with
                    objects left out, and nothing on the form said so. */}
                {form.wholeOrg && (
                  <div
                    role="note"
                    data-testid="forge-input-all-note"
                    className="flex flex-col gap-2 text-xs text-text-secondary"
                  >
                    <p>{t('forge.allInputDisabled')}</p>
                    {narrowingLines.length > 0 && (
                      <div
                        className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 flex flex-col gap-1 text-text-primary"
                        data-testid="forge-input-all-carried"
                      >
                        <p>{t('forge.allCarried')}</p>
                        <ul className="list-disc pl-4">
                          {narrowingLines.map(([key, objects]) => (
                            <li key={key}>{t(key, { objects: objects.join(', ') })}</li>
                          ))}
                        </ul>
                        <button
                          type="button"
                          data-testid="forge-clear-carried"
                          onClick={form.clearCarried}
                          className={cn(
                            'self-start mt-1 px-2.5 py-1 rounded-md text-[11px] font-medium',
                            'border border-forge/30 bg-forge/5 text-hue-forge',
                            'hover:bg-forge/10 hover:border-forge/50 transition-colors',
                          )}
                        >
                          {t('forge.clearCarried')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {/* Record tab */}
                <Tabs.Content value="record" className="flex flex-col gap-2">
                  {/* The panel stays, empty under ALL: the tab still names it,
                      and a tab naming no panel is what axe refuses. */}
                  {!form.wholeOrg && (
                    <>
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
                            'bg-(--sf-bg-input)',
                            'text-(--sf-text-input)',
                            'border',
                            recordIdInvalid
                              ? 'border-status-error/40'
                              : 'border-(--sf-border-input)',
                            'focus:outline-hidden focus:border-forge/50',
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
                            'border border-(--sf-border-input)',
                            'bg-(--sf-bg-input)',
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
                        <div className="p-2 rounded-md text-sm text-status-error bg-status-error/10 border border-status-error/20">
                          {form.previewError}
                        </div>
                      )}
                    </>
                  )}
                </Tabs.Content>

                {/* SOQL tab */}
                <Tabs.Content value="soql">
                  {!form.wholeOrg && (
                    <>
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
                        // The placeholder was its only name, and it is gone at
                        // the first keystroke; the record field beside it had the
                        // same gap until it was named.
                        aria-label={t('forge.soqlQuery')}
                        rows={5}
                        className={cn(
                          'w-full px-3 py-2 rounded-md text-sm font-mono resize-y',
                          'bg-(--sf-bg-input)',
                          'text-(--sf-text-input)',
                          'border border-(--sf-border-input)',
                          'focus:outline-hidden focus:border-forge/50',
                        )}
                      />
                      <ForgeSoqlNotices
                        query={form.soqlQuery}
                        objectNameRefused={form.objectNameRefused}
                      />
                    </>
                  )}
                </Tabs.Content>

                {/* Template tab — forceMount keeps state alive for CRUD
                    management, and it stays mounted, hidden, under the note of ALL. */}
                <Tabs.Content
                  value="template"
                  forceMount
                  className={form.inputMode !== 'template' || form.wholeOrg ? 'hidden' : ''}
                >
                  <PartBoundary data-testid="forge-templates-failed">
                    <Suspense fallback={null}>
                      <ForgeTemplatePanel
                        manager={templates}
                        selectedTemplate={form.selectedTemplate}
                        onSelectTemplate={form.setSelectedTemplate}
                        onApplyTemplate={form.applyTemplate}
                        orgs={form.orgs}
                      />
                    </Suspense>
                  </PartBoundary>
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
                          'bg-(--sf-bg-input)',
                          'text-(--sf-text-input)',
                          'border',
                          recordIdInvalid ? 'border-status-error/40' : 'border-(--sf-border-input)',
                          'focus:outline-hidden focus:border-forge/50',
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
                      SOQL tab would, so it carries the same verdicts — which
                      the picker used to show none of. */}
                  {form.templateSoqlQuery !== null && (
                    <ForgeSoqlNotices
                      query={form.templateSoqlQuery}
                      objectNameRefused={form.objectNameRefused}
                    />
                  )}
                </Tabs.Content>

                {/* AI tab */}
                <Tabs.Content value="ai">
                  {!form.wholeOrg && (
                    <>
                      <PartBoundary data-testid="forge-ai-failed">
                        <Suspense fallback={null}>
                          <ForgeAIPanel
                            ai={form.ai}
                            aiAvailable={aiAvailable}
                            sourceOrgId={form.sourceOrgId}
                            onOpenSettings={() => navigate('settings', { settingsTab: 'ai' })}
                          />
                        </Suspense>
                      </PartBoundary>
                      {/* The draft is run as a SOQL query, so it carries the SOQL
                      tab's verdicts too. */}
                      <ForgeSoqlNotices
                        query={form.ai.draft}
                        objectNameRefused={form.objectNameRefused}
                      />
                    </>
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
            {/* ALL has no object cap: the select shows so, greyed, and says
                why under it; the cap set before stays for the next run. */}
            <select
              id="forge-max-nodes"
              aria-describedby={
                form.wholeOrg ? 'forge-max-nodes-hint forge-max-nodes-all' : 'forge-max-nodes-hint'
              }
              data-testid="forge-max-nodes"
              disabled={form.wholeOrg}
              value={
                form.wholeOrg
                  ? 'all'
                  : form.maxNodes === undefined
                    ? 'default'
                    : String(form.maxNodes)
              }
              onChange={(e) =>
                form.setMaxNodes(e.target.value === 'default' ? undefined : Number(e.target.value))
              }
              className={cn(
                'px-3 py-1.5 rounded-md text-xs',
                'bg-(--sf-bg-input)',
                'text-(--sf-text-input)',
                'border border-(--sf-border-input)',
                'focus:outline-hidden focus:border-forge/50',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {form.wholeOrg && <option value="all">{t('forge.objectCapAll')}</option>}
              <option value="default">{t('forge.objectCapDefault')}</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="350">350</option>
              <option value="500">500</option>
            </select>
            {form.wholeOrg && (
              <p
                id="forge-max-nodes-all"
                data-testid="forge-max-nodes-all"
                className="mt-1.5 text-[10px] text-text-secondary"
              >
                {t('forge.objectCapAllDisabled')}
              </p>
            )}
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
            {/* ALL copies every record, or a sample of the whole org that fits
                the target, never unless asked: the two are the choice the
                select offers, with what each copies said under it. The
                limit set before stays for the next run walked from a root. */}
            <select
              id="forge-record-limit"
              aria-describedby={
                form.wholeOrg
                  ? 'forge-record-limit-hint forge-record-limit-all'
                  : 'forge-record-limit-hint'
              }
              data-testid="forge-record-limit"
              value={form.wholeOrg ? (form.sampled ? 'sample' : 'every') : form.recordLimit}
              onChange={(e) =>
                form.wholeOrg
                  ? form.setSampled(e.target.value === 'sample')
                  : form.setRecordLimit(e.target.value)
              }
              className={cn(
                'px-3 py-1.5 rounded-md text-xs',
                'bg-(--sf-bg-input)',
                'text-(--sf-text-input)',
                'border border-(--sf-border-input)',
                'focus:outline-hidden focus:border-forge/50',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {form.wholeOrg ? (
                <>
                  <option value="every">{t('forge.recordLimitEvery')}</option>
                  <option value="sample">{t('forge.recordLimitSample')}</option>
                </>
              ) : (
                <>
                  <option value="smart">{t('forge.recordLimitSmart')}</option>
                  <option value="10">{t('forge.recordLimitOpt10')}</option>
                  <option value="50">{t('forge.recordLimitOpt50')}</option>
                  <option value="100">{t('forge.recordLimitOpt100')}</option>
                  <option value="500">{t('forge.recordLimitOpt500')}</option>
                  <option value="1000">{t('forge.recordLimitOpt1000')}</option>
                  <option value="all">{t('forge.recordLimitAll')}</option>
                </>
              )}
            </select>
            {/* What Smart applies to this run: no cap to one record's graph,
                a cap to a run from a query. It named the root object's whole
                table "the org" and sized the cap of a one-record clone by it. */}
            {/* In its place for ALL, which reads past the 50,000 rows per
                object Smart announces for one record: what the choice copies. */}
            {form.wholeOrg && (
              <p
                id="forge-record-limit-all"
                data-testid="forge-record-limit-all"
                className="mt-1.5 text-[10px] text-text-secondary"
              >
                {t(form.sampled ? 'forge.recordLimitSampleHint' : 'forge.recordLimitAllDisabled')}
              </p>
            )}
            {form.recordLimit === 'smart' && !form.wholeOrg && (
              <div
                className="mt-1.5 text-[10px] text-text-secondary"
                data-testid="forge-record-limit-smart-hint"
              >
                {form.recordLimitValue === undefined
                  ? t('forge.recordLimitSmartRecord')
                  : t('forge.recordLimitSmartSoql', { limit: form.recordLimitValue })}
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
            expandOrphanParentsDisabled={form.wholeOrg}
            keepContactPoints={form.keepContactPoints}
            onKeepContactPointsChange={form.setKeepContactPoints}
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
              'bg-hue-forge text-(--sf-bg-primary)',
              'hover:shadow-lg hover:shadow-forge/20',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none',
              'transition-all flex items-center justify-center gap-2',
            )}
          >
            <Flame size={16} />
            {t('forge.discoverGraph')}
          </button>
          {/* Disabled CTA hint. ALL needs no input and sends no query, so it
              is held back by its orgs alone, and the chain below ends on one
              of them before it reaches the hint of a query or an input. */}
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
                        : form.inputMode === 'ai'
                          ? t('forge.hintAiUnchecked')
                          : t('forge.hintNoInput')}
            </p>
          )}

          {/* Clone directly — the discovery, then the run of what it found,
              sent as Review sends it by default, with no stop on the graph or
              Review. Gated as Discover is. What it skips is said here, where
              the path is chosen: the metadata diff and the read of the
              target's automation run on Review only. */}
          <button
            type="button"
            data-testid="forge-clone-directly-btn"
            // Never for a clone of the whole org: it is run from Review, which
            // lists what it leaves out and the personal fields it copies as
            // they are; the extension refuses one started without it.
            disabled={!canDiscoverNow || !form.canCloneDirectly}
            onClick={form.handleCloneDirectly}
            aria-describedby="forge-clone-directly-hint"
            className={cn(
              'w-full py-2 mt-1 rounded-lg text-xs font-medium',
              'border border-forge/30 bg-forge/5 text-hue-forge',
              'hover:bg-forge/10 hover:border-forge/50',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-forge/5',
              'transition-all flex items-center justify-center gap-2',
            )}
          >
            <FastForward size={12} />
            {t('forge.direct.action')}
          </button>
          <p
            id="forge-clone-directly-hint"
            data-testid="forge-clone-directly-hint"
            className="text-[10px] text-text-secondary text-center"
          >
            {t(form.wholeOrg ? 'forge.direct.notAll' : 'forge.direct.hint')}
          </p>

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
              {t('forge.quickStartTemplate', {
                name: starterName(t, form.builtinTplCandidate),
              })}
            </button>
          )}

          {/* Past runs — refill the form from a run the extension kept. Its
              panel, like the template's and the AI's, comes in a chunk of its
              own: one that cannot be read is said in its place, and the input
              stays up. */}
          <PartBoundary data-testid="forge-history-failed">
            <Suspense fallback={null}>
              <ForgeHistoryPanel
                entries={form.runHistory}
                olderRuns={form.olderRuns}
                error={form.historyError}
                onReuseConfig={form.applyHistoryConfig}
                onHistoryChanged={form.refreshHistory}
              />
            </Suspense>
          </PartBoundary>
        </div>

        {/* ---- RIGHT: Live Preview panel ---- */}
        <ForgeLivePreviewPanel
          preview={form.preview}
          inputMode={form.inputMode}
          sourceOrgId={form.sourceOrgId}
          anonymize={form.anonymize}
          onClosePreview={form.closePreview}
          wholeOrg={form.wholeOrg}
          sourceAlias={form.sourceOrg ? orgDisplayName(form.sourceOrg) : ''}
          targetAlias={form.targetOrg ? orgDisplayName(form.targetOrg) : ''}
          sourceHoldsRealData={form.sourceHoldsRealData}
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
