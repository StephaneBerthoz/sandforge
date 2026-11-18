import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BookOpen,
  Bot,
  ChartColumn,
  ExternalLink,
  FileUp,
  Flame,
  GitCompare,
  History,
  Keyboard,
  ListChecks,
  MessageCircleQuestion,
  Plug,
  RefreshCw,
  Rocket,
  ScrollText,
  Shield,
  ShieldCheck,
  Snowflake,
  Sprout,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useAppStore, type ModuleRoute } from '../../stores/useAppStore';
import { useWebviewPersistedState } from '../../hooks/useWebviewPersistedState';
import { CHORD_MAP } from '../../hooks/useGlobalShortcuts';
import { HowToSteps } from '../../components/ui/ModuleHowTo';
import { hasHowTo, howToKeys } from '../../components/ui/howToKeys';
import { NAV_GROUPS, TOOL_ITEMS } from '../../navigation/navGroups';

/** The repository, where the docs, the full FAQ and the issues are read. */
export const REPOSITORY_URL = 'https://github.com/StephaneBerthoz/sandforge';

/** The docs folder of the repository, as GitHub renders it. */
export const DOCS_URL = `${REPOSITORY_URL}/blob/master/docs/`;

/**
 * The Changelog tab of the extension's Marketplace page, where What's New's
 * "View full changelog" goes too: Help's Release Notes section was one
 * sentence with nothing to open. Written here rather than imported from
 * WhatsNewPage, whose release entries would come into Help's chunk with it;
 * HelpPage.test.tsx holds the two to the same address.
 */
export const CHANGELOG_URL =
  'https://marketplace.visualstudio.com/items/StephaneBerthoz.sandforge/changelog';

/** Accordion section definition. */
export interface HelpSection {
  id: string;
  titleKey: string;
  contentKey: string;
  /**
   * The module's one sentence, said first: the side panel, Home and the
   * module's empty state say it in the same words. Forge was described three
   * ways, and Autopilot as if it generated data.
   */
  summaryKey?: string;
  /**
   * The section's icon: a module's as the side panel draws it. Help drew
   * emoji, a hammer for Forge where the side panel draws a flame, a plane for
   * Autopilot where it draws a rocket, and empty boxes where no colour-emoji
   * font exists.
   */
  icon: LucideIcon;
  /** The module's colour in the side panel, drawn while its section is closed. */
  accent?: string;
  /** The page of the docs that says the rest, under {@link DOCS_URL}. */
  guide?: string;
}

/**
 * Every section, by its id. A module's section has the module's id, the one
 * its launcher row, its route and its how-to have; its place on the page comes
 * from {@link HELP_GROUPS}.
 */
const SECTIONS: readonly HelpSection[] = [
  {
    id: 'getting-started',
    titleKey: 'help.gettingStarted',
    contentKey: 'help.gettingStartedContent',
    icon: BookOpen,
    guide: 'getting-started.md',
  },
  {
    id: 'recovery',
    titleKey: 'help.afterRefresh',
    summaryKey: 'moduleSummary.recovery',
    contentKey: 'help.recoveryContent',
    icon: ListChecks,
    accent: 'text-hue-teal',
    guide: 'modules/recovery.md',
  },
  {
    id: 'orgs',
    titleKey: 'nav.orgs',
    contentKey: 'help.orgsContent',
    icon: Plug,
    guide: 'getting-started.md#connect-your-org',
  },
  {
    id: 'safety',
    titleKey: 'help.safety',
    contentKey: 'help.safetyContent',
    icon: ShieldCheck,
    guide: 'faq.md#does-sandforge-modify-production-data',
  },
  {
    id: 'seed',
    titleKey: 'nav.seed',
    summaryKey: 'moduleSummary.seed',
    contentKey: 'help.seedContent',
    icon: Sprout,
    accent: 'text-hue-green',
    guide: 'modules/seed.md',
  },
  {
    id: 'forge',
    titleKey: 'nav.forge',
    summaryKey: 'moduleSummary.forge',
    contentKey: 'help.forgeContent',
    icon: Flame,
    accent: 'text-hue-orange',
    guide: 'forge-quickstart.md',
  },
  {
    id: 'checkpoint',
    titleKey: 'nav.checkpoint',
    summaryKey: 'moduleSummary.checkpoint',
    contentKey: 'help.checkpointContent',
    icon: History,
    accent: 'text-hue-indigo',
    guide: 'modules/checkpoint.md',
  },
  {
    id: 'monitor',
    titleKey: 'nav.monitor',
    contentKey: 'help.monitorContent',
    icon: Activity,
    accent: 'text-hue-blue',
    guide: 'modules/monitor.md',
  },
  {
    id: 'sync',
    titleKey: 'nav.sync',
    contentKey: 'help.syncContent',
    icon: RefreshCw,
    accent: 'text-hue-sky',
    guide: 'modules/sync.md',
  },
  {
    id: 'autopilot',
    titleKey: 'nav.autopilot',
    summaryKey: 'moduleSummary.autopilot',
    contentKey: 'help.autopilotContent',
    icon: Rocket,
    accent: 'text-hue-rose',
    guide: 'modules/autopilot.md',
  },
  {
    id: 'frozen',
    titleKey: 'nav.frozen',
    contentKey: 'help.frozenContent',
    icon: Snowflake,
    accent: 'text-hue-cyan',
    guide: 'modules/frozen-dataset.md',
  },
  {
    id: 'compare',
    titleKey: 'nav.compare',
    contentKey: 'help.compareContent',
    icon: GitCompare,
    accent: 'text-hue-purple',
    guide: 'modules/compare.md',
  },
  {
    id: 'dataops',
    titleKey: 'nav.dataops',
    contentKey: 'help.dataopsContent',
    icon: Shield,
    accent: 'text-hue-yellow',
    guide: 'modules/dataops.md',
  },
  {
    id: 'automation',
    titleKey: 'nav.automation',
    contentKey: 'help.automationContent',
    icon: Zap,
    accent: 'text-hue-amber',
    guide: 'modules/automation.md',
  },
  {
    id: 'migration',
    titleKey: 'nav.migration',
    contentKey: 'help.migrationContent',
    icon: FileUp,
    accent: 'text-hue-teal',
    guide: 'modules/migration.md',
  },
  {
    id: 'ai',
    titleKey: 'nav.ai',
    contentKey: 'help.aiContent',
    icon: Bot,
    accent: 'text-hue-fuchsia',
    guide: 'modules/ai-assistant.md',
  },
  {
    id: 'reports',
    titleKey: 'nav.reports',
    contentKey: 'help.reportsContent',
    icon: ChartColumn,
    guide: 'modules/reports.md',
  },
  {
    id: 'shortcuts',
    titleKey: 'help.shortcuts',
    contentKey: 'help.shortcutsContent',
    icon: Keyboard,
  },
  {
    id: 'faq',
    titleKey: 'help.faq',
    contentKey: 'help.faqContent',
    icon: MessageCircleQuestion,
    guide: 'faq.md',
  },
  {
    id: 'troubleshooting',
    titleKey: 'help.troubleshooting',
    contentKey: 'help.troubleshootingContent',
    icon: Wrench,
    guide: 'faq.md#troubleshooting',
  },
  {
    id: 'release-notes',
    titleKey: 'help.releaseNotes',
    contentKey: 'help.releaseNotesContent',
    icon: ScrollText,
  },
];

/** A group of sections, under its heading; the sections that lead the page have none. */
export interface HelpGroup {
  id: string;
  labelKey?: string;
  sections: readonly HelpSection[];
}

/**
 * What a reader needs before any module: the first steps, what to do after a
 * sandbox refresh, connecting an org, and what keeps a run from harming one.
 * Back into service is said here, second, rather than in its launcher group.
 */
const LEAD_IDS: readonly string[] = ['getting-started', 'recovery', 'orgs', 'safety'];

/** What is looked up rather than read through, last. */
const REFERENCE_IDS: readonly string[] = ['shortcuts', 'faq', 'troubleshooting', 'release-notes'];

const sectionsOf = (ids: readonly string[]): HelpSection[] =>
  ids.flatMap((id) => SECTIONS.filter((section) => section.id === id));

/**
 * The page's groups: the sections that lead, then the modules under the
 * launcher's five headings, in its order, then the reference. Twenty sections
 * stood in one list of an order of their own, and a reader looking for what
 * masks a refreshed sandbox's data read every title.
 */
export const HELP_GROUPS: readonly HelpGroup[] = [
  { id: 'lead', sections: sectionsOf(LEAD_IDS) },
  ...NAV_GROUPS.map((group) => ({
    id: group.id,
    labelKey: group.labelKey,
    sections: sectionsOf(group.items.map((item) => item.id).filter((id) => !LEAD_IDS.includes(id))),
  })),
  { id: 'reference', labelKey: 'help.group.reference', sections: sectionsOf(REFERENCE_IDS) },
];

/** Every section, in the order the page shows them. */
export const HELP_SECTIONS: readonly HelpSection[] = HELP_GROUPS.flatMap((group) => group.sections);

/**
 * The pages a section opens with "Open …": the launcher's rows, its tools
 * among them. A section of another id — Getting Started, Safety, the
 * reference — has no page of its own.
 */
const SECTION_PAGES: ReadonlySet<string> = new Set(
  [...NAV_GROUPS.flatMap((group) => group.items), ...TOOL_ITEMS].map((item) => item.id),
);

/** The routes in the launcher's order, Home first: the order the shortcuts are said in. */
const LAUNCHER_ORDER: readonly ModuleRoute[] = [
  'home',
  ...NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
  ...TOOL_ITEMS.map((item) => item.id),
];

/** Where a route stands in the launcher's order; one it does not list comes last. */
const launcherRank = (route: ModuleRoute): number => {
  const index = LAUNCHER_ORDER.indexOf(route);
  return index === -1 ? LAUNCHER_ORDER.length : index;
};

/**
 * Every G chord the panel handles, from the map it handles them by, in the
 * launcher's order: Help named three of seventeen, as examples.
 */
const CHORDS: readonly (readonly [string, ModuleRoute])[] = Object.entries(CHORD_MAP).sort(
  ([, a], [, b]) => launcherRank(a) - launcherRank(b),
);

/** A link of the resources under the sections. */
interface ResourceLink {
  id: string;
  titleKey: string;
  descKey: string;
  /** The address, or the key of a translated one. */
  url?: string;
  urlKey?: string;
}

/**
 * SandForge's own docs, site and issues, above Salesforce's: Help linked to
 * Salesforce's sites alone, and never to SandForge's guides, its full FAQ or
 * where to report a problem.
 */
const SANDFORGE_LINKS: readonly ResourceLink[] = [
  {
    id: 'faq',
    titleKey: 'help.linkFaq',
    descKey: 'help.linkFaqDesc',
    url: `${DOCS_URL}faq.md`,
  },
  {
    id: 'guides',
    titleKey: 'help.linkGuides',
    descKey: 'help.linkGuidesDesc',
    url: `${REPOSITORY_URL}/tree/master/docs/modules`,
  },
  {
    id: 'issue',
    titleKey: 'help.linkIssue',
    descKey: 'help.linkIssueDesc',
    url: `${REPOSITORY_URL}/issues`,
  },
  {
    id: 'site',
    titleKey: 'help.linkSite',
    descKey: 'help.linkSiteDesc',
    urlKey: 'help.siteUrl',
  },
];

const SF_DOC_LINKS: readonly ResourceLink[] = [
  { id: 'sfDocs', titleKey: 'help.sfDocs', descKey: 'help.sfDocsDesc', urlKey: 'help.sfDocsUrl' },
  {
    id: 'sfTrailhead',
    titleKey: 'help.sfTrailhead',
    descKey: 'help.sfTrailheadDesc',
    urlKey: 'help.sfTrailheadUrl',
  },
  {
    id: 'sfStackExchange',
    titleKey: 'help.sfStackExchange',
    descKey: 'help.sfStackExchangeDesc',
    urlKey: 'help.sfStackExchangeUrl',
  },
];

/** Characters of the scripts written without spaces between words. */
const UNSPACED_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** `text` with every character a regular expression reads as syntax escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A query word this short is found as a whole word: CLI, API, AI, PII, Id. */
const WHOLE_WORD_UP_TO = 3;

/**
 * What the search looks for: each word of the query, in any case, found at
 * the start of a word, or as a whole word when it is three characters or
 * fewer. The search matched inside words, so "cli" found every section
 * saying "click". A word in Japanese is found anywhere, as the language puts
 * no space between words.
 */
export function searchPatterns(query: string): RegExp[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => {
      const escaped = escapeRegExp(word);
      if (UNSPACED_SCRIPT.test(word)) return new RegExp(escaped, 'iu');
      const end = [...word].length <= WHOLE_WORD_UP_TO ? '(?![\\p{L}\\p{N}])' : '';
      return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${end}`, 'iu');
    });
}

/**
 * `text` with each match of `pattern` in a `<mark>`, so a section found shows
 * why: the sections stayed closed and nothing in them was marked.
 */
function markMatches(text: string, pattern: RegExp | null): React.ReactNode {
  if (!pattern) return text;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (match[0].length === 0) continue;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(<mark key={at}>{match[0]}</mark>);
    last = at + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** A link opened in the browser, with the mark that says it leaves the panel. */
const OutLink: React.FC<{ href: string; testId: string; children: React.ReactNode }> = ({
  href,
  testId,
  children,
}) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-1 underline"
    style={{ color: 'var(--sf-text-link)' }}
    data-testid={testId}
  >
    {children}
    <ExternalLink size={11} aria-hidden="true" className="shrink-0" />
  </a>
);

/** A titled group of resource links. */
const ResourceGroup: React.FC<{
  heading: string;
  links: readonly ResourceLink[];
  testIdOf: (link: ResourceLink) => string;
}> = ({ heading, links, testIdOf }) => {
  const { t } = useTranslation();
  return (
    <div className="mt-6">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--sf-text-primary)' }}>
        {heading}
      </h2>
      <div className="flex flex-col gap-2">
        {links.map((link) => (
          <a
            key={link.id}
            href={link.url ?? t(link.urlKey ?? '')}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 p-3 rounded-lg transition-colors"
            style={{
              background: 'var(--sf-bg-card)',
              border: '1px solid var(--sf-border)',
              color: 'var(--sf-text-link)',
              textDecoration: 'none',
            }}
            data-testid={testIdOf(link)}
          >
            <div>
              <h3 className="text-sm font-medium" style={{ color: 'var(--sf-text-link)' }}>
                {t(link.titleKey)}
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
                {t(link.descKey)}
              </p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
};

/** A section's G chords, each with the page it opens, as the section says them. */
function chordLines(t: (key: string, options?: Record<string, unknown>) => string): string[] {
  return CHORDS.map(
    ([key, route]) => `${t('help.chord', { key: key.toUpperCase() })} — ${t(`nav.${route}`)}`,
  );
}

/** One section of the accordion: its header, and while open what it says and opens. */
const HelpSectionView: React.FC<{
  section: HelpSection;
  open: boolean;
  onToggle: () => void;
  mark: (text: string) => React.ReactNode;
}> = ({ section, open, onToggle, mark }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const Glyph = section.icon;
  const page = SECTION_PAGES.has(section.id) ? (section.id as ModuleRoute) : null;
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        border: '1px solid var(--sf-border)',
      }}
      data-testid={`help-section-${section.id}`}
    >
      <button
        id={`help-header-${section.id}`}
        className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-medium transition-colors"
        style={{
          background: open ? 'var(--sf-bg-active)' : 'var(--sf-bg-card)',
          color: open ? 'var(--sf-text-active)' : 'var(--sf-text-primary)',
        }}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`help-content-${section.id}`}
      >
        <span className="flex items-center gap-2">
          {/* In the header's own colour while open, on the selection's background. */}
          <Glyph
            className={`w-4 h-4 shrink-0 ${open ? '' : (section.accent ?? '')}`}
            aria-hidden="true"
            data-testid={`help-icon-${section.id}`}
          />
          <span>{mark(t(section.titleKey))}</span>
        </span>
        <span
          className="transition-transform"
          aria-hidden="true"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          {'▼'}
        </span>
      </button>
      {open && (
        <div
          id={`help-content-${section.id}`}
          className="px-4 py-3 text-xs leading-relaxed"
          role="region"
          aria-labelledby={`help-header-${section.id}`}
          style={{
            background: 'var(--sf-bg-primary)',
            color: 'var(--sf-text-secondary, #868686)',
            whiteSpace: 'pre-line',
          }}
        >
          {section.summaryKey && (
            <p
              className="mb-2 text-sm font-medium"
              style={{ color: 'var(--sf-text-primary)', whiteSpace: 'normal' }}
              data-testid={`help-summary-${section.id}`}
            >
              {mark(t(section.summaryKey))}
            </p>
          )}
          {hasHowTo(section.id) && (
            <div className="mb-3" style={{ whiteSpace: 'normal' }}>
              <p className="mb-1 text-xs font-semibold" style={{ color: 'var(--sf-text-primary)' }}>
                {t('howTo.title')}
              </p>
              <HowToSteps module={section.id} mark={mark} />
            </div>
          )}
          <div data-testid={`help-text-${section.id}`}>{mark(t(section.contentKey))}</div>
          {section.id === 'shortcuts' && (
            <ul
              className="mt-1 flex flex-col gap-0.5"
              style={{ whiteSpace: 'normal' }}
              data-testid="help-chords"
            >
              {chordLines(t).map((line, index) => (
                <li key={CHORDS[index][0]} data-testid={`help-chord-${CHORDS[index][0]}`}>
                  {mark(line)}
                </li>
              ))}
            </ul>
          )}
          {section.id === 'release-notes' && (
            <div
              className="flex flex-wrap items-center gap-3 mt-3"
              style={{ whiteSpace: 'normal' }}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  useAppStore.getState().setShowWhatsNew(true, __APP_VERSION__, undefined, true)
                }
                data-testid="help-show-whats-new"
              >
                {t('help.showWhatsNew')}
              </Button>
              <OutLink href={CHANGELOG_URL} testId="help-open-changelog">
                {t('help.openChangelog')}
              </OutLink>
            </div>
          )}
          {(page || section.guide) && (
            <div
              className="flex flex-wrap items-center gap-3 mt-3"
              style={{ whiteSpace: 'normal' }}
            >
              {/*
                The page the section is about, a click away: a section offered
                only its full guide, outside the panel.
              */}
              {page && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate(page)}
                  data-testid={`help-open-${section.id}`}
                >
                  {t('help.openModule', { module: t(`nav.${page}`) })}
                </Button>
              )}
              {section.id === 'ai' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate('settings', { settingsTab: 'ai' })}
                  data-testid="help-open-ai-settings"
                >
                  {t('help.openAiSettings')}
                </Button>
              )}
              {section.guide && (
                <OutLink href={`${DOCS_URL}${section.guide}`} testId={`help-guide-${section.id}`}>
                  {t('help.fullGuide', { section: t(section.titleKey) })}
                </OutLink>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Help page with full-text search, accordion sections grouped as the launcher
 * groups the modules, SandForge's and Salesforce's resources, and
 * troubleshooting.
 */
export const HelpPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const navigationIntent = useAppStore((s) => s.navigationIntent);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  /*
   * Kept in the panel's webview state: the Help panel is released while hidden
   * and rebuilt from its shell when shown, and an article being read beside
   * the code closed, and the search emptied, each time the user looked at
   * another tab of the editor group.
   */
  const [openSection, setOpenSection] = useWebviewPersistedState<string | null>(
    'helpOpenSection',
    'getting-started',
  );
  const [searchQuery, setSearchQuery] = useWebviewPersistedState('helpSearch', '');
  /** The sections closed by hand during the search they were found by. */
  const [closedInSearch, setClosedInSearch] = useState<{ query: string; ids: readonly string[] }>({
    query: '',
    ids: [],
  });

  /**
   * The section another page opened Help on, read once as the page mounts; an
   * id Help has no section for is ignored, and the page opens as it was left.
   */
  const [askedSection] = useState(() => {
    const asked = navigationIntent?.route === 'help' ? navigationIntent.helpSection : undefined;
    return HELP_SECTIONS.some((section) => section.id === asked) ? asked : undefined;
  });
  /** The asked section's header, until it has taken the focus. */
  const focusPending = useRef(askedSection);
  useEffect(() => {
    if (!askedSection) return;
    clearNavigationIntent();
    // A search left in the box would hide the section asked for.
    setSearchQuery('');
    setOpenSection(askedSection);
  }, [askedSection, clearNavigationIntent, setOpenSection, setSearchQuery]);

  const searching = searchQuery.trim().length > 0;
  useEffect(() => {
    const id = focusPending.current;
    if (!id || searching || openSection !== id) return;
    focusPending.current = undefined;
    // The router leaves the focus on a control the page gave it on mount.
    const header = document.getElementById(`help-header-${id}`);
    header?.focus();
    header?.scrollIntoView?.({ block: 'start' });
  }, [openSection, searching]);

  const patterns = useMemo(() => searchPatterns(searchQuery), [searchQuery]);
  const highlight = useMemo(
    () =>
      patterns.length > 0
        ? new RegExp(patterns.map((pattern) => pattern.source).join('|'), 'giu')
        : null,
    [patterns],
  );
  const closedIds = closedInSearch.query === searchQuery ? closedInSearch.ids : [];

  const isOpen = (id: string): boolean =>
    searching ? !closedIds.includes(id) : openSection === id;

  const toggleSection = (id: string): void => {
    if (searching) {
      setClosedInSearch({
        query: searchQuery,
        ids: closedIds.includes(id)
          ? closedIds.filter((closed) => closed !== id)
          : [...closedIds, id],
      });
      return;
    }
    setOpenSection((prev) => (prev === id ? null : id));
  };

  /**
   * The sections whose title, summary, how-to and text together hold every
   * word of the query, each found at the start of a word; the shortcuts with
   * the chords they list.
   */
  const shownIds = useMemo(() => {
    if (patterns.length === 0) {
      return new Set(HELP_SECTIONS.map((section) => section.id));
    }
    return new Set(
      HELP_SECTIONS.filter((section) => {
        const text = [
          t(section.titleKey),
          section.summaryKey ? t(section.summaryKey) : '',
          ...(hasHowTo(section.id) ? howToKeys(section.id).map((key) => t(key)) : []),
          t(section.contentKey),
          ...(section.id === 'shortcuts' ? chordLines(t) : []),
        ].join('\n');
        return patterns.every((pattern) => pattern.test(text));
      }).map((section) => section.id),
    );
  }, [patterns, t]);

  const hasSearchResults = shownIds.size > 0;
  const mark = (text: string): React.ReactNode => markMatches(text, highlight);

  return (
    <div className="flex flex-col p-6 max-w-3xl mx-auto" data-testid="help-page">
      <h1
        tabIndex={-1}
        className="text-2xl font-bold mb-1"
        style={{ color: 'var(--sf-text-primary)' }}
      >
        {t('help.title')}
      </h1>
      <p className="text-sm mb-4" style={{ color: 'var(--sf-text-secondary, #868686)' }}>
        {t('help.gettingStartedDesc')}
      </p>

      {/* Search input */}
      <div className="mb-3">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('help.searchPlaceholder')}
          className="w-full px-3 py-2 text-sm rounded-sm"
          style={{
            background: 'var(--sf-bg-input)',
            border: '1px solid var(--sf-border-input)',
            color: 'var(--sf-text-input)',
          }}
          data-testid="help-search"
          aria-label={t('help.searchPlaceholder')}
        />
      </div>

      {/*
        Under the search, above the sections: they sat at the foot of the page,
        under twenty sections and seven links. The welcome wizard is an overlay
        owned by PanelApp, not a routed page — navigating to it lands on
        PanelRouter's unknown-module fallback — so the tour raises the overlay
        flag as `onboarding:show` does.
      */}
      <div className="flex flex-wrap gap-3 mb-4">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => useAppStore.getState().setShowWelcome(true)}
          data-testid="help-start-tour"
        >
          {t('help.startTour')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate('settings')}
          data-testid="help-open-settings"
        >
          {t('home.openSettings')}
        </Button>
      </div>

      {/* No search results, and where the rest is said */}
      {!hasSearchResults && searching && (
        <p
          className="text-sm mb-4 text-center"
          style={{ color: 'var(--sf-text-secondary)' }}
          data-testid="help-no-results"
        >
          {t('help.noSearchResults')}{' '}
          <OutLink href={`${DOCS_URL}faq.md`} testId="help-no-results-faq">
            {t('help.notFoundFaq')}
          </OutLink>
        </p>
      )}

      {/* The groups, a group with no section found left out with its heading */}
      {HELP_GROUPS.map((group) => {
        const sections = group.sections.filter((section) => shownIds.has(section.id));
        if (sections.length === 0) return null;
        return (
          <div
            key={group.id}
            className={group.labelKey ? 'mt-5' : undefined}
            data-testid={`help-group-${group.id}`}
          >
            {group.labelKey && (
              <h2
                className="text-xs font-semibold uppercase tracking-wide mb-2"
                style={{ color: 'var(--sf-text-secondary)' }}
              >
                {t(group.labelKey)}
              </h2>
            )}
            <div className="flex flex-col gap-1">
              {sections.map((section) => (
                <HelpSectionView
                  key={section.id}
                  section={section}
                  open={isOpen(section.id)}
                  onToggle={() => toggleSection(section.id)}
                  mark={mark}
                />
              ))}
            </div>
          </div>
        );
      })}

      <ResourceGroup
        heading={t('help.sandforgeLinks')}
        links={SANDFORGE_LINKS}
        testIdOf={(link) => `help-link-${link.id}`}
      />
      <ResourceGroup
        heading={t('help.sfResources')}
        links={SF_DOC_LINKS}
        testIdOf={(link) => `sf-link-${link.titleKey}`}
      />
    </div>
  );
};
