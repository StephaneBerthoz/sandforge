/**
 * The names of saved Sync configurations, as the Sync page and Migration both
 * save them.
 *
 * Migration refused a name another saved configuration had while the Sync
 * wizard named every configuration after its pair of orgs and saved each
 * changed one as a new entry under that same name: two pages, opposite rules.
 * Both now keep to this one, and the wizard proposes a free name with it
 * before the host has to refuse one.
 */

/** A saved configuration, by what its name is compared on. */
export interface SyncConfigNamed {
  readonly id: string;
  readonly name: string;
}

/** A name as two saved configurations are told apart by it: trimmed, any case. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Whether another saved configuration than `ownId` already has `name`.
 *
 * @param saved - The saved configurations.
 * @param name - The name asked for.
 * @param ownId - The id the name would be saved under: its own entry does not take it.
 */
export function syncConfigNameTaken(
  saved: readonly SyncConfigNamed[],
  name: string,
  ownId?: string,
): boolean {
  const key = nameKey(name);
  return saved.some((config) => config.id !== ownId && nameKey(config.name) === key);
}

/**
 * Whether saving `name` under `id` would give two saved configurations one
 * name: a new id taking a name another has, or a saved one renamed to it. A
 * configuration saved again under the name it already has is not refused,
 * even beside an older one of that name: configurations saved before the
 * rule held may share one, and a schedule runs each by its id.
 *
 * @param saved - The saved configurations.
 * @param id - The id the configuration is saved under.
 * @param name - The name it is saved under.
 */
export function syncConfigNameRefused(
  saved: readonly SyncConfigNamed[],
  id: string,
  name: string,
): boolean {
  const own = saved.find((config) => config.id === id);
  if (own !== undefined && nameKey(own.name) === nameKey(name)) return false;
  return syncConfigNameTaken(saved, name, id);
}

/**
 * The first of `base`, `base (2)`, `base (3)`… that no saved configuration
 * but `ownId` has.
 *
 * @param saved - The saved configurations.
 * @param base - The name proposed first.
 * @param ownId - The id the next save goes under, whose own name is free to it.
 */
export function freeSyncConfigName(
  saved: readonly SyncConfigNamed[],
  base: string,
  ownId?: string,
): string {
  const trimmed = base.trim();
  if (!syncConfigNameTaken(saved, trimmed, ownId)) return trimmed;
  for (let n = 2; ; n++) {
    const candidate = `${trimmed} (${String(n)})`;
    if (!syncConfigNameTaken(saved, candidate, ownId)) return candidate;
  }
}
