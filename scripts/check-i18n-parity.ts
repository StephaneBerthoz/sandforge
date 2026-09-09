/**
 * i18n parity gate.
 *
 * Section 1 — webview locales: loads `packages/webview/src/i18n/locales/en.json`
 * as the reference, flattens its nested keys, and for every other locale reports:
 *
 *   - missing keys  (present in en.json, absent from the locale)
 *   - orphan keys   (present in the locale, absent from en.json)
 *
 * Section 2 — extension manifest: loads `packages/extension/package.nls.json`
 * as the reference and applies the same missing/orphan check to every
 * `package.nls.*.json` locale file (flat key-value maps, no plural handling).
 *
 * Section 3 — code vs catalogue (blocking): parity between six files proves
 * nothing about the seventh party, the source. Three ways a string escapes the
 * catalogue entirely: a hardcoded `aria-label="…"` (invisible to sighted
 * reviewers AND to the translator), a `t('k')` whose key no locale defines (the
 * raw key renders), and an inline `t('k', 'English')` default for such a key —
 * the default renders in all six languages, so the gap never surfaces as a
 * missing translation.
 *
 * Section 4 — values byte-identical to English (report only), restricted to
 * multi-word values: a lone token shared with English is usually a proper noun,
 * an acronym or a unit, whereas a sentence is untranslated copy. The legitimate
 * multi-word cases live in `scripts/i18n-identical-allowlist.json`.
 *
 * Section 5 — French accents (report only). French written without accents
 * passes every structural check while reading as broken to a French user.
 *
 * Section 6 — catalogue vs code (blocking on new entries only). Keys no source
 * file mentions. Runtime-built keys (`t(`a.b.${x}`)`) are exempted by prefix,
 * and the count that existed when the section landed is the baseline. That
 * baseline is a ratchet: it may only shrink, and an entry that stops being an
 * unreferenced catalogue key fails the run until it is deleted from it.
 *
 * Plural handling (webview only): i18next (Intl.PluralRules) only has the
 * `other` category for Japanese, so `*_one` keys are not required in
 * `ja.json`. Every other supported locale (fr, de, es, pt-BR) has a `one`
 * category like English.
 *
 * Output is deterministic (keys sorted). Exits 1 when any locale drifts
 * from the reference; pass `--report` to print the report without failing.
 *
 * Run with:  pnpm check:i18n
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEBVIEW_LOCALES_DIR = join(__dirname, '..', 'packages', 'webview', 'src', 'i18n', 'locales');
const WEBVIEW_REFERENCE = 'en.json';

const EXTENSION_DIR = join(__dirname, '..', 'packages', 'extension');
const MANIFEST_REFERENCE = 'package.nls.json';

const WEBVIEW_SRC = join(__dirname, '..', 'packages', 'webview', 'src');
const IDENTICAL_ALLOWLIST = join(__dirname, 'i18n-identical-allowlist.json');

/** Locales whose i18next plural rules have no `one` category (Intl.PluralRules). */
const NO_ONE_CATEGORY = new Set(['ja']);

type JsonObject = Record<string, unknown>;

/** Flatten a nested locale object into `a.b.c` -> string leaf entries. */
function flatten(
  obj: JsonObject,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as JsonObject, path, out);
    } else if (typeof value === 'string') {
      out.set(path, value);
    }
  }
  return out;
}

function loadLocale(dir: string, file: string): Map<string, string> {
  const text = readFileSync(join(dir, file), 'utf8');
  return flatten(JSON.parse(text) as JsonObject);
}

/**
 * Compare every locale file in `dir` against `referenceFile`.
 * Returns true when at least one locale drifts from the reference.
 */
function checkParity(options: {
  dir: string;
  referenceFile: string;
  header: string;
  /** Extra filter for candidate locale files (beyond `.json` and not the reference). */
  localeFilePattern?: RegExp;
  /** Drop `*_one` keys from the expected set for these locales (i18next plural rules). */
  noOneCategory?: Set<string>;
}): boolean {
  const { dir, referenceFile, header, localeFilePattern, noOneCategory } = options;

  const reference = loadLocale(dir, referenceFile);
  const referenceKeys = [...reference.keys()];

  const localeFiles = readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith('.json') &&
        f !== referenceFile &&
        (localeFilePattern === undefined || localeFilePattern.test(f)),
    )
    .sort();

  let hasDrift = false;

  console.log(`${header} — reference ${referenceFile}: ${referenceKeys.length} keys\n`);

  for (const file of localeFiles) {
    const locale = file.replace(/\.json$/, '').replace(/^package\.nls\./, '');
    const keys = loadLocale(dir, file);

    // *_one plural keys are only required for locales with a `one` category.
    const expected =
      noOneCategory?.has(locale) === true
        ? referenceKeys.filter((k) => !k.endsWith('_one'))
        : referenceKeys;

    const missing = expected.filter((k) => !keys.has(k)).sort();
    const orphan = [...keys.keys()].filter((k) => !reference.has(k)).sort();

    const coverage = (((expected.length - missing.length) / expected.length) * 100).toFixed(1);

    if (missing.length === 0 && orphan.length === 0) {
      console.log(`✓ ${locale}: ${expected.length}/${expected.length} keys (100%)`);
      continue;
    }

    hasDrift = true;
    console.log(
      `✗ ${locale}: ${expected.length - missing.length}/${expected.length} keys (${coverage}%)`,
    );
    if (missing.length > 0) {
      console.log(`  missing (${missing.length}):`);
      for (const k of missing) console.log(`    - ${k}`);
    }
    if (orphan.length > 0) {
      console.log(`  orphan (${orphan.length}):`);
      for (const k of orphan) console.log(`    - ${k}`);
    }
  }

  return hasDrift;
}

/** Every non-test source file under `packages/webview/src`. */
function webviewSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) webviewSources(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** `a.b` resolves if the key exists, or if its plural variants do. */
function resolves(key: string, reference: Map<string, string>): boolean {
  if (reference.has(key)) return true;
  return ['zero', 'one', 'two', 'few', 'many', 'other'].some((c) => reference.has(`${key}_${c}`));
}

/**
 * Every `t('a.b')` whose literal is the *complete* first argument. The trailing
 * `[),]` is what rules out `t('a.b.' + type)` and `` t(`a.b.${type}`) ``: those
 * literals are prefixes, and the key only exists once the component renders —
 * section 6 covers them by prefix instead.
 */
const LITERAL_KEY = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*[),]/g;

/** The same call with an English fallback: `t('k', 'Default')` / `{ defaultValue }`. */
const LITERAL_DEFAULT = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*(?:'|")/g;
const OPTION_DEFAULT = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*\{[^}]*defaultValue\s*:/g;

/** Every key captured by `pattern` in `source`, deduplicated. */
function matchedKeys(pattern: RegExp, source: string): Set<string> {
  const keys = new Set<string>();
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) keys.add(match[1]);
  return keys;
}

/**
 * Section 3 — the three ways a user-visible string bypasses the catalogue.
 * Returns true when at least one violation was found.
 */
function checkSources(reference: Map<string, string>): boolean {
  const files = webviewSources(WEBVIEW_SRC);
  const hardcodedLabels: string[] = [];
  const unresolvedKeys: string[] = [];
  const unbackedDefaults: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const label = relative(WEBVIEW_SRC, file).replace(/\\/g, '/');

    if (file.endsWith('.tsx')) {
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        if (line.includes('aria-label="')) hardcodedLabels.push(`${label}:${i + 1}`);
      });
    }

    const withDefault = new Set([
      ...matchedKeys(LITERAL_DEFAULT, source),
      ...matchedKeys(OPTION_DEFAULT, source),
    ]);

    for (const key of matchedKeys(LITERAL_KEY, source)) {
      // A dotless literal is a namespace or a sentinel, never a catalogue path.
      if (!key.includes('.') || resolves(key, reference)) continue;
      const site = `${key} (${label})`;
      if (withDefault.has(key)) unbackedDefaults.push(site);
      else unresolvedKeys.push(site);
    }
  }

  console.log(`i18n source scan — ${files.length} files\n`);

  if (hardcodedLabels.length === 0) {
    console.log('✓ aria-label: every accessible name goes through t()');
  } else {
    console.log(`✗ aria-label: ${hardcodedLabels.length} hardcoded English literal(s):`);
    for (const l of [...new Set(hardcodedLabels)].sort()) console.log(`    - ${l}`);
  }

  const unresolved = [...new Set(unresolvedKeys)].sort();
  if (unresolved.length === 0) {
    console.log('✓ t() keys: every literal key resolves against en.json');
  } else {
    console.log(`✗ t() keys: ${unresolved.length} key(s) absent from en.json (renders raw):`);
    for (const k of unresolved) console.log(`    - ${k}`);
  }

  const unbacked = [...new Set(unbackedDefaults)].sort();
  if (unbacked.length === 0) {
    console.log('✓ inline defaults: every t() default is backed by an en.json entry');
  } else {
    console.log(`✗ inline defaults: ${unbacked.length} key(s) absent from en.json:`);
    for (const k of unbacked) console.log(`    - ${k}`);
  }

  return hardcodedLabels.length > 0 || unresolved.length > 0 || unbacked.length > 0;
}

/**
 * Prose, as opposed to a token. A lone word shared with English — "Total",
 * "Import", an acronym, a bare `{{count}}` — is common enough across languages
 * that flagging it would drown the signal in false positives; a sentence that
 * came back from translation byte-for-byte did not come back by coincidence.
 */
function isProse(value: string): boolean {
  return value.trim().split(/\s+/).length > 1;
}

/**
 * Section 4 — non-EN prose byte-identical to the English one.
 *
 * Blocking since v1.19.0. It was report-only, which meant a release could ship
 * with prose that had never been translated and nothing stopped it: the count
 * sat at 14 while the product advertised six languages. Now that the list is
 * empty, blocking costs nothing and keeps it that way — a value that is
 * genuinely identical in another language ("Type incompatible" in French) goes
 * in `i18n-identical-allowlist.json` as a decision, not as a silent tolerance.
 *
 * @returns The number of offending keys — non-zero fails the run.
 */
function reportIdenticalValues(reference: Map<string, string>): number {
  const allowlist = new Set<string>(
    (JSON.parse(readFileSync(IDENTICAL_ALLOWLIST, 'utf8')) as { keys: string[] }).keys,
  );

  const perKey = new Map<string, string[]>();
  for (const file of readdirSync(WEBVIEW_LOCALES_DIR).sort()) {
    if (!file.endsWith('.json') || file === WEBVIEW_REFERENCE) continue;
    const locale = file.replace(/\.json$/, '');
    for (const [key, value] of loadLocale(WEBVIEW_LOCALES_DIR, file)) {
      if (allowlist.has(key) || reference.get(key) !== value || !isProse(value)) continue;
      if (!perKey.has(key)) perKey.set(key, []);
      perKey.get(key)?.push(locale);
    }
  }

  if (perKey.size === 0) {
    console.log('✓ identical-to-English: no untranslated prose outside the allowlist');
    return 0;
  }
  console.log(`✗ identical-to-English: ${perKey.size} value(s) still carrying the English copy:`);
  for (const key of [...perKey.keys()].sort()) {
    console.log(`    - ${key} [${perKey.get(key)?.join(', ')}]`);
  }
  console.log(
    '    Translate them, or add the ones that are legitimately identical to ' +
      'scripts/i18n-identical-allowlist.json.',
  );
  return perKey.size;
}

/**
 * Section 5 — French values spelled without their accents. Report only: the
 * word list is a heuristic, and a false positive must not block a release.
 */
const FRENCH_UNACCENTED =
  /\b(Termine|Cree|Donnees|Parametre|Selectionn|execution|operation|Echec|reussi|genere|requete|deja|apres|securite|defaut|Modele|Delai|Etape|etape|Executer|qualite|Duree|Apercu|regles?|Resultat|dependance)\b/;

function reportFrenchAccents(): void {
  const offenders: string[] = [];
  for (const [key, value] of loadLocale(WEBVIEW_LOCALES_DIR, 'fr.json')) {
    const hit = FRENCH_UNACCENTED.exec(value);
    if (hit) offenders.push(`${key} — "${hit[1]}"`);
  }
  if (offenders.length === 0) {
    console.log('✓ French accents: no unaccented form from the watch list');
    return;
  }
  console.log(`! French accents: ${offenders.length} value(s) missing an accent:`);
  for (const o of offenders.sort()) console.log(`    - ${o}`);
}

/**
 * Baseline for section 6: keys already unreferenced when the section landed.
 * They belong to modules whose fate is decided elsewhere (DEADCODE-03), so the
 * gate only blocks keys added on top of this list.
 *
 * An entry earns its place by being unreferenced *and* defined in en.json. The
 * moment either stops holding — a consumer comes back, the key leaves the
 * catalogue — `auditBaseline` fails the run until the entry is deleted from
 * here. Three entries left on the day the ratchet landed, `org.status_error`
 * among them: `OrgManagerPage` had been rendering it all along, while the sweep
 * that read the key was writing it down as dead in the same commit. A list
 * nobody can leave is a list that stops describing anything.
 */
const UNREFERENCED_BASELINE: readonly string[] = [
  'ai.avgLatency',
  'ai.error.cancelled',
  'ai.thinking',
  'ai.tokenUsage',
  'ai.totalCalls',
  'audit.allStatuses',
  'audit.allTypes',
  'audit.duration',
  'audit.entries',
  'audit.error',
  'audit.exportCsv',
  'audit.exportJson',
  'audit.failure',
  'audit.filter',
  'audit.noEntries',
  'audit.operationType',
  'audit.org',
  'audit.partial',
  'audit.records',
  'audit.searchPlaceholder',
  'audit.success',
  'audit.title',
  'audit.user',
  'automation.addStep',
  'automation.addVariable',
  'automation.avgDuration',
  'automation.condition',
  'automation.deletePipeline',
  'automation.editPipeline',
  'automation.execution',
  'automation.lastRun',
  'automation.loadPipeline',
  'automation.moveDown',
  'automation.moveUp',
  'automation.noCondition',
  'automation.onFailure',
  'automation.onSuccess',
  'automation.pipelineDesc',
  'automation.pipelineName',
  'automation.pipelines',
  'automation.removeStep',
  'automation.removeTrigger',
  'automation.removeVariable',
  'automation.status',
  'automation.stepResults',
  'automation.successRate',
  'automation.tags',
  'automation.totalRuns',
  'automation.variables',
  'automation.version',
  'autopilot.control.retry',
  'autopilot.status.completed',
  'autopilot.status.executing',
  'autopilot.status.failed',
  'autopilot.status.idle',
  'autopilot.status.paused',
  'autopilot.step1.sameOrgWarning',
  'autopilot.step1.selectSource',
  'autopilot.step1.selectTarget',
  'autopilot.step2.deselectAll',
  'autopilot.step2.noObjects',
  'autopilot.step2.searchObjects',
  'autopilot.step4.cycles',
  'autopilot.subtitle',
  'autopilot.wizard.step1',
  'autopilot.wizard.step2',
  'autopilot.wizard.step3',
  'autopilot.wizard.step4',
  'bridge.connected',
  'bridge.connecting',
  'bridge.disconnected',
  'bridge.notYetConnected',
  'bridge.orgConnected',
  'bridge.orgDisconnected',
  'bridge.settingsSaved',
  'bridge.syncReceived',
  'combobox.noResults',
  'combobox.search',
  'combobox.selected',
  'common.changeCount_one',
  'common.changeCount_other',
  'common.createdBy',
  'common.filter',
  'common.refresh',
  'common.search',
  'common.success',
  'common.toggleSidebar',
  'common.versionLabel',
  'common.warning',
  'compare.breaking',
  'compare.componentType',
  'compare.deployable',
  'compare.impact',
  'compare.lastModifiedBy',
  'compare.lastModifiedDate',
  'compare.results',
  'compare.selectCategories',
  'compare.selectOrgs',
  'dataops.archive',
  'dataops.avgResolution',
  'dataops.backupSize',
  'dataops.backupStatus',
  'dataops.cleanupDesc',
  'dataops.complianceSummary',
  'dataops.compression',
  'dataops.createDSR',
  'dataops.days',
  'dataops.dryRun',
  'dataops.dsrAccess',
  'dataops.dsrErasure',
  'dataops.dsrList',
  'dataops.dsrPortability',
  'dataops.dsrRectification',
  'dataops.dsrRestriction',
  'dataops.encryption',
  'dataops.includeFiles',
  'dataops.lastBackup',
  'dataops.masking.apply',
  'dataops.masking.clearAll',
  'dataops.masking.description',
  'dataops.masking.fields',
  'dataops.masking.noTemplates',
  'dataops.masking.search',
  'dataops.masking.selectAll',
  'dataops.masking.selectRecommended',
  'dataops.masking.title',
  'dataops.massDelete',
  'dataops.newDSR',
  'dataops.noDSR',
  'dataops.noPII',
  'dataops.noResults',
  'dataops.normalizeEmails',
  'dataops.normalizePhones',
  'dataops.objects',
  'dataops.overdueDSR',
  'dataops.overdueDSRWarning',
  'dataops.passRate',
  'dataops.pendingDSR',
  'dataops.piiScan',
  'dataops.processDSR',
  'dataops.qualityDesc',
  'dataops.qualityRules.completeness',
  'dataops.qualityRules.consistency',
  'dataops.qualityRules.format',
  'dataops.qualityRules.freshness',
  'dataops.qualityRules.range',
  'dataops.qualityRules.referential',
  'dataops.qualityRules.uniqueness',
  'dataops.qualityScore',
  'dataops.recommendation',
  'dataops.recordsArchived',
  'dataops.recordsDeleted',
  'dataops.recordsRestored',
  'dataops.recycleBin',
  'dataops.removeDuplicates',
  'dataops.removeEmpty',
  'dataops.restoreComplete',
  'dataops.restoreFailed',
  'dataops.restoreTarget',
  'dataops.retentionDays',
  'dataops.runPIIScan',
  'dataops.runScan',
  'dataops.sampleFailures',
  'dataops.scanResults',
  'dataops.schedule',
  'dataops.storageOptimizer',
  'dataops.storageSaved',
  'dataops.subjectEmail',
  'dataops.subjectName',
  'dataops.template',
  'dataops.totalDSR',
  'dataops.trimWhitespace',
  'emptyState.automationAction',
  'emptyState.automationEncouragement',
  'emptyState.compareAction',
  'emptyState.compareEncouragement',
  'emptyState.dataopsAction',
  'emptyState.dataopsEncouragement',
  'emptyState.encouragement',
  'emptyState.monitorAction',
  'emptyState.monitorEncouragement',
  'emptyState.seedAction',
  'emptyState.seedEncouragement',
  'emptyState.startTour',
  'emptyState.syncAction',
  'emptyState.syncEncouragement',
  'emptyState.viewDocs',
  'execution.aborted',
  'execution.background.operationAborted',
  'execution.background.operationRunning',
  'execution.background.seedCompleted',
  'execution.background.seedFailed',
  'execution.background.showDetails',
  'execution.background.syncCompleted',
  'execution.background.syncFailed',
  'execution.complete',
  'execution.failed',
  'execution.failedRecords',
  'execution.overallProgress',
  'execution.processing',
  'execution.queued',
  'execution.recordsOf',
  'forge.etaUnknown',
  'forge.executionLogs',
  'forge.lastUsed',
  'forge.logsCopied',
  'forge.logsExported',
  'forge.metadataMismatch',
  'forge.previewRecord',
  'forge.scrollPaused',
  'forge.skipMetadata',
  'forge.smartLimitOverride',
  'forge.sortBy',
  'forge.syncMetadata',
  'forge.templates',
  'forge.useTemplate',
  'governance.categories.compliance',
  'governance.categories.custom',
  'governance.categories.performance',
  'governance.categories.security',
  'governance.fail',
  'governance.pass',
  'governance.warning',
  'guidedTour.automationTour',
  'guidedTour.automationTourDesc',
  'guidedTour.compareTour',
  'guidedTour.compareTourDesc',
  'guidedTour.dataopsTour',
  'guidedTour.dataopsTourDesc',
  'guidedTour.finish',
  'guidedTour.forgeTour',
  'guidedTour.forgeTourDesc',
  'guidedTour.general',
  'guidedTour.generalDesc',
  'guidedTour.monitorTour',
  'guidedTour.monitorTourDesc',
  'guidedTour.next',
  'guidedTour.previous',
  'guidedTour.seedTour',
  'guidedTour.seedTourDesc',
  'guidedTour.skip',
  'guidedTour.stepOf',
  'guidedTour.syncTour',
  'guidedTour.syncTourDesc',
  'help.clone.sourcePicker',
  'help.documentation',
  'help.documentationDesc',
  'help.faqDesc',
  'help.home.quickActions',
  'help.shortcutsDesc',
  'help.support',
  'help.supportDesc',
  'help.sync.direction',
  'help.version',
  'help.viewDocs',
  'hints.checkMonitor',
  'hints.compareOrgs',
  'hints.configureSettings',
  'hints.connectFirstOrg',
  'hints.dontShowHint',
  'hints.exploreSyncModule',
  'hints.gotIt',
  'hints.setupAutomation',
  'hints.trySeedModule',
  'hints.useDataOps',
  'home.ago',
  'home.hoursAgo',
  'home.justNow',
  'home.minutesAgo',
  'home.operationError',
  'home.operationSuccess',
  'home.operationWarning',
  'home.quickSync',
  'home.smartAction.reasonClone',
  'home.smartAction.reasonEmpty',
  'home.smartAction.reasonSync',
  'home.subtitle',
  'home.title',
  'monitor.anomaliesCount',
  'monitor.asyncExecs',
  'monitor.autoRefreshOff',
  'monitor.autoRefreshOn',
  'monitor.chooseOrg',
  'monitor.critical',
  'monitor.deployments.deployer',
  'monitor.deployments.status',
  'monitor.lastUpdated',
  'monitor.licenses',
  'monitor.limitMax',
  'monitor.limitName',
  'monitor.limitStatus',
  'monitor.limitUsage',
  'monitor.limitUsed',
  'monitor.limits',
  'monitor.limitsSubtitle',
  'monitor.liveOps.elapsed',
  'monitor.liveOps.throughput',
  'monitor.orgApexClasses',
  'monitor.orgFlows',
  'monitor.orgHealth.critical',
  'monitor.orgHealth.emptyDescription',
  'monitor.orgHealth.healthy',
  'monitor.orgHealth.needsAttention',
  'monitor.orgHealth.overallScore',
  'monitor.orgHealth.recommendations',
  'monitor.orgHealth.scan',
  'monitor.orgHealth.title',
  'monitor.orgInstance',
  'monitor.orgObjects',
  'monitor.orgUsers',
  'monitor.pageSubtitle',
  'monitor.pageTitle',
  'monitor.refreshing',
  'monitor.sectionError',
  'monitor.storage.objects',
  'monitor.storage.percentage',
  'monitor.storage.records',
  'monitor.title',
  'monitor.trendDown',
  'monitor.trendStable',
  'monitor.trendUp',
  'monitor.warnings',
  'notifications.categoryMonitor',
  'notifications.categorySchedule',
  'notifications.categorySeed',
  'notifications.categorySync',
  'notifications.categorySystem',
  'notifications.clearAll',
  'notifications.earlier',
  'notifications.filterAll',
  'notifications.filterError',
  'notifications.filterInfo',
  'notifications.filterSuccess',
  'notifications.filterWarning',
  'notifications.markAllRead',
  'notifications.noMatching',
  'notifications.noNotifications',
  'notifications.searchPlaceholder',
  'notifications.title',
  'notifications.today',
  'onboarding.finishDesc',
  'onboarding.finishTitle',
  'onboarding.getStarted',
  'onboarding.learnMore',
  'onboarding.modules.automation',
  'onboarding.modules.compare',
  'onboarding.modules.dataops',
  'onboarding.modules.monitor',
  'onboarding.modules.seed',
  'onboarding.modules.sync',
  'onboarding.populateSandboxDesc',
  'onboarding.previousVersions',
  'onboarding.whatsNewSubtitle',
  'org.developer',
  'org.production',
  'org.scratch',
  'org.status_connected',
  'org.status_expired',
  'org.status_refreshing',
  'precheck.applyFix',
  'precheck.autoFix',
  'precheck.blocked',
  'precheck.canProceed',
  'precheck.confirmation',
  'precheck.failed',
  'precheck.passed',
  'precheck.running',
  'precheck.score',
  'precheck.title',
  'precheck.warnings',
  'retry.abort',
  'retry.attemptOf',
  'retry.errorDetails',
  'retry.exhausted',
  'retry.manualRetryTriggered',
  'retry.noFailures',
  'retry.retryNow',
  'retry.retryingIn',
  'retry.title',
  'scheduler.addSchedule',
  'scheduler.dayLabel',
  'scheduler.dayOfMonth',
  'scheduler.dayOfWeek',
  'scheduler.duration',
  'scheduler.emptyDescription',
  'scheduler.frequencies.daily',
  'scheduler.frequencies.hourly',
  'scheduler.frequencies.monthly',
  'scheduler.frequencies.weekly',
  'scheduler.frequency',
  'scheduler.history',
  'scheduler.nextRun',
  'scheduler.opTypes.backup',
  'scheduler.opTypes.cleanup',
  'scheduler.opTypes.sync',
  'scheduler.operationType',
  'scheduler.records',
  'scheduler.startedAt',
  'scheduler.time',
  'scheduler.title',
  'seed.csv.mapper.noMatch',
  'seed.csv.mapper.selectField',
  'seed.estimatedApiCalls',
  'seed.estimatedDuration',
  'seed.excludedFields',
  'seed.grappeRecommended',
  'seed.insertOrder',
  'seed.modeSelect.comingSoon',
  'seed.noTemplates',
  'seed.persona.backToPersonas',
  'seed.persona.card.locale',
  'seed.persona.customize.fieldPattern',
  'seed.persona.customize.generator',
  'seed.piiScanning',
  'seed.removeObject',
  'seed.results',
  'seed.resultsDesc',
  'seed.reviewPlan',
  'seed.reviewPlanDesc',
  'seed.ruleType',
  'seed.selectOrgDesc',
  'seed.selectTemplate',
  'seed.setVolumes',
  'seed.setVolumesDesc',
  'seed.strategies.ai',
  'seed.strategies.clone',
  'seed.strategies.csv_import',
  'seed.strategies.faker',
  'seed.strategies.template',
  'seed.strategy',
  'seed.suggestDependencies',
  'seed.template',
  'seed.templates.minimalDemo.description',
  'seed.templates.minimalDemo.name',
  'seed.templates.salesCloudStarter.description',
  'seed.templates.salesCloudStarter.name',
  'seed.templates.serviceCloudStarter.description',
  'seed.templates.serviceCloudStarter.name',
  'settings.advancedDesc',
  'settings.apiTimeout',
  'settings.auditLogging',
  'settings.autoRefreshInterval',
  'settings.connections',
  'settings.connectionsDesc',
  'settings.defaultBatchSize',
  'settings.enableGrappe',
  'settings.enableGrappeDesc',
  'settings.enableNotifications',
  'settings.exportSettings',
  'settings.generalDesc',
  'settings.grappeThreshold',
  'settings.importError',
  'settings.importExport',
  'settings.importPlaceholder',
  'settings.importSettings',
  'settings.importSuccess',
  'settings.languages.de',
  'settings.languages.en',
  'settings.languages.es',
  'settings.languages.fr',
  'settings.languages.ja',
  'settings.languages.pt-BR',
  'settings.logLevel',
  'settings.logLevels.debug',
  'settings.logLevels.error',
  'settings.logLevels.info',
  'settings.logLevels.warn',
  'settings.maxConcurrentOps',
  'settings.notifications',
  'settings.notificationsDesc',
  'settings.requireProdConfirmation',
  'settings.resetConfirm',
  'settings.retryAttempts',
  'settings.saved',
  'settings.security',
  'settings.securityDesc',
  'settings.soundAlerts',
  'settings.telemetryDesc',
  'settings.theme',
  'settings.themes.auto',
  'settings.themes.dark',
  'settings.themes.light',
  'shortcuts.actions',
  'shortcuts.cancel',
  'shortcuts.closeOverlay',
  'shortcuts.commandPalette',
  'shortcuts.ctrlModule1',
  'shortcuts.ctrlModule2',
  'shortcuts.ctrlModule3',
  'shortcuts.ctrlModule4',
  'shortcuts.ctrlModule5',
  'shortcuts.ctrlModule6',
  'shortcuts.execute',
  'shortcuts.executeAction',
  'shortcuts.goAutomation',
  'shortcuts.goCompare',
  'shortcuts.goDataOps',
  'shortcuts.goHome',
  'shortcuts.goMonitor',
  'shortcuts.goSeed',
  'shortcuts.goSync',
  'shortcuts.modules',
  'shortcuts.navigation',
  'shortcuts.openSettings',
  'shortcuts.or',
  'shortcuts.pressToClose',
  'shortcuts.quickNav',
  'shortcuts.saveSettings',
  'shortcuts.showShortcuts',
  'shortcuts.title',
  'shortcuts.toClose',
  'shortcuts.toggleSidebar',
  'sidePanel.grappe',
  'sidePanel.grappeDesc',
  'sidePanel.manageOrgs',
  'sidePanel.noRecentOps',
  'sidePanel.relativeTime.hoursAgo',
  'sidePanel.relativeTime.justNow',
  'sidePanel.relativeTime.minutesAgo',
  'sidebar.quickActions',
  'sidebar.recentOps',
  'status.connectedOrgs',
  'sync.buildQuery',
  'sync.configureObjects',
  'sync.configureObjectsDesc',
  'sync.conflictResolution.pickSource',
  'sync.conflictResolution.pickTarget',
  'sync.conflictResolution.unresolvedCount',
  'sync.dryRun',
  'sync.enableRollback',
  'sync.fieldMappingDesc',
  'sync.impactAnalysis',
  'sync.previewApiCalls',
  'sync.previewConflicts',
  'sync.previewDeleted',
  'sync.previewDuration',
  'sync.previewModified',
  'sync.previewNew',
  'sync.realtime.agoSeconds',
  'sync.realtime.applied',
  'sync.realtime.autoSyncDesc',
  'sync.realtime.avgLag',
  'sync.realtime.comingSoon',
  'sync.realtime.conflictStrategy',
  'sync.realtime.conflicts',
  'sync.realtime.errorRate',
  'sync.realtime.eventFeed',
  'sync.realtime.eventsPerMin',
  'sync.realtime.pendingConflicts',
  'sync.realtime.replicationProgress',
  'sync.realtime.tab',
  'sync.realtime.totalEvents',
  'sync.realtime.useSource',
  'sync.realtime.useTarget',
  'sync.realtime.waitingForEvents',
  'sync.realtime.watchedObjects',
  'sync.removeMapping',
  'sync.removeTransform',
  'sync.resultsDesc',
  'sync.soqlQuery',
  'sync.templates.accountHierarchy.description',
  'sync.templates.accountHierarchy.name',
  'sync.templates.casesAttachments.description',
  'sync.templates.casesAttachments.name',
  'sync.templates.oppsProducts.description',
  'sync.templates.oppsProducts.name',
  'sync.transformsDesc',
  'team.authorName',
  'team.authorPlaceholder',
  'team.conflictsDetected',
  'team.copied',
  'team.copyBundle',
  'team.generateBundle',
  'team.import',
  'team.importBundle',
  'team.importDescription',
  'team.importFailed',
  'team.importPlaceholder',
  'team.importSuccess',
  'team.keepLocal',
  'team.keepRemote',
  'team.merge',
  'team.mergeStrategy',
  'team.preview',
  'team.share',
  'team.shareDescription',
  'team.title',
];

/**
 * Where the number stood, and when. `count` is an upper bound the run enforces:
 * the list may fall below it without anyone doing anything, but growing past it
 * means editing this number and the date beside it, in a diff a reviewer reads.
 * Lower both when you delete entries, so the next person can tell at a glance
 * whether the figure is going down. It read 590 on 2026-08-13, the day the
 * section landed and was neutralised in the same commit.
 */
const BASELINE_CENSUS = { recorded: '2026-09-09', count: 587 } as const;

/**
 * Section 6 — catalogue entries no source file mentions.
 * Returns the keys that are unreferenced and not in the baseline.
 */
function findUnreferencedKeys(reference: Map<string, string>): {
  unreferenced: string[];
  fresh: string[];
} {
  const sources = webviewSources(WEBVIEW_SRC).map((f) => readFileSync(f, 'utf8'));

  /*
   * Keys built at runtime — `t(`forge.anonCategory.${cat}`)`, `t('nav.' + id)` —
   * never appear whole in the source. Collect their prefixes first; without
   * this step the sweep reports (and a later cleanup deletes) live keys.
   */
  const dynamicPrefixes = new Set<string>();
  const templatePrefix = /['"`]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*\.)\$\{/g;
  const concatPrefix = /['"]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*\.)['"]\s*\+/g;
  for (const source of sources) {
    for (const pattern of [templatePrefix, concatPrefix]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) dynamicPrefixes.add(match[1]);
    }
  }

  const unreferenced: string[] = [];
  for (const key of reference.keys()) {
    const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
    if ([...dynamicPrefixes].some((p) => base.startsWith(p))) continue;
    if (sources.some((s) => s.includes(base))) continue;
    unreferenced.push(key);
  }
  unreferenced.sort();

  const baseline = new Set(UNREFERENCED_BASELINE);
  return { unreferenced, fresh: unreferenced.filter((k) => !baseline.has(k)) };
}

/**
 * The ratchet on that baseline. Three ways it stops telling the truth, all of
 * them blocking:
 *
 *   - an entry referenced again — the DEADCODE-08 mechanism, where a key that
 *     merely lost its consumer for the length of a purge was written down as
 *     dead instead of being left to come back;
 *   - an entry en.json no longer defines, which suppresses nothing and only
 *     inflates the count;
 *   - a list longer than the census it was last counted at, i.e. an append.
 *
 * Nothing here rewrites the list — a source file that edits itself is worse
 * than the debt — so the run names the offenders and fails until they are gone.
 * The suppression itself is computed live, so a stale entry stops excusing
 * anything the moment it goes stale, whether or not anyone deletes the line.
 */
function auditBaseline(reference: Map<string, string>, unreferenced: string[]): boolean {
  const stillUnreferenced = new Set(unreferenced);
  const revived = UNREFERENCED_BASELINE.filter(
    (k) => reference.has(k) && !stillUnreferenced.has(k),
  ).sort();
  const dropped = UNREFERENCED_BASELINE.filter((k) => !reference.has(k)).sort();
  const removedSince = BASELINE_CENSUS.count - UNREFERENCED_BASELINE.length;

  console.log(
    `baseline census — ${BASELINE_CENSUS.count} entries recorded ${BASELINE_CENSUS.recorded}, ` +
      `${UNREFERENCED_BASELINE.length} listed today (${removedSince} removed since)`,
  );

  if (revived.length > 0) {
    console.log(
      `✗ baseline: ${revived.length} entry(ies) referenced again — delete them from UNREFERENCED_BASELINE:`,
    );
    for (const k of revived) console.log(`    - ${k}`);
  }
  if (dropped.length > 0) {
    console.log(
      `✗ baseline: ${dropped.length} entry(ies) absent from ${WEBVIEW_REFERENCE} — delete them from UNREFERENCED_BASELINE:`,
    );
    for (const k of dropped) console.log(`    - ${k}`);
  }
  if (removedSince < 0) {
    console.log(
      `✗ baseline: ${UNREFERENCED_BASELINE.length} entries against ${BASELINE_CENSUS.count} recorded ` +
        `${BASELINE_CENSUS.recorded} — the baseline may shrink, never grow.`,
    );
  }
  if (revived.length === 0 && dropped.length === 0 && removedSince >= 0) {
    console.log('✓ baseline: every entry is still an unreferenced key of the catalogue');
  }

  return revived.length > 0 || dropped.length > 0 || removedSince < 0;
}

const reportOnly = process.argv.includes('--report');

const webviewDrift = checkParity({
  dir: WEBVIEW_LOCALES_DIR,
  referenceFile: WEBVIEW_REFERENCE,
  header: 'i18n parity (webview)',
  noOneCategory: NO_ONE_CATEGORY,
});

console.log('');

const manifestDrift = checkParity({
  dir: EXTENSION_DIR,
  referenceFile: MANIFEST_REFERENCE,
  header: 'i18n parity (extension manifest)',
  localeFilePattern: /^package\.nls\..+\.json$/,
});

console.log('');

const englishCatalogue = loadLocale(WEBVIEW_LOCALES_DIR, WEBVIEW_REFERENCE);
const sourceDrift = checkSources(englishCatalogue);

console.log('');
const identicalCount = reportIdenticalValues(englishCatalogue);

console.log('');
reportFrenchAccents();

console.log('');
const { unreferenced, fresh } = findUnreferencedKeys(englishCatalogue);
console.log(
  `unreferenced keys — ${unreferenced.length} of ${englishCatalogue.size} (${UNREFERENCED_BASELINE.length} allowlisted as the baseline)`,
);
if (fresh.length === 0) {
  console.log('✓ no key added since the baseline is unreferenced');
} else {
  console.log(`✗ ${fresh.length} newly unreferenced key(s):`);
  for (const k of fresh) console.log(`    - ${k}`);
}

console.log('');
const baselineDrift = auditBaseline(englishCatalogue, unreferenced);

const hasDrift =
  webviewDrift ||
  manifestDrift ||
  sourceDrift ||
  fresh.length > 0 ||
  identicalCount > 0 ||
  baselineDrift;

if (hasDrift && !reportOnly) {
  console.error('\ni18n parity check FAILED — run with --report for details without failing.');
  process.exit(1);
}

console.log(
  hasDrift
    ? '\ni18n parity check reported drift (--report mode, not failing).'
    : '\nAll locales at 100% parity.',
);
