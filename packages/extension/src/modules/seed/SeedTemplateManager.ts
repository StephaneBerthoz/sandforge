import type { SeedTemplate, UUID } from '@sandforge/shared';

/** Function signature for generating unique IDs */
export type GenerateIdFn = () => UUID;

/** Function signature for getting the current ISO timestamp */
export type NowFn = () => string;

/**
 * Manages CRUD operations on seed templates.
 * Stores templates in an in-memory Map with auto-generated IDs
 * and automatic timestamp management.
 */
export class SeedTemplateManager {
  private readonly templates: Map<string, SeedTemplate> = new Map();
  private readonly generateId: GenerateIdFn;
  private readonly now: NowFn;

  constructor(generateId: GenerateIdFn, now: NowFn) {
    this.generateId = generateId;
    this.now = now;
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
    return template;
  }

  /** Retrieve a template by ID */
  get(id: string): SeedTemplate | undefined {
    return this.templates.get(id);
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
    return updated;
  }

  /** Delete a template by ID. Returns true if the template existed. */
  delete(id: string): boolean {
    return this.templates.delete(id);
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
    return duplicated;
  }
}
