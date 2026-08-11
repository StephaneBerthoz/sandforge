import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse } from './HandlerTypes.js';
import { validatePayload, i18nLocalePayloadSchema } from '../validatePayload.js';
import { readLocaleBundle } from '../../core/i18n/localeBundles.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Message types handled by I18nHandler. */
const I18N_TYPES = new Set(['i18n:locale']);

/**
 * Domain handler for lazy webview locale loading.
 *
 * Answers `i18n:locale` with the parsed locale JSON read from the packaged
 * `webview-dist/locales/` directory. The requested code is whitelisted by
 * {@link i18nLocalePayloadSchema} before it ever reaches the filesystem —
 * no arbitrary paths. Read/parse failures answer with `{ lng, error }` so the
 * webview falls back to English instead of hanging.
 */
export class I18nHandler implements DomainHandler {
  /**
   * @param deps - Injected handler dependencies.
   * @param localesDir - Directory holding the packaged locale JSONs
   *   (`<extension>/webview-dist/locales`). Undefined only in tests that
   *   construct handlers without the composition root — requests then answer
   *   with an honest error payload.
   */
  constructor(
    private readonly deps: HandlerDeps,
    private readonly localesDir?: string,
  ) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!I18N_TYPES.has(msg.type)) return false;
    await this.handleLocaleRequest(msg);
    return true;
  }

  private async handleLocaleRequest(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(i18nLocalePayloadSchema, msg, 'i18n:locale:response', this.deps);
    if (!parsed) return;
    const { lng } = parsed;

    if (!this.localesDir) {
      const response = buildResponse(this.deps, msg, 'i18n:locale:response', {
        lng,
        error: 'Locale files are not available in this extension host.',
      });
      this.deps.broker.postToWebview(response);
      return;
    }

    try {
      const bundle = await readLocaleBundle(this.localesDir, lng);
      const response = buildResponse(this.deps, msg, 'i18n:locale:response', { lng, bundle });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] i18n:locale:response (${lng})`);
    } catch (err: unknown) {
      this.deps.log(`[ERR] i18n:locale (${lng}): ${extractErrorMessage(err)}`);
      const response = buildResponse(this.deps, msg, 'i18n:locale:response', {
        lng,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(response);
    }
  }
}
