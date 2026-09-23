import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { syncLanguageFromSettings } from './i18n';
import {
  Flame,
  Activity,
  Bot,
  ExternalLink,
  CheckCircle,
  XCircle,
  Ban,
  Loader,
  Shield,
  Zap,
  Plug,
  Settings,
  HelpCircle,
  GitCompare,
  ChevronDown,
  Star,
  ArrowRight,
  Snowflake,
  Sprout,
  RefreshCw,
  Grape,
  Globe,
  Rocket,
  FileUp,
} from 'lucide-react';
import { cn } from './theme';
import { ORG_TYPE_STYLES, ORG_TYPE_STYLE_DEFAULT } from './theme/orgStyles';
import { orgTypeLabel } from './utils/orgFormatters';
import { formatRelativeTimeI18n } from './utils/formatters';
import { useVSCodeApi } from './hooks/useVSCodeApi';
import { useRecentOpsFeed } from './hooks/useRecentOpsFeed';
import { useRecentOpsStore } from './stores/useRecentOpsStore';
import type { RecentOp } from './stores/useRecentOpsStore';
import { useOrgStore } from './stores/useOrgStore';
import { useFavoritesStore } from './stores/useFavoritesStore';
import type { OrgListResponse } from '@sandforge/shared';

/**
 * The word each status is read by: the one Home's badges print, so a status
 * reads the same on both.
 */
const STATUS_NAME_KEYS: Record<RecentOp['status'], string> = {
  success: 'home.opStatus.success',
  failed: 'home.opStatus.failed',
  running: 'home.opStatus.running',
  cancelled: 'home.opStatus.cancelled',
};

/**
 * Status icon component for a recent operation.
 *
 * An image named by its status. The icons said it by shape and colour alone:
 * a screen reader read the operation's label and its time, and nothing of
 * whether it had succeeded, failed or been cancelled.
 */
const StatusIcon: React.FC<{ status: RecentOp['status'] }> = ({ status }) => {
  const { t } = useTranslation();
  const name = { role: 'img', 'aria-label': t(STATUS_NAME_KEYS[status]) };
  switch (status) {
    case 'success':
      return (
        <CheckCircle
          className="w-3.5 h-3.5 text-status-success"
          data-testid="op-status-success"
          {...name}
        />
      );
    case 'failed':
      return (
        <XCircle
          className="w-3.5 h-3.5 text-status-error"
          data-testid="op-status-failed"
          {...name}
        />
      );
    case 'running':
      return (
        <Loader
          className="w-3.5 h-3.5 text-status-info animate-spin"
          data-testid="op-status-running"
          {...name}
        />
      );
    // A run someone stopped: neither the success tick nor the failure cross.
    case 'cancelled':
      return (
        <Ban
          className="w-3.5 h-3.5 text-text-secondary"
          data-testid="op-status-cancelled"
          {...name}
        />
      );
  }
};

/** Navigation item definition for the sidebar. */
interface NavItem {
  id: string;
  labelKey: string;
  icon: React.ReactNode;
  accent?: string;
}

/** Module navigation items. */
const MODULE_ITEMS: NavItem[] = [
  {
    id: 'monitor',
    labelKey: 'nav.monitor',
    icon: <Activity className="w-4 h-4" />,
    accent: 'text-hue-blue',
  },
  {
    id: 'seed',
    labelKey: 'nav.seed',
    icon: <Sprout className="w-4 h-4" />,
    accent: 'text-hue-green',
  },
  {
    id: 'sync',
    labelKey: 'nav.sync',
    icon: <RefreshCw className="w-4 h-4" />,
    accent: 'text-hue-sky',
  },
  {
    id: 'grappe',
    labelKey: 'nav.grappe',
    icon: <Grape className="w-4 h-4" />,
    accent: 'text-hue-indigo',
  },
  {
    id: 'autopilot',
    labelKey: 'nav.autopilot',
    icon: <Rocket className="w-4 h-4" />,
    accent: 'text-hue-rose',
  },
  {
    id: 'frozen',
    labelKey: 'nav.frozen',
    icon: <Snowflake className="w-4 h-4" />,
    accent: 'text-hue-cyan',
  },
  {
    id: 'compare',
    labelKey: 'nav.compare',
    icon: <GitCompare className="w-4 h-4" />,
    accent: 'text-hue-purple',
  },
  {
    id: 'dataops',
    labelKey: 'nav.dataops',
    icon: <Shield className="w-4 h-4" />,
    accent: 'text-hue-yellow',
  },
  {
    id: 'automation',
    labelKey: 'nav.automation',
    icon: <Zap className="w-4 h-4" />,
    accent: 'text-hue-amber',
  },
  {
    id: 'migration',
    labelKey: 'nav.migration',
    icon: <FileUp className="w-4 h-4" />,
    accent: 'text-hue-teal',
  },
  {
    id: 'ai',
    labelKey: 'nav.ai',
    icon: <Bot className="w-4 h-4" />,
    accent: 'text-hue-fuchsia',
  },
];

/** Tool navigation items. */
const TOOL_ITEMS: NavItem[] = [
  { id: 'orgs', labelKey: 'nav.orgs', icon: <Plug className="w-4 h-4" /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <Settings className="w-4 h-4" /> },
  { id: 'help', labelKey: 'nav.help', icon: <HelpCircle className="w-4 h-4" /> },
];

/**
 * Premium sidebar navigation for the VSCode side panel.
 * Features:
 * - SandForge branding with flame icon
 * - Full module navigation with accent colors and favorites
 * - Org switcher with live connection indicator
 * - Quick metrics (connected orgs / recent ops count)
 * - Running/last operation status
 * - "Open Full UI" button
 */
export const SidePanel: React.FC = () => {
  const { t } = useTranslation();
  const vscodeApi = useVSCodeApi();
  // Feed the recent-ops store from operation lifecycle messages so the
  // Running/Last operation blocks below have real data.
  useRecentOpsFeed();
  const ops = useRecentOpsStore((s) => s.ops);
  const lastOp = ops[0] as RecentOp | undefined;
  const runningOp = ops.find((op) => op.status === 'running');

  // Org store
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const connectedOrgs = orgs.filter((o) => o.status === 'connected');
  const selectedOrg = orgs.find((o) => o.id === selectedOrgId);
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  /**
   * Whether the extension has answered with the org list yet.
   *
   * The view is recreated every time VS Code hides and shows the side panel,
   * so the list starts empty on each one. Rendering "No org connected" while
   * the answer is still in flight told users, several times a session, that
   * nothing was connected when everything was.
   */
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  /**
   * The module this panel last sent the user to. Navigation is a one-way
   * message, so this is what the sidebar knows; without it no row ever looked
   * selected and eleven identical rows gave no sense of place at all.
   */
  const [activeRoute, setActiveRoute] = useState<string | null>(null);

  /** Sorted orgs: connected first, then alphabetical by alias/username within each group. */
  const sortedOrgs = useMemo(() => {
    return [...orgs].sort((a, b) => {
      const aConn = a.status === 'connected' ? 0 : 1;
      const bConn = b.status === 'connected' ? 0 : 1;
      if (aConn !== bConn) return aConn - bConn;
      const aName = (a.alias || a.username).toLowerCase();
      const bName = (b.alias || b.username).toLowerCase();
      return aName.localeCompare(bName);
    });
  }, [orgs]);

  // Compact mode for short viewports
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const checkHeight = (): void => {
      setIsCompact(window.innerHeight < 650);
    };
    checkHeight();
    window.addEventListener('resize', checkHeight);
    return () => window.removeEventListener('resize', checkHeight);
  }, []);

  /**
   * Escape and a click elsewhere close the org list.
   *
   * It opened on a click of its own trigger and closed only on a second one.
   * Anywhere else in the product that is how a menu gets stuck: people click
   * away, the list stays over the content, and the panel looks broken.
   */
  useEffect(() => {
    if (!orgDropdownOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOrgDropdownOpen(false);
    };
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-org-switcher]')) return;
      setOrgDropdownOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [orgDropdownOpen]);

  // Collapsible Quick Metrics
  const [metricsExpanded, setMetricsExpanded] = useState(true);

  useEffect(() => {
    if (isCompact) setMetricsExpanded(false);
  }, [isCompact]);

  // Favorites store
  const favorites = useFavoritesStore((s) => s.favorites);
  const toggleFavorite = useFavoritesStore((s) => s.toggle);

  // Request orgs on mount and listen for updates from the extension
  useEffect(() => {
    vscodeApi.postMessage({ type: 'sidebar:requestOrgs' });
    // Ask for the settings blob so the sidebar adopts the configured language
    // (its own webview state is per-document and starts empty). Later
    // `settings:response` broadcasts — posted to every registered webview when
    // another panel saves settings — keep the sidebar language in sync live.
    vscodeApi.postMessage({ type: 'sidebar:requestSettings' });

    const handleMessage = (event: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview host.
      if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        return;
      }
      const msg = event.data as {
        type?: string;
        payload?: Partial<OrgListResponse['payload']> & {
          settings?: unknown;
          orgId?: string;
        };
      };
      if (msg.type === 'org:list:response' && msg.payload?.orgs) {
        setOrgsLoaded(true);
        useOrgStore.getState().setOrgs(msg.payload.orgs);
        // The payload also carries the extension-side selection — adopt it
        // when this document has none (the view is recreated on hide/show).
        const selected = msg.payload.selectedOrgId;
        if (selected != null && useOrgStore.getState().selectedOrgId === null) {
          useOrgStore.getState().selectOrg(selected);
        }
      }
      // Selection made elsewhere (another panel, extension command) — the
      // sidebar adopts it so every surface shows the same org.
      if (msg.type === 'org:selected' && msg.payload?.orgId) {
        useOrgStore.getState().selectOrg(msg.payload.orgId);
      }
      if (msg.type === 'settings:response') {
        syncLanguageFromSettings(msg.payload?.settings);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [vscodeApi]);

  /** Send navigation message to extension host via vscode API. */
  const navigate = (route: string): void => {
    setActiveRoute(route);
    vscodeApi.postMessage({ type: 'sidebar:navigate', payload: { route } });
  };

  /** Open the full editor panel. */
  const openFull = (): void => {
    vscodeApi.postMessage({ type: 'sidebar:openFull' });
  };

  // Metrics: connected orgs and recent ops
  const connectedCount = connectedOrgs.length;
  const recentOpsCount = ops.length;

  return (
    <div
      className={cn(
        'h-screen w-full flex flex-col overflow-auto',
        'bg-surface-0 text-text-primary',
      )}
      data-testid="sidepanel-root"
    >
      {/* Branding */}
      <div className="flex items-center gap-2.5 px-3 py-3 border-b border-subtle">
        <div className="relative">
          <Flame className="w-5 h-5 text-hue-orange" />
          <div className="absolute -inset-1 bg-hue-orange/10 rounded-full blur-sm -z-10" />
        </div>
        <span className="text-sm font-bold tracking-tight">SandForge</span>
      </div>

      {/* Org Switcher */}
      <div className="px-3 pt-3 relative" data-org-switcher>
        <button
          className={cn(
            'w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5',
            'bg-surface-1 border border-subtle',
            'hover:bg-surface-2 hover:border-active transition-all text-left',
            'focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
            'focus-visible:outline-[var(--sf-accent)]',
            'group',
          )}
          onClick={() => setOrgDropdownOpen(!orgDropdownOpen)}
          aria-expanded={orgDropdownOpen}
          aria-haspopup="listbox"
          data-testid="sidepanel-org"
        >
          <span
            className={cn(
              'h-2.5 w-2.5 rounded-full shrink-0',
              selectedOrg?.status === 'connected'
                ? 'bg-status-success ring-2 ring-status-success/20'
                : selectedOrg?.status === 'refreshing'
                  ? 'bg-status-warning ring-2 ring-status-warning/20'
                  : selectedOrg
                    ? 'bg-status-error ring-2 ring-status-error/20'
                    : // No ring when nothing is selected: there is no severity to
                      // halo, and `text-secondary` has no ring tint in the scale.
                      'bg-text-secondary',
            )}
          />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-semibold truncate block">
              {selectedOrg
                ? selectedOrg.alias || selectedOrg.username
                : !orgsLoaded
                  ? t('sidePanel.loadingOrgs', 'Loading orgs…')
                  : connectedCount > 0
                    ? t('sidePanel.selectOrg', 'Select an org')
                    : t('sidePanel.noOrg', 'No org connected')}
            </span>
          </div>
          {selectedOrg && (
            <span
              className={cn(
                'text-[10px] font-bold px-1.5 py-0.5 rounded-md border shrink-0 uppercase',
                ORG_TYPE_STYLES[selectedOrg.orgType] ?? ORG_TYPE_STYLE_DEFAULT,
              )}
            >
              {orgTypeLabel(selectedOrg, t)}
            </span>
          )}
          <ChevronDown
            className={cn(
              'w-3.5 h-3.5 text-text-secondary transition-transform duration-200',
              orgDropdownOpen && 'rotate-180',
            )}
          />
        </button>

        {/* Org dropdown */}
        {orgDropdownOpen && (
          <div
            className="absolute left-3 right-3 top-full mt-1 z-50 rounded-lg bg-surface-1 border border-subtle shadow-lg overflow-hidden"
            data-testid="sidepanel-org-dropdown"
          >
            {orgs.length > 0 ? (
              <div className="max-h-[240px] overflow-y-auto">
                {sortedOrgs.map((org) => {
                  const isOrgConnected = org.status === 'connected';
                  return (
                    <div
                      key={org.id}
                      className={cn(
                        'flex items-center',
                        org.id === selectedOrgId && 'bg-surface-2',
                      )}
                    >
                      <button
                        className={cn(
                          'flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left text-xs',
                          'hover:bg-surface-2 transition-colors',
                        )}
                        onClick={() => {
                          selectOrg(org.id);
                          setOrgDropdownOpen(false);
                          vscodeApi.postMessage({
                            type: 'sidebar:selectOrg',
                            payload: { orgId: org.id },
                          });
                        }}
                        data-testid={`sidepanel-org-option-${org.id}`}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full shrink-0',
                            isOrgConnected ? 'bg-status-success' : 'bg-text-secondary',
                          )}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{org.alias || org.username}</div>
                          <div className="text-[10px] text-text-secondary truncate">
                            {org.username}
                          </div>
                        </div>
                        <span
                          className={cn(
                            'text-[10px] font-bold px-1.5 py-0.5 rounded-md border shrink-0',
                            ORG_TYPE_STYLES[org.orgType] ?? ORG_TYPE_STYLE_DEFAULT,
                          )}
                        >
                          {orgTypeLabel(org, t)}
                        </span>
                      </button>
                      {/* Survivor of the removed native Organizations tree: open the org in a browser. */}
                      <button
                        type="button"
                        className={cn(
                          'p-1.5 mr-2 rounded-md shrink-0',
                          'text-text-secondary hover:text-text-primary hover:bg-surface-3',
                          'transition-colors',
                        )}
                        title={t('sidePanel.openInBrowser', 'Open in browser')}
                        aria-label={t('sidePanel.openInBrowser', 'Open in browser')}
                        onClick={() => {
                          vscodeApi.postMessage({
                            type: 'sidebar:openOrgInBrowser',
                            payload: { orgId: org.id },
                          });
                        }}
                        data-testid={`sidepanel-org-open-${org.id}`}
                      >
                        <Globe className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-3 text-xs text-text-secondary text-center">
                {orgsLoaded
                  ? t('sidePanel.noOrgHint', 'No org yet — connect one below')
                  : t('sidePanel.loadingOrgs', 'Loading orgs…')}
              </div>
            )}
            <button
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 text-left text-xs',
                'text-hue-orange hover:bg-surface-2 border-t border-subtle',
                'font-medium',
              )}
              onClick={() => {
                setOrgDropdownOpen(false);
                navigate('orgs');
              }}
              data-testid="sidepanel-org-new"
            >
              <Plug className="w-3.5 h-3.5" />
              {t('sidePanel.newOrg', 'New organization...')}
            </button>
          </div>
        )}
      </div>

      {/* Quick Metrics */}
      <div className="px-3 pt-2.5">
        <button
          className="w-full flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary px-1 mb-1"
          onClick={() => setMetricsExpanded(!metricsExpanded)}
          aria-label={metricsExpanded ? t('sidePanel.hideMetrics') : t('sidePanel.showMetrics')}
          data-testid="sidepanel-metrics-toggle"
        >
          <ChevronDown
            className={cn(
              'w-3 h-3 transition-transform duration-200',
              !metricsExpanded && '-rotate-90',
            )}
          />
          {t('sidePanel.connectedOrgs', 'Orgs')} / {t('sidePanel.recentOps', 'Ops')}
        </button>
        {metricsExpanded && (
          <div className="grid grid-cols-2 gap-2" data-testid="sidepanel-metrics">
            <div className="rounded-lg bg-surface-1 border border-subtle px-2.5 py-2 text-center">
              <div className="text-[10px] text-text-secondary uppercase tracking-wide">
                {t('sidePanel.connectedOrgs', 'Orgs')}
              </div>
              <div className="text-lg font-bold tabular-nums">{connectedCount}</div>
            </div>
            <div className="rounded-lg bg-surface-1 border border-subtle px-2.5 py-2 text-center">
              <div className="text-[10px] text-text-secondary uppercase tracking-wide">
                {t('sidePanel.recentOps', 'Ops')}
              </div>
              <div className="text-lg font-bold tabular-nums">{recentOpsCount}</div>
            </div>
          </div>
        )}
      </div>

      {/* Forge Hero */}
      {!isCompact && (
        <div className="px-3 pt-3">
          <button
            className={cn(
              'w-full flex items-center gap-3 rounded-lg px-3 py-3 group',
              // A flat tint: text on a gradient has no single background to be read against.
              'bg-forge/10 border border-forge/20',
              'hover:bg-forge/15 hover:border-forge/40',
              'transition-all duration-200',
            )}
            onClick={() => navigate('forge')}
            data-testid="sidepanel-forge"
          >
            <div className="relative shrink-0">
              <div className="w-8 h-8 rounded-lg bg-forge/15 flex items-center justify-center">
                <Flame className="w-5 h-5 text-hue-orange" />
              </div>
              <div className="absolute -inset-0.5 bg-hue-orange/10 rounded-lg blur-sm -z-10 group-hover:bg-hue-orange/20 transition-colors" />
            </div>
            <div className="text-left flex-1 min-w-0">
              <div className="text-sm font-bold text-hue-orange">{t('sidePanel.forge')}</div>
              {/* On the tint, only the editor foreground keeps its contrast. */}
              <div className="text-[10px] text-text-primary leading-tight">
                {t('sidePanel.forgeDesc', 'Seed, sync & transform data')}
              </div>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-text-secondary group-hover:text-hue-orange group-hover:translate-x-0.5 transition-all shrink-0" />
          </button>
        </div>
      )}
      {isCompact && (
        <div className="px-3 pt-2">
          <button
            className={cn(
              'w-full flex items-center gap-2 rounded-lg px-2.5 py-2',
              'bg-forge/10 border border-forge/20',
              'hover:bg-forge/20 transition-all text-left',
            )}
            onClick={() => navigate('forge')}
            data-testid="sidepanel-forge-compact"
          >
            <Flame className="w-4 h-4 text-hue-orange shrink-0" />
            <span className="text-xs font-bold text-hue-orange">{t('sidePanel.forge')}</span>
            <ArrowRight className="w-3 h-3 text-text-secondary ml-auto shrink-0" />
          </button>
        </div>
      )}

      {/* Favorite Modules (if any) */}
      {favorites.length > 0 && (
        <div className="px-3 pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary px-1 mb-1.5">
            {t('sidePanel.favorites', 'Favorites')}
          </div>
          <nav
            className="flex flex-col gap-0.5"
            aria-label={t('sidePanel.favorites', 'Favorites')}
            data-testid="sidepanel-favorites"
          >
            {MODULE_ITEMS.filter((item) => favorites.includes(item.id)).map((item) => (
              // The same geometry as the Modules row below. They were a
              // different height and a different corner radius, forty pixels
              // apart, for the same module.
              <div key={item.id} className="flex items-center group">
                <button
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left flex-1 min-w-0',
                    'transition-all duration-150',
                    'focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
                    'focus-visible:outline-[var(--sf-accent)]',
                    activeRoute === item.id
                      ? 'text-text-primary bg-surface-1 shadow-sm'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-1 hover:shadow-sm',
                  )}
                  onClick={() => navigate(item.id)}
                  aria-current={activeRoute === item.id ? 'page' : undefined}
                  data-testid={`sidepanel-fav-${item.id}`}
                >
                  <span className={cn('shrink-0', item.accent)}>{item.icon}</span>
                  <span className="text-xs font-medium truncate">{t(item.labelKey)}</span>
                </button>
                {/* Removing a favourite meant scrolling down to find the same
                    row again in Modules. */}
                <button
                  className={cn(
                    'p-1 rounded-md transition-all duration-150 text-hue-amber',
                    'hover:bg-surface-1',
                    'focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
                    'focus-visible:outline-[var(--sf-accent)]',
                  )}
                  onClick={() => toggleFavorite(item.id)}
                  data-testid={`sidepanel-fav-star-${item.id}`}
                  aria-label={t('sidePanel.favoriteModule', { module: t(item.labelKey) })}
                  aria-pressed={true}
                  title={t('sidePanel.unfavorite', 'Remove from favorites')}
                >
                  <Star className="w-3 h-3 fill-current" />
                </button>
              </div>
            ))}
          </nav>
        </div>
      )}

      {/* Module Navigation */}
      <div className="px-3 pt-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary px-1 mb-2">
          {t('sidePanel.modules', 'Modules')}
        </div>
        <nav
          className="flex flex-col gap-0.5"
          aria-label={t('sidePanel.modules', 'Modules')}
          data-testid="sidepanel-modules"
        >
          {MODULE_ITEMS.map((item) => (
            <div key={item.id} className="flex items-center group">
              <button
                className={cn(
                  // min-w-0 so a long label truncates instead of pushing the
                  // star out of the row: "Eingefrorener Datensatz" is 23
                  // characters in a column about 125 wide.
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left flex-1 min-w-0',
                  'transition-all duration-150',
                  'focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
                  'focus-visible:outline-[var(--sf-accent)]',
                  activeRoute === item.id
                    ? 'text-text-primary bg-surface-1 shadow-sm'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-1 hover:shadow-sm',
                )}
                onClick={() => navigate(item.id)}
                aria-current={activeRoute === item.id ? 'page' : undefined}
                data-testid={`sidepanel-nav-${item.id}`}
              >
                <span className={cn('shrink-0', item.accent)}>{item.icon}</span>
                <span className="text-xs font-medium truncate">{t(item.labelKey)}</span>
              </button>
              <button
                className={cn(
                  // No opacity dimming: at 40% the unstarred outline fell far
                  // below the 3:1 contrast a control's icon needs.
                  'p-1 rounded-md transition-all duration-150',
                  'hover:bg-surface-1',
                  favorites.includes(item.id)
                    ? 'text-hue-amber'
                    : 'text-text-secondary hover:text-text-primary',
                )}
                onClick={() => toggleFavorite(item.id)}
                data-testid={`sidepanel-star-${item.id}`}
                // Named by the title alone, every star of the list was "Add to
                // favorites": a screen reader could not tell which module one
                // stood for, nor whether it was already a favourite.
                aria-label={t('sidePanel.favoriteModule', { module: t(item.labelKey) })}
                aria-pressed={favorites.includes(item.id)}
                title={
                  favorites.includes(item.id)
                    ? t('sidePanel.unfavorite', 'Remove from favorites')
                    : t('sidePanel.favorite', 'Add to favorites')
                }
              >
                <Star className={cn('w-3 h-3', favorites.includes(item.id) && 'fill-current')} />
              </button>
            </div>
          ))}
        </nav>
      </div>

      {/* Tool Navigation */}
      <div className="px-3 pt-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary px-1 mb-2">
          {t('sidePanel.tools', 'Tools')}
        </div>
        <nav
          className="flex flex-col gap-0.5"
          aria-label={t('sidePanel.tools', 'Tools')}
          data-testid="sidepanel-tools"
        >
          {TOOL_ITEMS.map((item) => (
            <button
              key={item.id}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left w-full min-w-0',
                'transition-all duration-150',
                'focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
                'focus-visible:outline-[var(--sf-accent)]',
                activeRoute === item.id
                  ? 'text-text-primary bg-surface-1 shadow-sm'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-1 hover:shadow-sm',
              )}
              onClick={() => navigate(item.id)}
              aria-current={activeRoute === item.id ? 'page' : undefined}
              data-testid={`sidepanel-nav-${item.id}`}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="text-xs font-medium truncate">{t(item.labelKey)}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Running Operation */}
      {runningOp && (
        <div className="px-3 pt-3">
          <div
            className="rounded-lg bg-surface-1 px-3 py-2 flex items-center gap-2"
            data-testid="sidepanel-running-op"
          >
            <Loader className="w-3.5 h-3.5 text-status-info animate-spin shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-text-secondary">{t('sidePanel.running')}</div>
              <div className="text-xs font-medium truncate">{runningOp.label}</div>
            </div>
          </div>
        </div>
      )}

      {/* Last Operation */}
      {lastOp && !runningOp && (
        <div className="px-3 pt-3">
          <div className="rounded-lg bg-surface-1 px-3 py-2" data-testid="sidepanel-last-op">
            <div className="text-[10px] text-text-secondary mb-1">{t('sidePanel.lastOp')}</div>
            <div className="flex items-center gap-2">
              <StatusIcon status={lastOp.status} />
              <span className="text-xs truncate flex-1">{lastOp.label}</span>
              <span className="text-[10px] text-text-secondary shrink-0">
                {formatRelativeTimeI18n(lastOp.timestamp, t, 'sidePanel.relativeTime')}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Open Full UI */}
      <div className="px-3 py-3 border-t border-subtle">
        <button
          className={cn(
            'w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 group',
            'bg-surface-1 border border-subtle',
            'hover:bg-surface-2 hover:border-active transition-all duration-150',
            'text-xs font-medium text-text-secondary hover:text-text-primary',
          )}
          onClick={openFull}
          data-testid="sidepanel-open-full"
        >
          <ExternalLink className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
          {t('sidePanel.openFull')}
        </button>
      </div>
    </div>
  );
};
