import type { SeedTemplate, UUID } from '@sandforge/shared';
import type { SeedTemplateStore } from './SeedTemplateStore.js';

/** Function signature for generating unique IDs */
export type GenerateIdFn = () => UUID;

/** Function signature for getting the current ISO timestamp */
export type NowFn = () => string;

/**
 * Manages CRUD operations on seed templates.
 *
 * Stores templates in an in-memory Map with auto-generated IDs
 * and automatic timestamp management. When an optional {@link SeedTemplateStore}
 * is provided, all mutations are written through to persistent storage while
 * the Map serves as a fast read cache.
 */
export class SeedTemplateManager {
  private readonly templates: Map<string, SeedTemplate> = new Map();
  private readonly generateId: GenerateIdFn;
  private readonly now: NowFn;
  private readonly store?: SeedTemplateStore;

  /**
   * @param generateId - Function to generate unique IDs.
   * @param now - Function returning the current ISO timestamp.
   * @param store - Optional persistent store. When provided, all CRUD ops are write-through.
   */
  constructor(generateId: GenerateIdFn, now: NowFn, store?: SeedTemplateStore) {
    this.generateId = generateId;
    this.now = now;
    this.store = store;
  }

  /** Create a new seed template with auto-generated ID and timestamps */
  create(
    input: Omit<SeedTemplate, 'id' | 'createdAt' | 'updatedAt'>
  ): SeedTemplate {
    const timestamp = this.now();
    const template: SeedTemplate = {
      ...input,
      id: this.generateId(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.templates.set(template.id, template);
    this.store?.save(template);
    return template;
  }

  /** Retrieve a template by ID */
  get(id: string): SeedTemplate | undefined {
    const cached = this.templates.get(id);
    if (cached) return cached;
    if (this.store) {
      const persisted = this.store.load(id);
      if (persisted) {
        this.templates.set(id, persisted);
      }
      return persisted;
    }
    return undefined;
  }

  /** List all templates sorted by updatedAt descending */
  list(): SeedTemplate[] {
    return Array.from(this.templates.values()).sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  /** Update a template with partial data, refreshing updatedAt */
  update(id: string, patch: Partial<SeedTemplate>): SeedTemplate {
    const existing = this.templates.get(id);
    if (!existing) {
      throw new Error(`Template not found: ${id}`);
    }

    const updated: SeedTemplate = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    };

    this.templates.set(id, updated);
    this.store?.save(updated);
    return updated;
  }

  /** Delete a template by ID. Returns true if the template existed. */
  delete(id: string): boolean {
    const existed = this.templates.delete(id);
    if (this.store) {
      return this.store.delete(id) || existed;
    }
    return existed;
  }

  /** Duplicate an existing template with a new name and fresh ID */
  duplicate(id: string, newName: string): SeedTemplate {
    const existing = this.templates.get(id);
    if (!existing) {
      throw new Error(`Template not found: ${id}`);
    }

    const timestamp = this.now();
    const duplicated: SeedTemplate = {
      ...existing,
      id: this.generateId(),
      name: newName,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.templates.set(duplicated.id, duplicated);
    this.store?.save(duplicated);
    return duplicated;
  }
}
