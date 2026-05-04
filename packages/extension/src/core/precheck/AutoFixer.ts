import type { PreCheckCategory, PreCheckConfig, PreCheckItem } from '@sandforge/shared';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/** Result of an auto-fix operation */
export interface AutoFixResult {
  fixed: PreCheckItem[];
  failed: FixFailure[];
}

/** A single fix failure */
export interface FixFailure {
  item: PreCheckItem;
  error: string;
}

/** Handler function that applies a fix for a single item */
export type FixHandlerFn = (item: PreCheckItem, config: PreCheckConfig) => Promise<PreCheckItem>;

/** Map of fix handlers keyed by category */
export type FixHandlerMap = Partial<Record<PreCheckCategory, FixHandlerFn>>;

/**
 * Applies automatic fixes for PreCheckItems that are marked as autoFixable.
 * Uses a registry of fix handlers organized by category.
 */
export class AutoFixer {
  private readonly handlers: FixHandlerMap;

  constructor(handlers: FixHandlerMap) {
    this.handlers = handlers;
  }

  /** Apply automatic fixes to all autoFixable items */
  async fix(items: PreCheckItem[], config: PreCheckConfig): Promise<AutoFixResult> {
    const fixableItems = items.filter((item) => item.autoFixable && !item.passed);
    const fixed: PreCheckItem[] = [];
    const failed: FixFailure[] = [];

    for (const item of fixableItems) {
      const handler = this.handlers[item.category];

      if (!handler) {
        failed.push({
          item,
          error: `No fix handler registered for category: ${item.category}`,
        });
        continue;
      }

      try {
        const fixedItem = await handler(item, config);
        fixed.push(fixedItem);
      } catch (err: unknown) {
        const message = extractErrorMessage(err);
        failed.push({ item, error: message });
      }
    }

    return { fixed, failed };
  }

  /** Check if a handler exists for a given category */
  hasHandler(category: PreCheckCategory): boolean {
    return this.handlers[category] !== undefined;
  }

  /** Get the list of categories that have fix handlers */
  getRegisteredCategories(): PreCheckCategory[] {
    return Object.keys(this.handlers) as PreCheckCategory[];
  }
}
