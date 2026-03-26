import React from 'react';
import { useTranslation } from 'react-i18next';
import { Flame, Search, Bell, Settings, Menu, X, ChevronRight } from 'lucide-react';
import { cn } from '../../theme';
import { useAppStore } from '../../stores/useAppStore';
import type { ModuleRoute } from '../../stores/useAppStore';
import { useCommandStore } from '../../stores/useCommandStore';
import { useNotificationStore, selectUnreadCount } from '../../stores/useNotificationStore';
import { OrgSwitcher } from '../../components/OrgSwitcher/OrgSwitcher';
import { Badge } from '../../components/ui/Badge';

/** Map route keys to i18n label keys. */
const ROUTE_LABELS: Record<ModuleRoute, string> = {
  home: 'nav.home',
  orgs: 'nav.orgs',
  forge: 'nav.forge',
  grappe: 'nav.grappe',
  monitor: 'nav.monitor',
  seed: 'nav.seed',
  sync: 'nav.sync',
  compare: 'nav.compare',
  dataops: 'nav.dataops',
  automation: 'nav.automation',
  reports: 'nav.reports',
  settings: 'nav.settings',
  welcome: 'nav.welcome',
  help: 'nav.help',
};

/** TopBar component props. */
export interface TopBarProps {
  /** Additional CSS classes. */
  className?: string;
  /** Callback to toggle the notification center panel. */
  onNotificationsToggle?: () => void;
}

/** Redesigned top bar with logo, search trigger, org switcher, and action buttons. */
export const TopBar: React.FC<TopBarProps> = ({ className, onNotificationsToggle }) => {
  const { t } = useTranslation();
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const currentRoute = useAppStore((s) => s.currentRoute);
  const navigate = useAppStore((s) => s.navigate);
  const unreadCount = useNotificationStore(selectUnreadCount);

  const openCommandPalette = (): void => {
    useCommandStore.getState().setOpen(true);
  };

  return (
    <header
      className={cn(
        'h-12 bg-surface-0 border-b border-subtle flex items-center px-3 gap-3',
        className,
      )}
      data-testid="topbar"
    >
      {/* Left: sidebar toggle + logo */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          className="p-1.5 rounded hover:bg-surface-2 text-text-secondary hover:text-text-primary transition-colors"
          onClick={toggleSidebar}
          aria-label={t('common.toggleSidebar', 'Toggle sidebar')}
          data-testid="topbar-sidebar-toggle"
        >
          {collapsed ? <Menu className="w-4 h-4" /> : <X className="w-4 h-4" />}
        </button>
        <div className="flex items-center gap-1.5" data-testid="app-logo">
          <Flame className="w-5 h-5 text-forge" />
          <span className="text-sm font-bold text-text-primary font-display">
            SandForge
          </span>
        </div>
      </div>

      {/* Breadcrumb */}
      {currentRoute !== 'home' && (
        <nav
          className="flex items-center gap-1 text-xs shrink-0"
          aria-label="Breadcrumb"
          data-testid="topbar-breadcrumb"
        >
          <button
            className="text-text-muted hover:text-text-secondary transition-colors"
            onClick={() => navigate('home')}
          >
            {t('nav.home', 'Home')}
          </button>
          <ChevronRight className="w-3 h-3 text-text-muted" />
          <span className="text-text-primary font-medium">
            {t(ROUTE_LABELS[currentRoute], currentRoute)}
          </span>
        </nav>
      )}

      {/* Center: search trigger */}
      <button
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 mx-auto',
          'bg-surface-2 rounded-lg text-text-muted text-xs',
          'hover:bg-surface-3 hover:text-text-secondary cursor-pointer transition-colors',
          'border border-subtle',
        )}
        onClick={openCommandPalette}
        data-testid="topbar-search-trigger"
      >
        <Search className="w-3.5 h-3.5" />
        <span>{t('common.search', 'Search...')} Ctrl+K</span>
      </button>

      {/* Right: org switcher + notifications + settings */}
      <div className="flex items-center gap-2 shrink-0 ml-auto">
        <OrgSwitcher />
        <button
          className="p-1.5 rounded hover:bg-surface-2 text-text-secondary hover:text-text-primary transition-colors relative"
          data-testid="topbar-notifications"
          aria-label={t('notifications.title', 'Notifications')}
          onClick={onNotificationsToggle}
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <Badge
              variant="error"
              className="absolute -top-1 -right-1 min-w-[16px] h-4 text-[9px]"
            >
              {unreadCount}
            </Badge>
          )}
        </button>
        <button
          className="p-1.5 rounded hover:bg-surface-2 text-text-secondary hover:text-text-primary transition-colors"
          data-testid="topbar-settings"
          aria-label={t('nav.settings', 'Settings')}
          onClick={() => navigate('settings')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
