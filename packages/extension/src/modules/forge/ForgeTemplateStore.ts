import type { ForgeTemplate } from '@sandforge/shared';

/** Dependencies for ForgeTemplateStore, injected at construction time. */
export interface ForgeTemplateStoreDeps {
  /** Root workspace path. */
  workspacePath: string;
  /** Read a file as UTF-8 string. */
  readFile: (path: string) => Promise<string>;
  /** Write a UTF-8 string to a file. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Create directory recursively. */
  mkdir: (path: string) => Promise<void>;
}

/**
 * Persists Forge templates to a workspace JSON file.
 * File location: `{workspace}/.sandforge/forge-templates.json`
 */
export class ForgeTemplateStore {
  private readonly deps: ForgeTemplateStoreDeps;
  private readonly filePath: string;

  /** @param deps - Injected file system dependencies. */
  constructor(deps: ForgeTemplateStoreDeps) {
    this.deps = deps;
    this.filePath = `${deps.workspacePath}/.sandforge/forge-templates.json`;
  }

  /** List all saved templates. Returns empty array if file doesn't exist. */
  async list(): Promise<ForgeTemplate[]> {
    try {
      const content = await this.deps.readFile(this.filePath);
      return JSON.parse(content) as ForgeTemplate[];
    } catch {
      return [];
    }
  }

  /** Save a template. Updates existing by id, or appends new. */
  async save(template: ForgeTemplate): Promise<void> {
    const templates = await this.list();
    const index = templates.findIndex((t) => t.id === template.id);
    if (index >= 0) {
      templates[index] = template;
    } else {
      templates.push(template);
    }
    await this.write(templates);
  }

  /** Delete a template by id. */
  async delete(templateId: string): Promise<void> {
    const templates = await this.list();
    const filtered = templates.filter((t) => t.id !== templateId);
    await this.write(filtered);
  }

  private async write(templates: ForgeTemplate[]): Promise<void> {
    const dirPath = `${this.deps.workspacePath}/.sandforge`;
    await this.deps.mkdir(dirPath).catch(() => undefined);
    await this.deps.writeFile(this.filePath, JSON.stringify(templates, null, 2));
  }
}
