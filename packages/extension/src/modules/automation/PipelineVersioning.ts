/** A snapshot of a pipeline configuration at a specific version */
export interface PipelineVersion {
  versionId: string;
  pipelineId: string;
  version: number;
  config: Record<string, unknown>;
  tag?: string;
  annotation?: string;
  createdAt: string;
  createdBy?: string;
}

/** Describes the differences between two pipeline versions */
export interface PipelineDiff {
  added: string[];
  removed: string[];
  modified: Array<{ path: string; old: unknown; new: unknown }>;
}

/** Optional metadata attached when saving a new version */
export interface VersionMetadata {
  tag?: string;
  annotation?: string;
  createdBy?: string;
}

/**
 * Generates a RFC4122 v4-compliant UUID.
 * Used internally to assign unique identifiers to pipeline versions.
 */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Deep-clone a value using the platform structured-clone algorithm.
 * Preserves Date / Map / Set / undefined where JSON round-trip would lose them.
 * @param value - The value to clone
 * @returns A deep copy of the value
 */
function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Collect all leaf key paths from an object using dot notation.
 * @param obj - The object to extract keys from
 * @param prefix - Current key prefix for recursion
 * @returns Set of dot-separated key paths
 */
function collectKeys(obj: Record<string, unknown>, prefix: string = ''): Set<string> {
  const keys = new Set<string>();
  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of collectKeys(value as Record<string, unknown>, fullPath)) {
        keys.add(nested);
      }
    } else {
      keys.add(fullPath);
    }
  }
  return keys;
}

/**
 * Retrieve a nested value from an object using a dot-separated path.
 * @param obj - The object to query
 * @param path - Dot-separated path to the value
 * @returns The value at the specified path, or undefined
 */
function getValueAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Manages versioned snapshots of pipeline configurations.
 * Supports saving versions, computing diffs between versions,
 * rolling back to previous versions, and tagging versions.
 */
export class PipelineVersioning {
  private readonly versions: Map<string, PipelineVersion[]> = new Map();

  /**
   * Save a new version of a pipeline configuration.
   * The version number is automatically incremented.
   * @param pipelineId - ID of the pipeline to version
   * @param config - The pipeline configuration to snapshot
   * @param metadata - Optional tag, annotation, and author metadata
   * @returns The newly created pipeline version
   */
  saveVersion(
    pipelineId: string,
    config: Record<string, unknown>,
    metadata?: VersionMetadata
  ): PipelineVersion {
    const pipelineVersions = this.versions.get(pipelineId) ?? [];
    const nextVersion = pipelineVersions.length > 0
      ? pipelineVersions[pipelineVersions.length - 1].version + 1
      : 1;

    const version: PipelineVersion = {
      versionId: generateId(),
      pipelineId,
      version: nextVersion,
      config: deepClone(config),
      tag: metadata?.tag,
      annotation: metadata?.annotation,
      createdAt: new Date().toISOString(),
      createdBy: metadata?.createdBy,
    };

    pipelineVersions.push(version);
    this.versions.set(pipelineId, pipelineVersions);
    return { ...version, config: deepClone(version.config) };
  }

  /**
   * List all versions for a pipeline, ordered by version number ascending.
   * @param pipelineId - ID of the pipeline
   * @returns Array of pipeline versions
   */
  listVersions(pipelineId: string): PipelineVersion[] {
    const pipelineVersions = this.versions.get(pipelineId) ?? [];
    return pipelineVersions.map((v) => ({ ...v, config: deepClone(v.config) }));
  }

  /**
   * Retrieve a specific version of a pipeline.
   * @param pipelineId - ID of the pipeline
   * @param version - The version number to retrieve
   * @returns The pipeline version, or undefined if not found
   */
  getVersion(pipelineId: string, version: number): PipelineVersion | undefined {
    const pipelineVersions = this.versions.get(pipelineId) ?? [];
    const found = pipelineVersions.find((v) => v.version === version);
    if (!found) {
      return undefined;
    }
    return { ...found, config: deepClone(found.config) };
  }

  /**
   * Retrieve the latest (highest version number) version of a pipeline.
   * @param pipelineId - ID of the pipeline
   * @returns The latest pipeline version, or undefined if no versions exist
   */
  getLatest(pipelineId: string): PipelineVersion | undefined {
    const pipelineVersions = this.versions.get(pipelineId) ?? [];
    if (pipelineVersions.length === 0) {
      return undefined;
    }
    const latest = pipelineVersions[pipelineVersions.length - 1];
    return { ...latest, config: deepClone(latest.config) };
  }

  /**
   * Compute the diff between two versions of a pipeline.
   * Walks both configs to find added, removed, and modified keys.
   * @param pipelineId - ID of the pipeline
   * @param v1 - First version number
   * @param v2 - Second version number
   * @returns The diff between the two versions, or undefined if either version is not found
   */
  diff(pipelineId: string, v1: number, v2: number): PipelineDiff | undefined {
    const version1 = this.getVersion(pipelineId, v1);
    const version2 = this.getVersion(pipelineId, v2);

    if (!version1 || !version2) {
      return undefined;
    }

    const keys1 = collectKeys(version1.config);
    const keys2 = collectKeys(version2.config);

    const added: string[] = [];
    const removed: string[] = [];
    const modified: Array<{ path: string; old: unknown; new: unknown }> = [];

    for (const key of keys2) {
      if (!keys1.has(key)) {
        added.push(key);
      }
    }

    for (const key of keys1) {
      if (!keys2.has(key)) {
        removed.push(key);
      }
    }

    for (const key of keys1) {
      if (keys2.has(key)) {
        const val1 = getValueAtPath(version1.config, key);
        const val2 = getValueAtPath(version2.config, key);
        if (JSON.stringify(val1) !== JSON.stringify(val2)) {
          modified.push({ path: key, old: val1, new: val2 });
        }
      }
    }

    return { added, removed, modified };
  }

  /**
   * Rollback a pipeline to a previous version by creating a new version
   * with the config from the target version.
   * @param pipelineId - ID of the pipeline
   * @param version - The version number to rollback to
   * @returns The newly created version (copy of the target), or undefined if the target is not found
   */
  rollback(pipelineId: string, version: number): PipelineVersion | undefined {
    const target = this.getVersion(pipelineId, version);
    if (!target) {
      return undefined;
    }

    return this.saveVersion(pipelineId, target.config, {
      annotation: `Rollback to version ${version}`,
    });
  }

  /**
   * Assign a tag to an existing pipeline version.
   * @param pipelineId - ID of the pipeline
   * @param version - The version number to tag
   * @param tag - The tag string to assign
   * @returns true if the tag was applied, false if the version was not found
   */
  tagVersion(pipelineId: string, version: number, tag: string): boolean {
    const pipelineVersions = this.versions.get(pipelineId) ?? [];
    const found = pipelineVersions.find((v) => v.version === version);
    if (!found) {
      return false;
    }
    found.tag = tag;
    return true;
  }
}
