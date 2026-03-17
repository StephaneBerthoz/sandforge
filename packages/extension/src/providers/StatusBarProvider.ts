import type * as vscode from 'vscode';

/** Configuration for creating or updating a status bar item. */
export interface StatusBarItemConfig {
  id: string;
  text: string;
  tooltip?: string;
  command?: string;
  priority?: number;
  alignment?: 'left' | 'right';
}

/** Factory function type for creating status bar items (for DI/testability). */
export type StatusBarItemFactory = (alignment: number, priority: number) => vscode.StatusBarItem;

/**
 * Manages SandForge status bar items in the VSCode window.
 * Uses a factory function for status bar item creation to allow
 * dependency injection in tests.
 */
export class StatusBarProvider {
  private items = new Map<string, vscode.StatusBarItem>();

  constructor(private createStatusBarItem: StatusBarItemFactory) {}

  /** Create a new status bar item or update an existing one, then show it. */
  setItem(config: StatusBarItemConfig): void {
    let item = this.items.get(config.id);
    if (!item) {
      const alignment = config.alignment === 'right' ? 2 : 1;
      item = this.createStatusBarItem(alignment, config.priority ?? 100);
      this.items.set(config.id, item);
    }
    item.text = config.text;
    if (config.tooltip !== undefined) {
      item.tooltip = config.tooltip;
    }
    if (config.command !== undefined) {
      item.command = config.command;
    }
    item.show();
  }

  /** Dispose and remove a status bar item by its id. */
  removeItem(id: string): void {
    const item = this.items.get(id);
    if (item) {
      item.dispose();
      this.items.delete(id);
    }
  }

  /** Update only the text of an existing status bar item. */
  updateText(id: string, text: string): void {
    const item = this.items.get(id);
    if (item) {
      item.text = text;
    }
  }

  /** Get the ids of all active status bar items. */
  getItemIds(): string[] {
    return [...this.items.keys()];
  }

  /** Dispose all managed status bar items. */
  dispose(): void {
    for (const item of this.items.values()) {
      item.dispose();
    }
    this.items.clear();
  }
}
