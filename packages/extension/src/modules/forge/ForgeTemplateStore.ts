import * as path from 'node:path';
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
 * Whether an entry of the file is kept as a template: an object with an id,
 * which is what `save` and `delete` match on.
 *
 * The template schema is not applied here, on purpose: an entry another
 * version of SandForge wrote, or one edited by hand, stays in the file, and
 * the handler leaves it out of the list it sends the page.
 */
function isStoredTemplate(entry: unknown): entry is ForgeTemplate {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const { id } = entry as { id?: unknown };
  return typeof id === 'string' && id.length > 0;
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
    // Use path.join for cross-platform safety + defense against quirky
    // workspace paths (trailing slashes, mixed separators on Windows).
    this.filePath = path.join(deps.workspacePath, '.sandforge', 'forge-templates.json');
  }

  /**
   * List all saved templates. Returns empty array if the file doesn't exist,
   * or doesn't read as a list.
   *
   * The file is committed and edited by hand, so it can hold anything. It
   * used to be returned as the list whatever it held: `save` and `delete`
   * threw on an object, and the template list the page asks for threw on a
   * string. A file that holds no list reads as one that does not parse: as
   * no template. In a list, an entry no template operation can address,
   * anything but an object with an id, is left out.
   */
  async list(): Promise<ForgeTemplate[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.deps.readFile(this.filePath));
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isStoredTemplate) : [];
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

  /**
   * Add to the file the templates of a set whose id it does not hold.
   *
   * By id, the file wins: a template it already holds is kept as it is, and
   * the set's copy of it is dropped. So is anything in the set no template
   * operation could address, as `list` leaves it out, and a second entry of
   * one id. The file is written once, and only when something is added.
   *
   * @param templates - The set to merge, as it was read: not trusted.
   * @returns The templates the file holds now.
   */
  async merge(templates: readonly unknown[]): Promise<ForgeTemplate[]> {
    const stored = await this.list();
    const ids = new Set(stored.map((t) => t.id));
    const added: ForgeTemplate[] = [];
    for (const entry of templates) {
      if (!isStoredTemplate(entry) || ids.has(entry.id)) continue;
      ids.add(entry.id);
      added.push(entry);
    }
    if (added.length === 0) return stored;
    const merged = [...stored, ...added];
    await this.write(merged);
    return merged;
  }

  /** Delete a template by id. */
  async delete(templateId: string): Promise<void> {
    const templates = await this.list();
    const filtered = templates.filter((t) => t.id !== templateId);
    await this.write(filtered);
  }

  private async write(templates: ForgeTemplate[]): Promise<void> {
    const dirPath = path.join(this.deps.workspacePath, '.sandforge');
    await this.deps.mkdir(dirPath).catch(() => undefined);
    await this.deps.writeFile(this.filePath, JSON.stringify(templates, null, 2));
  }
}
