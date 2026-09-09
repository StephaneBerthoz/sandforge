import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { getVscodeApi } from '../hooks/useVSCodeApi';
import { buildMessage } from '../bridge/messageHelpers';
import { postEnvelopedMessage } from '../bridge/sendBridgeMessage';

import en from './locales/en.json';

/** Supported application languages. */
export type SupportedLanguage = 'en' | 'fr' | 'de' | 'es' | 'ja' | 'pt-BR';

/** Every language the UI ships a locale for, in selector display order. */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'en',
  'fr',
  'de',
  'es',
  'ja',
  'pt-BR',
];

/** Key under which the selected language is stored in the VS Code webview state. */
const LANGUAGE_STATE_KEY = 'language';

/**
 * Bridge round-trip budget for one locale bundle request. Generous on purpose:
 * the extension may still be activating when the webview boots.
 */
const LOCALE_REQUEST_TIMEOUT_MS = 4_000;

/**
 * Max time the first render waits for the persisted language's bundle. Past
 * this grace period the UI renders in English; a late bundle still flips the
 * language when it arrives (the underlying request keeps its own timeout).
 */
const BOOT_GATE_TIMEOUT_MS = 500;

/**
 * Read the language persisted in the VS Code webview state (getState/setState,
 * the same mechanism useWebviewPersistedState relies on). Returns undefined
 * when no valid language was persisted or outside a webview context.
 */
function getPersistedLanguage(): SupportedLanguage | undefined {
  try {
    const state = getVscodeApi().getState() as Record<string, unknown> | null | undefined;
    const lng = state?.[LANGUAGE_STATE_KEY];
    if (typeof lng === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(lng)) {
      return lng as SupportedLanguage;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the selected language into the VS Code webview state so the choice
 * survives webview reloads. Existing state keys (sync drafts, etc.) are merged,
 * not overwritten. Best-effort: silently ignored outside a webview.
 */
function persistLanguage(lng: string): void {
  try {
    const api = getVscodeApi();
    const existing = (api.getState() as Record<string, unknown> | null | undefined) ?? {};
    api.setState({ ...existing, [LANGUAGE_STATE_KEY]: lng });
  } catch {
    // Non-webview context (tests, dev server) — nothing to persist to.
  }
}

/**
 * Initialize i18next with react-i18next integration.
 *
 * Only English is bundled statically — the other five locale JSONs (~443 KB
 * minified) are packaged with the extension and fetched over the bridge on
 * demand (the webview CSP forbids fetch and dynamic import, so a postMessage
 * round-trip is the only channel). The initial language is always English;
 * the persisted language is restored asynchronously through the boot gate
 * ({@link i18nReady}). Interpolation escaping is disabled because React
 * handles XSS prevention.
 */
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

/**
 * Set while the boot restore applies a language DETECTED from the editor
 * locale rather than chosen by the user. A detected language is a default,
 * not a choice: persisting it would make {@link importLanguageFromSettings}
 * believe the fresh webview state already holds a user pick and skip the
 * recovery from the extension settings blob.
 *
 * Held as the language being auto-applied rather than as a boolean: the
 * suppression window spans an await that can last as long as
 * `LOCALE_REQUEST_TIMEOUT_MS`, and a boolean swallows *every* change made in
 * it — including the one the first-run wizard is on screen to collect. Naming
 * the language means only the auto-applied one is treated as a default.
 */
let autoAppliedLanguage: string | undefined;

i18n.on('languageChanged', (lng: string) => {
  if (lng !== autoAppliedLanguage) {
    persistLanguage(lng);
  }
  // The shell HTML is stamped with the language the extension had at build
  // time; keeping `<html lang>` in step here covers both the boot restore and
  // a runtime switch, so assistive tech never announces French in an English
  // voice. Guarded for the non-DOM contexts i18n is imported from.
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lng;
  }
});

/** A pending locale request waiting for its correlated bridge response. */
interface PendingLocaleRequest {
  lng: SupportedLanguage;
  timer: ReturnType<typeof setTimeout>;
  resolve: (loaded: boolean) => void;
}

/** In-flight locale requests, keyed by the request message id. */
const pendingLocaleRequests = new Map<string, PendingLocaleRequest>();

/** In-flight locale loads, keyed by language — concurrent callers share one request. */
const inFlightLocaleLoads = new Map<SupportedLanguage, Promise<boolean>>();

/** Wire shape of an inbound `i18n:locale:response` message. */
interface LocaleResponseMessage {
  type?: string;
  correlationId?: string;
  payload?: { lng?: unknown; bundle?: unknown; error?: unknown };
}

/**
 * Window listener for `i18n:locale:response`. Dedicated to this module (not
 * the shared useMessageBus dispatcher) because the boot gate runs before any
 * React hook mounts.
 */
function handleLocaleResponse(event: MessageEvent): void {
  // SECURITY: same origin rule as useMessageBus — vscode-webview:// origins
  // only, empty origin tolerated for tests.
  if (event.origin && !event.origin.startsWith('vscode-webview://')) {
    return;
  }
  const msg = event.data as LocaleResponseMessage | undefined;
  if (!msg || msg.type !== 'i18n:locale:response' || typeof msg.correlationId !== 'string') {
    return;
  }
  const pending = pendingLocaleRequests.get(msg.correlationId);
  if (!pending) {
    return;
  }
  pendingLocaleRequests.delete(msg.correlationId);
  clearTimeout(pending.timer);

  // Fail closed: the bundle must be an object for the language we asked for.
  const bundle = msg.payload?.bundle;
  if (msg.payload?.lng === pending.lng && bundle !== null && typeof bundle === 'object') {
    i18n.addResourceBundle(pending.lng, 'translation', bundle, true, true);
    pending.resolve(true);
  } else {
    pending.resolve(false);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', handleLocaleResponse);
}

/**
 * Fetch the locale bundle for `lng` over the bridge and register it with
 * i18next. Resolves `true` once the bundle is usable; `false` on timeout,
 * error response, or malformed payload. English and already-loaded languages
 * resolve immediately without a request; concurrent loads of the same
 * language share a single bridge round-trip.
 */
export function loadLocaleBundle(
  lng: SupportedLanguage,
  timeoutMs: number = LOCALE_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  if (lng === 'en' || i18n.hasResourceBundle(lng, 'translation')) {
    return Promise.resolve(true);
  }
  const inFlight = inFlightLocaleLoads.get(lng);
  if (inFlight) {
    return inFlight;
  }
  const request = buildMessage('i18n:locale', { lng });
  const promise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingLocaleRequests.delete(request.id);
      resolve(false);
    }, timeoutMs);
    pendingLocaleRequests.set(request.id, { lng, timer, resolve });
    postEnvelopedMessage(request);
  });
  const tracked = promise.then((loaded) => {
    inFlightLocaleLoads.delete(lng);
    return loaded;
  });
  inFlightLocaleLoads.set(lng, tracked);
  return tracked;
}

/**
 * Change the UI language, fetching the locale bundle over the bridge first
 * when it is neither statically bundled (English) nor already loaded. On
 * bridge failure the current language is kept — switching without the bundle
 * would render fallback English under a non-English language label.
 *
 * @returns `true` when the language was applied, `false` otherwise.
 */
export async function changeLanguageLazy(
  lng: SupportedLanguage,
  timeoutMs?: number,
): Promise<boolean> {
  try {
    if (i18n.language === lng && i18n.hasResourceBundle(lng, 'translation')) {
      return true;
    }
    const loaded = await loadLocaleBundle(lng, timeoutMs);
    if (!loaded) {
      return false;
    }
    await i18n.changeLanguage(lng);
    return true;
  } catch {
    return false;
  }
}

/**
 * Match a BCP-47 tag against the six shipped locales: exact code first
 * (case-insensitive, so `pt-br` finds `pt-BR`), then the primary subtag —
 * `fr-CA` → `fr`, and `pt` / `pt-PT` → `pt-BR`, the only Portuguese bundle
 * the product ships. Returns undefined when nothing is shipped for the tag.
 */
function matchSupportedLanguage(tag: string): SupportedLanguage | undefined {
  const lower = tag.toLowerCase();
  const exact = SUPPORTED_LANGUAGES.find((code) => code.toLowerCase() === lower);
  if (exact !== undefined) {
    return exact;
  }
  const base = lower.split('-')[0];
  return SUPPORTED_LANGUAGES.find((code) => code.toLowerCase().split('-')[0] === base);
}

/**
 * First shipped locale the editor itself asks for, or undefined when none of
 * its preferred tags has a bundle.
 *
 * `navigator.languages` inside a VS Code webview is the Chromium/Electron
 * locale of the editor window, i.e. the OS display language. It is NOT
 * `vscode.env.language`: VS Code does not forward its "Configure Display
 * Language" override to webviews (microsoft/vscode#207071 and #207178, both
 * still open under #206547), and nothing the host injects into this document
 * carries it either — the only injected values are
 * `window.__SANDFORGE_MODULE__` and `<html lang>`, and the latter is stamped
 * with the *configured* SandForge language, which is exactly `en` when the
 * setting is left on `auto`. Covering the override needs the host to inject
 * `vscode.env.language`; until then this is the best signal available from
 * inside the webview, and it is right whenever the editor follows the OS.
 */
function detectEditorLanguage(): SupportedLanguage | undefined {
  try {
    if (typeof navigator === 'undefined') {
      return undefined;
    }
    const preferred =
      navigator.languages !== undefined && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];
    for (const tag of preferred) {
      if (typeof tag !== 'string' || tag === '') {
        continue;
      }
      const match = matchSupportedLanguage(tag);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Boot restore: adopt the persisted language once its bundle has loaded, or —
 * when nothing was ever persisted (first launch) — the editor locale, so the
 * `auto` language setting actually picks one of the six shipped languages
 * instead of silently rendering English forever.
 *
 * The detected language is applied WITHOUT being persisted (see
 * {@link suppressLanguagePersist}), so a later `settings:response` can still
 * recover the language the user really picked in an earlier panel.
 */
async function restoreBootLanguage(): Promise<void> {
  const persisted = getPersistedLanguage();
  if (persisted !== undefined) {
    if (persisted === 'en') {
      return;
    }
    await changeLanguageLazy(persisted);
    return;
  }
  const detected = detectEditorLanguage();
  if (detected === undefined || detected === 'en') {
    return;
  }
  autoAppliedLanguage = detected;
  try {
    await changeLanguageLazy(detected);
  } finally {
    autoAppliedLanguage = undefined;
  }
}

/**
 * Boot gate awaited by main.tsx before the first render: resolves once the
 * persisted language is active, or after a short grace period — whichever
 * comes first — so a restored non-English UI never flashes English. Never
 * rejects; when the gate times out the UI renders in English and a late
 * bundle still flips the language on arrival.
 */
export const i18nReady: Promise<void> = Promise.race([
  restoreBootLanguage(),
  new Promise<void>((resolve) => {
    setTimeout(resolve, BOOT_GATE_TIMEOUT_MS);
  }),
]).then(
  () => undefined,
  () => undefined,
);

/**
 * Extract a supported language candidate from the extension-side settings
 * blob. Shared by importLanguageFromSettings / syncLanguageFromSettings.
 */
function readLanguageCandidate(settings: unknown): SupportedLanguage | undefined {
  const blob = settings as Record<string, unknown> | null | undefined;
  const nested = blob?.['settings'] as Record<string, unknown> | null | undefined;
  const candidate = blob?.['language'] ?? nested?.['language'];
  if (
    typeof candidate === 'string' &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(candidate)
  ) {
    return candidate as SupportedLanguage;
  }
  return undefined;
}

/**
 * One-shot recovery import, to call when the extension-side settings blob
 * arrives (`settings:response`). The webview state is per-document and dies
 * with the panel, while the blob (globalState) survives — so when the state
 * has NO persisted language but the blob carries a supported one, adopt it:
 * `changeLanguageLazy` fetches the bundle over the bridge, applies it AND
 * re-persists it into the fresh webview state via the `languageChanged`
 * listener above, which makes every later call a no-op (the state then has a
 * language and wins).
 *
 * Blob layout is historical baggage: current builds nest the whole settings
 * object under the `settings` key (`{settings: {language}}`, see
 * useSettingsPageData.handleSave), older builds wrote `language` as a flat
 * category key. Both shapes are read.
 */
export function importLanguageFromSettings(settings: unknown): void {
  if (getPersistedLanguage() !== undefined) {
    return; // webview state is the source of truth — nothing to recover
  }
  const candidate = readLanguageCandidate(settings);
  if (candidate !== undefined && candidate !== i18n.language) {
    void changeLanguageLazy(candidate);
  }
}

/**
 * Force-apply variant of {@link importLanguageFromSettings} for surfaces with
 * no language UI of their own (the sidebar). There, the persisted webview
 * state is only ever a mirror of the extension blob — never an independent
 * user choice — so the blob always wins, including over a value mirrored by
 * an earlier sync. This is what keeps the sidebar in sync when the user
 * switches language in the Settings page of another panel (the extension
 * broadcasts `settings:response` to every registered webview).
 */
export function syncLanguageFromSettings(settings: unknown): void {
  const candidate = readLanguageCandidate(settings);
  if (candidate !== undefined && candidate !== i18n.language) {
    void changeLanguageLazy(candidate);
  }
}

export default i18n;
