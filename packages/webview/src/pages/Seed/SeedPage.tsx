import React, { Suspense, useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Upload, Copy, ArrowLeft } from 'lucide-react';
import type { SeedTemplate } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import type { NavigationIntent } from '../../stores/useAppStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody } from '../../components/ui/Card';
import { PartBoundary } from '../../components/ui/PartBoundary';
import { TemplateGallery } from './TemplateGallery';
import { useQuickSeed } from './useQuickSeed';
import { focusWhenDrawn } from '../../utils/focusWhenDrawn';
import {
  CloneWizard,
  CsvUploadWizard,
  QuickSeedFlow,
  ScenarioDraft,
  ScenarioFlow,
  SeedGenerateFlow,
  SeedRunHistory,
} from './seedFlows';
import { ScenarioCards } from './Scenario/ScenarioCards';
import type { ScenarioPicked } from './Scenario/scenarioPacks';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';

/**
 * What the Seed page shows: its start — the template gallery, the other ways
 * to seed under it, and the seeds kept — or one of those other ways.
 */
type SeedMode = 'start' | 'generate' | 'csv' | 'clone';

/**
 * Mode a Home recommendation opens on: the clone wizard, or the start, whose
 * gallery a quick-seed recommendation names and which every other way in
 * opens on too.
 */
function modeForIntent(intent: NavigationIntent | null): SeedMode {
  return intent?.seedMode === 'clone' ? 'clone' : 'start';
}

/** The step of each way to seed, which takes the keyboard as the way opens. */
const STEP_CONTENT_OF_MODE: Record<Exclude<SeedMode, 'start'>, string> = {
  generate: 'seed-step-content',
  csv: 'csv-step-content',
  clone: 'clone-step-content',
};

/** What a flow shows while its chunk loads: a few milliseconds from the extension's own folder. */
const FLOW_LOADING = <div aria-busy="true" data-testid="seed-flow-loading" />;

/**
 * Main Seed page. It opens on the template gallery, the one-click way to fill
 * an empty org, with the other ways to seed listed under it.
 *
 * The gallery used to be reached through "AI Generate" then "Start from
 * Scratch", two labels that point away from a template that needs no AI and
 * no field rule, and its "Browse Templates" button did nothing.
 *
 * Each other way is a chunk of its own (`seedFlows`), loaded when it opens.
 * The wizard, once opened, stays mounted while the page shows another way:
 * a run it started goes on reporting to it. Each is kept to its own place
 * when it fails (`PartBoundary`): a CSV import whose file could not be
 * fetched took the gallery, the way back and the page's header with it.
 */
export const SeedPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useAppStore((s) => s.navigate);
  // Home's recommendation, read once on open: the page lands on the mode it
  // names, the clone wizard on its source org and the template gallery on the
  // org the confirmation named.
  const [intent] = useState<NavigationIntent | null>(() => {
    const pending = useAppStore.getState().navigationIntent;
    return pending?.route === 'seed' ? pending : null;
  });
  const quickSeed = useQuickSeed({
    initialOrgId: intent?.seedMode === 'quick-seed' ? intent.targetOrgId : undefined,
  });
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  useEffect(() => {
    if (intent) clearNavigationIntent();
  }, [intent, clearNavigationIntent]);
  const [seedMode, setSeedMode] = useState<SeedMode>(() => modeForIntent(intent));
  /** Whether the wizard has been opened: from then on it stays mounted. */
  const [generateOpened, setGenerateOpened] = useState(false);
  useEffect(() => {
    if (seedMode === 'generate') setGenerateOpened(true);
  }, [seedMode]);
  /** Recommended clone source; dropped once the user leaves clone mode. */
  const [recommendedCloneSource, setRecommendedCloneSource] = useState(
    intent?.seedMode === 'clone' ? intent.sourceOrgId : undefined,
  );
  useEffect(() => {
    if (seedMode !== 'clone') setRecommendedCloneSource(undefined);
  }, [seedMode]);

  const startQuickSeed = quickSeed.startQuickSeed;
  /** The gallery card a template's run was started from. */
  const pickedTemplate = useRef<string | null>(null);
  const handleSelectTemplate = useCallback(
    (template: SeedTemplate) => {
      pickedTemplate.current = template.id;
      startQuickSeed(template);
    },
    [startQuickSeed],
  );
  /*
   * Back from a template's run — its Back, or Back to the gallery on its
   * results — the gallery is drawn in place of the flow, and the button
   * pressed went with it: the keyboard goes back to the card it was picked
   * from, not to the top of the panel.
   */
  const pageRef = useRef<HTMLDivElement>(null);
  const quickSeedPhase = quickSeed.phase;
  const phaseBefore = useRef(quickSeedPhase);
  useEffect(() => {
    const before = phaseBefore.current;
    phaseBefore.current = quickSeedPhase;
    const page = pageRef.current;
    const picked = pickedTemplate.current;
    if (quickSeedPhase !== 'idle' || before === 'idle' || picked === null || !page) {
      return undefined;
    }
    // The gallery asks for its templates again: its card is drawn once they are in.
    const cardId = `template-card-${picked}`;
    return focusWhenDrawn(
      page,
      () =>
        Array.from(page.querySelectorAll<HTMLElement>('[data-testid^="template-card-"]'))
          .find((card) => card.dataset.testid === cardId)
          ?.querySelector<HTMLElement>('[data-testid="btn-use-template"]') ?? null,
    );
  }, [quickSeedPhase]);
  const backToStart = useCallback(() => setSeedMode('start'), []);
  /*
   * A way to seed is drawn in place of the start, and the card pressed went
   * with it; Back draws the start in place of the way, and went with it too.
   * The focus fell to the panel's top each time: the next Tab started over at
   * the skip link, and nothing was said of what was shown. A way opened takes
   * the keyboard on its step, named after it, once its chunk has drawn it;
   * Back gives it to the card of the way left. Only from nowhere: a control
   * the user moved to meanwhile keeps it.
   */
  const modeShown = useRef(seedMode);
  useEffect(() => {
    const before = modeShown.current;
    modeShown.current = seedMode;
    const page = pageRef.current;
    if (before === seedMode || !page) return undefined;
    const target = seedMode === 'start' ? `mode-card-${before}` : STEP_CONTENT_OF_MODE[seedMode];
    return focusWhenDrawn(page, () => page.querySelector<HTMLElement>(`[data-testid="${target}"]`));
  }, [seedMode]);
  /**
   * Whether the CSV import or the clone is running: its way back is hidden
   * meanwhile. Leaving stopped nothing — the run went on writing — and lost
   * its answer with the flow it unmounted.
   */
  const [flowRunning, setFlowRunning] = useState(false);
  /**
   * A scenario pack opened from the gallery — its review, its seed, its
   * test file — or the draft of one from the user's own text, drawn in
   * place of the gallery as a template's run is.
   */
  const [scenario, setScenario] = useState<
    { kind: 'picked'; picked: ScenarioPicked } | { kind: 'draft' } | null
  >(null);
  const closeScenario = useCallback(() => setScenario(null), []);
  const pickScenario = useCallback(
    (picked: ScenarioPicked) => setScenario({ kind: 'picked', picked }),
    [],
  );
  const draftScenario = useCallback(() => setScenario({ kind: 'draft' }), []);
  const drafted = useCallback(
    (pack: ScenarioPicked['pack']) =>
      setScenario({ kind: 'picked', picked: { pack, source: { kind: 'draft' } } }),
    [],
  );
  /*
   * Back from a scenario, the gallery is drawn in its place and the button
   * pressed went with it: the keyboard goes back to the card it was opened
   * from, once the cards are drawn again.
   */
  const scenarioShown = useRef(scenario);
  useEffect(() => {
    const before = scenarioShown.current;
    scenarioShown.current = scenario;
    const page = pageRef.current;
    if (scenario !== null || before === null || !page) return undefined;
    const card =
      before.kind === 'picked' && before.picked.source.kind !== 'draft'
        ? `[data-testid="scenario-card-${before.picked.pack.id}"] [data-testid="btn-review-scenario"]`
        : '[data-testid="btn-draft-scenario"]';
    return focusWhenDrawn(page, () => page.querySelector<HTMLElement>(card));
  }, [scenario]);

  if (orgs.length === 0) {
    return (
      <EmptyState
        module="seed"
        title={t('seed.emptyState.title')}
        description={t('moduleSummary.seed')}
        steps={[
          t('emptyState.connectViaSfdx'),
          t('seed.emptyState.step2'),
          t('seed.emptyState.step3'),
          t('seed.emptyState.step4'),
        ]}
        actionLabel={t('emptyState.connectOrg')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  /* Determine page subtitle based on mode; the wizard says its own step */
  const getPageSubtitle = (): string => {
    if (seedMode === 'csv') return t('seed.modeSelect.csv');
    if (seedMode === 'clone') return t('seed.modeSelect.clone');
    if (scenario !== null) return t('seed.scenario.section.title');
    if (quickSeed.phase !== 'idle') return t('seed.quickSeed.title');
    return t('seed.start.subtitle');
  };

  return (
    <div
      ref={pageRef}
      className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)"
      data-testid="seed-page"
    >
      {/* The wizard has a header of its own, which says its step and org. */}
      {seedMode !== 'generate' && (
        <PageHeader title={t('seed.title')} subtitle={getPageSubtitle()} icon="database" />
      )}

      {seedMode === 'start' && <ModuleHowTo module="seed" />}

      {/* Back to the start, from the CSV import or the clone */}
      {(seedMode === 'csv' || seedMode === 'clone') && !flowRunning && (
        <button
          className="flex items-center gap-1 text-xs text-(--sf-text-link) hover:underline self-start"
          onClick={backToStart}
          data-testid="back-to-modes"
        >
          <ArrowLeft className="w-3 h-3" />
          {t('seed.quickSeed.backToGallery')}
        </button>
      )}

      {/* ----- START: the gallery, a template's run, the other ways ----- */}
      {seedMode === 'start' &&
        (scenario !== null ? (
          <PartBoundary data-testid="seed-scenario-failed">
            <Suspense fallback={FLOW_LOADING}>
              {scenario.kind === 'draft' ? (
                <ScenarioDraft orgs={orgs} onDrafted={drafted} onBack={closeScenario} />
              ) : (
                <ScenarioFlow picked={scenario.picked} orgs={orgs} onClose={closeScenario} />
              )}
            </Suspense>
          </PartBoundary>
        ) : quickSeed.phase !== 'idle' ? (
          <PartBoundary data-testid="seed-quick-failed">
            <Suspense fallback={FLOW_LOADING}>
              <QuickSeedFlow quickSeed={quickSeed} orgs={orgs} />
            </Suspense>
          </PartBoundary>
        ) : (
          <>
            <TemplateGallery onSelectTemplate={handleSelectTemplate} />

            <ScenarioCards onPick={pickScenario} onDraft={draftScenario} />

            <section className="flex flex-col gap-(--sf-space-2)" data-testid="seed-other-ways">
              <h2 className="text-sm font-semibold text-(--sf-text-primary)">
                {t('seed.start.otherWays')}
              </h2>
              <div className="grid grid-cols-3 gap-3" data-testid="seed-mode-selector">
                <Card
                  hoverable
                  onClick={() => setSeedMode('generate')}
                  data-testid="mode-card-generate"
                >
                  <CardBody>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Sparkles className="w-8 h-8 text-(--sf-text-link)" />
                      <span className="text-sm font-semibold text-text-primary">
                        {t('seed.modeSelect.generate')}
                      </span>
                      <span className="text-xs text-text-secondary text-center">
                        {t('seed.modeSelect.generateDesc')}
                      </span>
                    </div>
                  </CardBody>
                </Card>

                <Card hoverable onClick={() => setSeedMode('csv')} data-testid="mode-card-csv">
                  <CardBody>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Upload className="w-8 h-8 text-hue-green" />
                      <span className="text-sm font-semibold text-text-primary">
                        {t('seed.modeSelect.csv')}
                      </span>
                      <span className="text-xs text-text-secondary text-center">
                        {t('seed.modeSelect.csvDesc')}
                      </span>
                    </div>
                  </CardBody>
                </Card>

                <Card hoverable onClick={() => setSeedMode('clone')} data-testid="mode-card-clone">
                  <CardBody>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Copy className="w-8 h-8 text-hue-amber" />
                      <span className="text-sm font-semibold text-text-primary">
                        {t('seed.modeSelect.clone')}
                      </span>
                      <span className="text-xs text-text-secondary text-center">
                        {t('seed.modeSelect.cloneDesc')}
                      </span>
                    </div>
                  </CardBody>
                </Card>
              </div>
            </section>

            {/* The seeds kept, which a reload left removable */}
            <PartBoundary data-testid="seed-history-failed">
              <Suspense fallback={null}>
                <SeedRunHistory />
              </Suspense>
            </PartBoundary>
          </>
        ))}

      {/* ----- CSV UPLOAD MODE ----- */}
      {seedMode === 'csv' && (
        <PartBoundary data-testid="seed-csv-failed">
          <Suspense fallback={FLOW_LOADING}>
            <CsvUploadWizard onBack={backToStart} onRunningChange={setFlowRunning} />
          </Suspense>
        </PartBoundary>
      )}

      {/* ----- CLONE MODE ----- */}
      {seedMode === 'clone' && (
        <PartBoundary data-testid="seed-clone-failed">
          <Suspense fallback={FLOW_LOADING}>
            <CloneWizard
              onBack={backToStart}
              initialSourceOrgId={recommendedCloneSource}
              onRunningChange={setFlowRunning}
            />
          </Suspense>
        </PartBoundary>
      )}

      {/* ----- GENERATE: the wizard, kept once opened ----- */}
      {(generateOpened || seedMode === 'generate') && (
        <PartBoundary data-testid="seed-generate-failed">
          <Suspense fallback={seedMode === 'generate' ? FLOW_LOADING : null}>
            <SeedGenerateFlow active={seedMode === 'generate'} onBack={backToStart} />
          </Suspense>
        </PartBoundary>
      )}
    </div>
  );
};
