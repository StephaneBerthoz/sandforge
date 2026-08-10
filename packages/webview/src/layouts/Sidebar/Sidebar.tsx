import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Home,
  Plug,
  Activity,
  GitCompare,
  Shield,
  Zap,
  Flame,
  Snowflake,
  Bot,
  BarChart3,
  Settings,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Loader2,
  XCircle,
  Sprout,
  RefreshCw,
  Grape,
  Rocket,
  FileUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../theme';
import { useAppStore } from '../../stores/useAppStore';
import type { ModuleRoute } from '../../stores/useAppStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';
import type { RecentOp } from '../../stores/useRecentOpsStore';
import { Badge } from '../../components/ui/Badge';

/** Icon map from route/type to Lucide component. */
const iconMap: Record<string, LucideIcon> = {
  home: Home,
  orgs: Plug,
  forge: Flame,
  frozen: Snowflake,
  grappe: Grape,
  monitor: Activity,
  seed: Sprout,
  sync: RefreshCw,
  compare: GitCompare,
  dataops: Shield,
  automation: Zap,
  migration: FileUp,
  ai: Bot,
  autopilot: Rocket,
  reports: BarChart3,
  settings: Settings,
  help: HelpCircle,
};

/** Sidebar navigation item definition. */
interface NavItem {
  route: ModuleRoute;
  labelKey: string;
  icon: string;
  badge?: number;
}

/** Quick action definition for the sidebar. */
interface QuickAction {
  id: string;
  labelKey: string;
  icon: string;
  route: ModuleRoute;
}

/** Props for the Sidebar component. */
export interface SidebarProps {
  /** Badge counts per route. */
  badges?: Partial<Record<ModuleRoute, number>>;
}

const mainNav: NavItem[] = [
  { route: 'home', labelKey: 'nav.home', icon: 'home' },
  { route: 'orgs', labelKey: 'nav.orgs', icon: 'orgs' },
];

const moduleNav: NavItem[] = [
  { route: 'monitor', labelKey: 'nav.monitor', icon: 'monitor' },
  { route: 'seed', labelKey: 'nav.seed', icon: 'seed' },
  { route: 'sync', labelKey: 'nav.sync', icon: 'sync' },
  { route: 'grappe', labelKey: 'nav.grappe', icon: 'grappe' },
  { route: 'autopilot', labelKey: 'nav.autopilot', icon: 'autopilot' },
  { route: 'frozen', labelKey: 'nav.frozen', icon: 'frozen' },
  { route: 'compare', labelKey: 'nav.compare', icon: 'compare' },
  { route: 'dataops', labelKey: 'nav.dataops', icon: 'dataops' },
  { route: 'automation', labelKey: 'nav.automation', icon: 'automation' },
  { route: 'migration', labelKey: 'nav.migration', icon: 'migration' },
  { route: 'ai', labelKey: 'nav.ai', icon: 'ai' },
];

const bottomNav: NavItem[] = [
  { route: 'reports', labelKey: 'nav.reports', icon: 'reports' },
  { route: 'settings', labelKey: 'nav.settings', icon: 'settings' },
  { route: 'help', labelKey: 'nav.help', icon: 'help' },
];

const quickActions: QuickAction[] = [
  { id: 'quick-forge', labelKey: 'home.quickForge', icon: 'forge', route: 'forge' },
  { id: 'refresh-monitor', labelKey: 'home.refreshMonitor', icon: 'monitor', route: 'monitor' },
  { id: 'run-pipeline', labelKey: 'home.runLastPipeline', icon: 'automation', route: 'automation' },
];

/** Return a relative time string for a timestamp. */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '<1m';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Status icon for a recent operation. */
const StatusIcon: React.FC<{ status: RecentOp['status'] }> = ({ status }) => {
  switch (status) {
    case 'success':
      return <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />;
    case 'running':
      return <Loader2 className="w-3 h-3 text-sync shrink-0 animate-spin" />;
    case 'failed':
      return <XCircle className="w-3 h-3 text-automation shrink-0" />;
  }
};

/** Sidebar navigation panel. */
export const Sidebar: React.FC<SidebarProps> = ({ badges = {} }) => {
  const { t } = useTranslation();
  const currentRoute = useAppStore((s) => s.currentRoute);
  const navigate = useAppStore((s) => s.navigate);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [quickActionsOpen, setQuickActionsOpen] = useState(true);
  const [recentOpsOpen, setRecentOpsOpen] = useState(true);
  const recentOps = useRecentOpsStore((s) => s.ops);

  /** Ctrl+B keyboard shortcut to toggle sidebar. */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    },
    [toggleSidebar],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const renderIcon = (iconKey: string): React.ReactNode => {
    const IconComponent = iconMap[iconKey];
    if (IconComponent) {
      return <IconComponent className="w-4 h-4 shrink-0" />;
    }
    return <span className="shrink-0 w-4 text-center">?</span>;
  };

  const renderItem = (item: NavItem) => {
    const isActive = currentRoute === item.route;
    const badgeCount = badges[item.route] ?? item.badge;
    return (
      <button
        key={item.route}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded transition-colors text-left',
          isActive
            ? 'bg-surface-3 text-text-primary border border-active'
            : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary border border-transparent',
        )}
        onClick={() => navigate(item.route)}
        aria-current={isActive ? 'page' : undefined}
        aria-label={t(item.labelKey)}
        title={t(item.labelKey)}
      >
        <span className="shrink-0 w-5 flex items-center justify-center">
          {renderIcon(item.icon)}
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 truncate">{t(item.labelKey)}</span>
            {badgeCount !== undefined && badgeCount > 0 && (
              <Badge variant="default">{badgeCount}</Badge>
            )}
          </>
        )}
      </button>
    );
  };

  const displayedOps = recentOps.slice(0, 5);

  return (
    <nav
      className={cn(
        'flex flex-col h-full py-2',
        'bg-surface-1 border-r border-subtle',
        collapsed ? 'w-14' : 'w-56',
        'transition-all duration-200',
      )}
      data-testid="sidebar"
    >
      <div className="flex-1 flex flex-col gap-0.5 px-1 overflow-y-auto">
        {mainNav.map(renderItem)}
        <hr className="my-2 border-subtle" />

        {/* Forge hero section */}
        <button
          className={cn(
            'flex items-center gap-2 rounded-lg mx-1 mb-1 px-3 py-2 w-[calc(100%-8px)] text-left',
            'bg-forge/10 border border-forge/20',
            'hover:bg-forge/20 transition-colors',
            collapsed && 'justify-center px-0',
            currentRoute === 'forge' && 'bg-forge/20 border-forge/30',
          )}
          onClick={() => navigate('forge')}
          data-testid="sidebar-forge-hero"
        >
          <Flame className="w-4 h-4 text-forge shrink-0" />
          {!collapsed && (
            <span className="text-xs font-semibold text-forge truncate">{t('nav.forge')}</span>
          )}
        </button>

        {moduleNav.map(renderItem)}
      </div>

      {/* Quick Actions section (collapsible) */}
      {!collapsed && (
        <div className="px-1 mt-2" data-testid="sidebar-quick-actions">
          <button
            className="flex items-center gap-1 w-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted hover:text-text-secondary"
            onClick={() => setQuickActionsOpen((prev) => !prev)}
            aria-expanded={quickActionsOpen}
            data-testid="sidebar-quick-actions-toggle"
          >
            <span className="shrink-0">
              {quickActionsOpen ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </span>
            <span>{t('sidebar.quickActions')}</span>
          </button>
          {quickActionsOpen && (
            <div className="flex flex-col gap-0.5 mt-0.5">
              {quickActions.map((action) => (
                <button
                  key={action.id}
                  className="flex items-center gap-2 w-full px-3 py-1 text-xs rounded text-left text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                  onClick={() => navigate(action.route)}
                  data-testid={`sidebar-${action.id}`}
                >
                  <span className="shrink-0 w-4 flex items-center justify-center">
                    {renderIcon(action.icon)}
                  </span>
                  <span className="truncate">{t(action.labelKey)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recent Operations section (collapsible) */}
      {!collapsed && (
        <div className="px-1 mt-2" data-testid="sidebar-recent-ops">
          <button
            className="flex items-center gap-1 w-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted hover:text-text-secondary"
            onClick={() => setRecentOpsOpen((prev) => !prev)}
            aria-expanded={recentOpsOpen}
            data-testid="sidebar-recent-ops-toggle"
          >
            <span className="shrink-0">
              {recentOpsOpen ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </span>
            <span>{t('sidebar.recentOps')}</span>
          </button>
          {recentOpsOpen && (
            <div className="flex flex-col gap-0.5 mt-0.5 px-3 py-1">
              {displayedOps.length > 0 ? (
                displayedOps.map((op) => (
                  <div
                    key={op.id}
                    className="flex items-center gap-2 text-xs text-text-secondary py-0.5"
                    data-testid="sidebar-recent-op-item"
                  >
                    <StatusIcon status={op.status} />
                    <span className="flex-1 truncate">{op.label}</span>
                    <span className="text-text-muted text-[10px] shrink-0">
                      {relativeTime(op.timestamp)}
                    </span>
                  </div>
                ))
              ) : (
                <span className="text-xs text-text-muted" data-testid="sidebar-no-recent-ops">
                  {t('home.noRecentOps')}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-0.5 px-1 mt-auto">
        <hr className="my-2 border-subtle" />
        {bottomNav.map(renderItem)}
      </div>
    </nav>
  );
};
