import type { TFunction } from 'i18next';

/**
 * The name a module goes by in the panel's navigation — Forge, Frozen
 * Dataset, DataOps — for the id its runs are recorded under: "forge",
 * "frozen", "dataops". The trail and the reports printed the id, in lower
 * case, beside a navigation that names no page that way. An id the
 * navigation has no name for is shown as it is.
 */
export function moduleName(t: TFunction, module: string): string {
  return t(`nav.${module}`, { defaultValue: module });
}

/**
 * Whether a label already names the module, in the reader's language: the
 * action badge of an audit entry says "Forge Clone", "Exécution seed" or
 * "Frozen Dataset Load", and the module beside it then said it a second time.
 * Compared without case, since an action label may write it in lower case.
 */
export function namesModule(label: string, name: string): boolean {
  return label.toLocaleLowerCase().includes(name.toLocaleLowerCase());
}
