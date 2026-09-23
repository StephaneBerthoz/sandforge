import * as path from 'node:path';
import { z } from 'zod';
import type { ForgeTemplate } from '@sandforge/shared';
import type { ConfigStore } from '../storage/ConfigStore.js';

/**
 * Where the Forge templates a profile brought wait for the workspace they were
 * imported in.
 *
 * With a folder open, Forge keeps its templates in the workspace's
 * `.sandforge/forge-templates.json`; the ConfigStore's `forge:templates` holds
 * those of the windows with no folder open. An import leaves its templates
 * here, and the Forge side of a window merges them into its file the next
 * time it lists them (see `ForgeHandler`).
 *
 * The templates used to wait here as one set, and the first window to list its
 * templates merged it, whichever project that window was on: templates
 * imported for one project were written into another's file. Each set now
 * names the folder it was imported in, and only a window on that folder merges
 * it; a window on any other leaves it where it is.
 *
 * A set whose folder is never opened again is merged nowhere, and does not
 * grow without bound either. An import into a folder that already has a set
 * adds to that set, which holds each template once; and only the sets of the
 * {@link MAX_WAITING_FOLDERS} folders imported into last are kept, so an
 * import into another folder drops the set that has waited longest.
 */
export const IMPORTED_FORGE_TEMPLATES_KEY = 'forge:imported-templates';

/** How many folders' sets are kept at most. */
export const MAX_WAITING_FOLDERS = 10;

/** The ConfigStore category the sets are kept under: Forge's. */
const FORGE_CATEGORY = 'forge';

/** The templates one or more imports left for one workspace folder. */
export interface ImportedForgeTemplates {
  /** The folder the imports were made in, as VS Code gives its path. */
  folder: string;
  /** The templates to bring in, one per id. */
  templates: ForgeTemplate[];
  /**
   * The ids whose template replaces the one the workspace holds, which an
   * import with "overwrite" brought. Any other template is added only where
   * the workspace holds none of its id.
   */
  replacing: string[];
}

/** A set as the ConfigStore holds it, before its templates are read. */
const storedSetSchema = z.object({
  folder: z.string().min(1),
  templates: z.array(z.unknown()),
  replacing: z.array(z.string()),
});

/**
 * Whether an entry is a template a merge can address: an object with an id,
 * which is what `save`, `delete` and a merge match on.
 *
 * The template schema is not applied here, on purpose: an entry another
 * version of SandForge wrote, or one edited by hand, stays in the workspace
 * file, and `ForgeHandler` leaves it out of the list it sends the page.
 */
export function isTemplateEntry(entry: unknown): entry is ForgeTemplate {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const { id } = entry as { id?: unknown };
  return typeof id === 'string' && id.length > 0;
}

/**
 * `stored` with `incoming` merged in, by id.
 *
 * A template whose id `stored` does not hold is added after its own. One it
 * holds replaces it in place when its id is in `replacing`, and is dropped
 * otherwise: the workspace's own wins. Of two incoming templates of one id,
 * the first is taken.
 *
 * @param stored - The templates the workspace holds.
 * @param incoming - The templates an import brought.
 * @param replacing - The ids whose incoming template replaces the workspace's.
 */
export function mergeTemplates(
  stored: readonly ForgeTemplate[],
  incoming: readonly ForgeTemplate[],
  replacing: ReadonlySet<string>,
): ForgeTemplate[] {
  const byId = new Map<string, ForgeTemplate>();
  for (const template of incoming) {
    if (!byId.has(template.id)) byId.set(template.id, template);
  }
  const merged = stored.map((template) =>
    replacing.has(template.id) ? (byId.get(template.id) ?? template) : template,
  );
  const held = new Set(stored.map((template) => template.id));
  for (const [id, template] of byId) {
    if (!held.has(id)) merged.push(template);
  }
  return merged;
}

/**
 * Whether two paths name one folder, however each ends. Both come from VS
 * Code's workspace folders; the comparison only spares a trailing separator.
 */
function sameFolder(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** Every set the ConfigStore holds, oldest first, leaving out what does not read as one. */
function readSets(configStore: ConfigStore): ImportedForgeTemplates[] {
  const stored = configStore.get<unknown>(IMPORTED_FORGE_TEMPLATES_KEY);
  if (!Array.isArray(stored)) return [];
  const sets: ImportedForgeTemplates[] = [];
  for (const entry of stored) {
    const parsed = storedSetSchema.safeParse(entry);
    if (!parsed.success) continue;
    const { folder, templates, replacing } = parsed.data;
    sets.push({ folder, templates: templates.filter(isTemplateEntry), replacing });
  }
  return sets;
}

/**
 * The set imports left for `folder`, or undefined when none waits for it.
 *
 * @param configStore - The store every window shares.
 * @param folder - The workspace folder whose Forge lists its templates.
 */
export function importedTemplatesFor(
  configStore: ConfigStore,
  folder: string,
): ImportedForgeTemplates | undefined {
  return readSets(configStore).find((set) => sameFolder(set.folder, folder));
}

/**
 * Leave `templates` for `folder`'s Forge to merge, in the set an earlier
 * import left for it when there is one: each replaces the set's template of
 * its id. The set becomes the newest; beyond {@link MAX_WAITING_FOLDERS}, the
 * oldest is dropped.
 *
 * @param configStore - The store every window shares.
 * @param folder - The workspace folder the import was made in.
 * @param templates - The templates the import brings in, one per id.
 * @param replacing - The ids among them that replace the workspace's own.
 */
export function recordImportedTemplates(
  configStore: ConfigStore,
  folder: string,
  templates: readonly ForgeTemplate[],
  replacing: readonly string[],
): void {
  if (templates.length === 0) return;
  const sets = readSets(configStore);
  const at = sets.findIndex((set) => sameFolder(set.folder, folder));
  const earlier = at >= 0 ? sets.splice(at, 1)[0] : undefined;
  const byId = new Map((earlier?.templates ?? []).map((template) => [template.id, template]));
  for (const template of templates) byId.set(template.id, template);
  sets.push({
    folder: earlier?.folder ?? folder,
    templates: [...byId.values()],
    replacing: [...new Set([...(earlier?.replacing ?? []), ...replacing])],
  });
  configStore.set(IMPORTED_FORGE_TEMPLATES_KEY, sets.slice(-MAX_WAITING_FOLDERS), FORGE_CATEGORY);
}

/**
 * Drop the set that waited for `folder`, once its Forge merged it. The sets of
 * other folders stay.
 *
 * @param configStore - The store every window shares.
 * @param folder - The workspace folder whose file received the set.
 */
export function dropImportedTemplates(configStore: ConfigStore, folder: string): void {
  const rest = readSets(configStore).filter((set) => !sameFolder(set.folder, folder));
  if (rest.length > 0) {
    configStore.set(IMPORTED_FORGE_TEMPLATES_KEY, rest, FORGE_CATEGORY);
  } else {
    configStore.delete(IMPORTED_FORGE_TEMPLATES_KEY);
  }
}
