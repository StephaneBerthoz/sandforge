import type { TranslationRecord } from '../../types.js';

export const common: TranslationRecord = {
  save: 'Save',
  cancel: 'Cancel',
  confirm: 'Confirm',
  delete: 'Delete',
  edit: 'Edit',
  close: 'Close',
  back: 'Back',
  next: 'Next',
  loading: 'Loading...',
  error: 'Error',
  success: 'Success',
  warning: 'Warning',
  noData: 'No data available',
  search: 'Search',
  filter: 'Filter',
  refresh: 'Refresh',
  retry: 'Retry',
  copy: 'Copy',
  export: 'Export',
};

export const nav: TranslationRecord = {
  home: 'Home',
  orgs: 'Organizations',
  seed: 'Seed',
  sync: 'Sync',
  monitor: 'Monitor',
  compare: 'Compare Org',
  dataops: 'DataOps',
  automation: 'Automation',
  autopilot: 'Autopilot',
  forge: 'Forge',
  ai: 'AI Assistant',
  reports: 'Reports',
  settings: 'Settings',
  help: 'Help',
};

export const org: TranslationRecord = {
  title: 'Organizations',
  connect: 'Connect Org',
  disconnect: 'Disconnect',
  edit: 'Edit Org',
  noOrgs: 'No organizations connected',
  status_connected: 'Connected',
  status_expired: 'Session Expired',
  status_error: 'Connection Error',
  status_refreshing: 'Refreshing...',
  safetyTier: 'Safety Tier',
  bannerConnected: '{{count}} of {{total}} orgs connected',
  bannerEmpty: 'Import your orgs from Salesforce CLI or connect manually',
  alias: 'Alias',
  username: 'Username',
  instanceUrl: 'Instance URL',
  orgType: 'Org Type',
  production: 'Production',
  sandbox: 'Sandbox',
  scratch: 'Scratch',
  developer: 'Developer',
  tier_critical: 'Critical',
  tier_high: 'High',
  tier_medium: 'Medium',
  tier_low: 'Low',
};

export const precheck: TranslationRecord = {
  title: 'Pre-Check',
  running: 'Running pre-checks...',
  passed: 'Passed',
  failed: 'Failed',
  warnings: 'Warnings',
  score: 'Score',
  canProceed: 'Can Proceed',
  blocked: 'Blocked',
  autoFix: 'Auto-Fix Available',
  applyFix: 'Apply Fix',
  confirmation: 'Requires Confirmation',
};

export const notifications: TranslationRecord = {
  title: 'Notifications',
  markAllRead: 'Mark all as read',
  clearAll: 'Clear all',
  noNotifications: 'No notifications',
};

export const bridge: TranslationRecord = {
  connecting: 'Connecting to extension...',
  connected: 'Connected to extension',
  disconnected: 'Disconnected from extension',
  syncReceived: 'State synchronized',
  notYetConnected: 'Not yet connected to the Salesforce API',
  orgConnected: 'Organization connected',
  orgDisconnected: 'Organization disconnected',
  settingsSaved: 'Settings saved to extension',
};

export const auth: TranslationRecord = {
  method: 'Auth Method',
  loginUrl: 'Login URL',
  username: 'Username',
  password: 'Password',
  securityToken: 'Security Token',
  securityTokenHint: 'Optional — required if IP not whitelisted',
  importAll: 'Import All from SF CLI',
  openBrowser: 'Open Browser',
  notSupported: 'This authentication method is not yet supported.',
  sfdxHint: 'All connected orgs from Salesforce CLI will be imported automatically.',
};
