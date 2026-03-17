/** Record type for translation values. Supports nested namespaces. */
export interface TranslationRecord {
  [key: string]: string | TranslationRecord;
}

/** Supported application locales. */
export type SupportedLocale = 'en' | 'fr' | 'de' | 'es' | 'ja' | 'pt-BR';

/** Translation namespace identifiers matching the application modules. */
export type TranslationNamespace =
  | 'common'
  | 'nav'
  | 'org'
  | 'home'
  | 'status'
  | 'help'
  | 'monitor'
  | 'seed'
  | 'sync'
  | 'compare'
  | 'precheck'
  | 'dataops'
  | 'automation'
  | 'autopilot'
  | 'forge'
  | 'ai'
  | 'notifications'
  | 'reports'
  | 'settings'
  | 'bridge'
  | 'auth'
  | 'onboarding';

/** All supported namespace values. */
export const ALL_NAMESPACES: TranslationNamespace[] = [
  'common',
  'nav',
  'org',
  'home',
  'status',
  'help',
  'monitor',
  'seed',
  'sync',
  'compare',
  'precheck',
  'dataops',
  'automation',
  'autopilot',
  'forge',
  'ai',
  'notifications',
  'reports',
  'settings',
  'bridge',
  'auth',
  'onboarding',
];
