import React, { useEffect, useCallback, useMemo } from 'react';
import { Command } from 'cmdk';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Search } from 'lucide-react';
import { cn } from '../../theme';
import { fadeIn } from '../../motion/presets';
import { useCommandStore } from '../../stores/useCommandStore';
import { useAppStore, ALL_ROUTES } from '../../stores/useAppStore';
import type { ModuleRoute } from '../../stores/useAppStore';
import type { CommandItem } from '../../stores/useCommandStore';
import { Icon } from '../ui/Icon';

/** Maximum number of recent searches to store. */
const MAX_RECENT_SEARCHES = 5;

/** Storage key for recent searches. */
const RECENT_SEARCHES_KEY = 'sf-command-palette-recent';

/** Route-to-icon mapping for navigation items. */
const ROUTE_ICONS: Record<string, string> = {
  home: 'home',
  orgs: 'plug',
  forge: 'flame',
  grappe: 'server',
  monitor: 'pulse',
  compare: 'diff',
  dataops: 'shield',
  automation: 'zap',
  ai: 'hubot',
  reports: 'graph',
  settings: 'gear',
  help: 'question',
};

/** Route-to-i18n-key mapping for navigation items. */
const ROUTE_LABEL_KEYS: Record<string, string> = {
  home: 'nav.home',
  orgs: 'nav.orgs',
  forge: 'nav.forge',
  grappe: 'nav.grappe',
  monitor: 'nav.monitor',
  compare: 'nav.compare',
  dataops: 'nav.dataops',
  automation: 'nav.automation',
  ai: 'nav.ai',
  reports: 'nav.reports',
  settings: 'nav.settings',
  help: 'help.title',
};

/**
 * Load recent searches from sessionStorage.
 */
function loadRecentSearches(): string[] {
  try {
    const stored = sessionStorage.getItem(RECENT_SEARCHES_KEY);
    if (stored) {
      return JSON.parse(stored) as string[];
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

/**
 * Save recent searches to sessionStorage.
 */
function saveRecentSearches(searches: string[]): void {
  try {
    sessionStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
  } catch {
    // Ignore storage errors
  }
}

/** Scale animation variants for the dialog container. */
const dialogVariants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.1 } },
};

/**
 * Command palette overlay triggered by Ctrl+K / Cmd+K.
 * Built on cmdk for native fuzzy search, keyboard navigation, and item grouping.
 * Uses the useCommandStore for open/close state and dynamic item registration.
 */
export const CommandPalette: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const open = useCommandStore((s) => s.open);
  const setOpen = useCommandStore((s) => s.setOpen);
  const toggle = useCommandStore((s) => s.toggle);
  const storeItems = useCommandStore((s) => s.items);
  const registerItems = useCommandStore((s) => s.registerItems);
  const removeItems = useCommandStore((s) => s.removeItems);
  const [search, setSearch] = React.useState('');
  const [recentSearches, setRecentSearches] = React.useState<string[]>(loadRecentSearches);

  /** Build and register navigation + action items on mount. */
  useEffect(() => {
    const navItems: CommandItem[] = ALL_ROUTES.filter((r) => r !== 'welcome').map(
      (route: ModuleRoute) => ({
        id: `nav-${route}`,
        label: t(ROUTE_LABEL_KEYS[route] ?? `nav.${route}`),
        group: 'navigate' as const,
        icon: ROUTE_ICONS[route] ?? 'file',
        action: () => navigate(route),
        keywords: [route],
      }),
    );

    const actionItems: CommandItem[] = [
      {
        id: 'quick-forge',
        label: t('home.quickForge'),
        group: 'actions' as const,
        icon: 'flame',
        action: () => navigate('forge'),
        keywords: ['forge', 'seed', 'sync', 'quick'],
      },
      {
        id: 'refresh-monitor',
        label: t('home.refreshMonitor'),
        group: 'actions' as const,
        icon: 'refresh',
        action: () => navigate('monitor'),
        keywords: ['monitor', 'refresh'],
      },
      {
        id: 'run-pipeline',
        label: t('home.runLastPipeline'),
        group: 'actions' as const,
        icon: 'play',
        action: () => navigate('automation'),
        keywords: ['pipeline', 'run', 'automation'],
      },
    ];

    const ids = [...navItems, ...actionItems].map((i) => i.id);
    registerItems([...navItems, ...actionItems]);

    return () => {
      removeItems(ids);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  /** Group items by their group property. */
  const grouped = useMemo(() => {
    const groups = new Map<string, CommandItem[]>();
    for (const item of storeItems) {
      const existing = groups.get(item.group);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(item.group, [item]);
      }
    }
    return groups;
  }, [storeItems]);

  /** Map group keys to display headings. */
  const groupHeading = useCallback(
    (group: string): string => {
      switch (group) {
        case 'navigate':
          return t('commandPalette.navigation');
        case 'actions':
          return t('commandPalette.actions');
        case 'orgs':
          return t('nav.orgs');
        case 'recent':
          return t('commandPalette.recentSearches');
        default:
          return group;
      }
    },
    [t],
  );

  /** Handle item selection: save to recent, execute action, close palette. */
  const handleSelect = useCallback(
    (item: CommandItem) => {
      if (search.trim()) {
        const updated = [search, ...recentSearches.filter((s) => s !== search)].slice(
          0,
          MAX_RECENT_SEARCHES,
        );
        setRecentSearches(updated);
        saveRecentSearches(updated);
      }
      setOpen(false);
      setSearch('');
      item.action();
    },
    [search, recentSearches, setOpen],
  );

  /** Clear recent searches. */
  const clearRecentSearches = useCallback(() => {
    setRecentSearches([]);
    saveRecentSearches([]);
  }, []);

  /** Global Ctrl+K / Cmd+K shortcut. */
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle]);

  /** Reset search when palette opens. */
  useEffect(() => {
    if (open) {
      setSearch('');
    }
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Overlay backdrop */}
          <motion.div
            className={cn('fixed inset-0 z-[200] glass-overlay')}
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="hidden"
            onClick={() => setOpen(false)}
            data-testid="command-palette-overlay"
          />

          {/* Dialog container */}
          <motion.div
            className="fixed top-[15vh] left-1/2 -translate-x-1/2 z-[201] w-full max-w-lg"
            variants={dialogVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            data-testid="command-palette"
          >
            <Command
              className="bg-surface-1 rounded-xl border border-subtle shadow-2xl overflow-hidden"
              label={t('commandPalette.placeholder')}
              loop
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setOpen(false);
                  setSearch('');
                }
              }}
            >
              {/* Search input */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-subtle">
                <Search className="h-4 w-4 shrink-0 text-muted" />
                <Command.Input
                  value={search}
                  onValueChange={setSearch}
                  className="flex-1 bg-transparent text-sm text-text-primary placeholder-[var(--sf-text-secondary)] outline-none"
                  placeholder={t('commandPalette.placeholder')}
                  data-testid="command-palette-input"
                />
              </div>

              {/* Results list */}
              <Command.List
                className="max-h-[300px] overflow-y-auto"
                data-testid="command-palette-results"
              >
                <Command.Empty
                  className="px-4 py-6 text-center text-sm text-text-secondary"
                  data-testid="command-palette-no-results"
                >
                  {t('commandPalette.noResults')}
                </Command.Empty>

                {Array.from(grouped.entries()).map(([group, items]) => (
                  <Command.Group
                    key={group}
                    heading={groupHeading(group)}
                    className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-text-secondary"
                  >
                    {items.map((item) => (
                      <Command.Item
                        key={item.id}
                        value={item.label}
                        keywords={item.keywords}
                        onSelect={() => handleSelect(item)}
                        className="flex items-center gap-3 w-full px-4 py-2 text-sm cursor-pointer transition-colors text-text-primary data-[selected=true]:bg-[var(--sf-bg-active)] data-[selected=true]:text-[var(--sf-text-active)] hover:bg-[var(--sf-bg-hover)]"
                        data-testid={`command-palette-item-${item.id}`}
                      >
                        {item.icon && <Icon name={item.icon} />}
                        <span className="flex-1">{item.label}</span>
                        <span className="text-xs text-text-secondary">
                          {groupHeading(item.group)}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>

              {/* Recent searches footer */}
              {!search.trim() && recentSearches.length > 0 && (
                <div
                  className="border-t border-subtle px-4 py-2"
                  data-testid="command-palette-recent"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                      {t('commandPalette.recentSearches')}
                    </span>
                    <button
                      className="text-[10px] text-[var(--sf-text-link)] hover:underline"
                      onClick={clearRecentSearches}
                      data-testid="clear-recent-btn"
                    >
                      {t('commandPalette.clearRecent')}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {recentSearches.map((rs) => (
                      <button
                        key={rs}
                        className="px-2 py-0.5 text-xs rounded bg-[var(--sf-badge-bg)] text-[var(--sf-badge-fg)] hover:opacity-80"
                        onClick={() => setSearch(rs)}
                        data-testid="recent-search-item"
                      >
                        {rs}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Command>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
