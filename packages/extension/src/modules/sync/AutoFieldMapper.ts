import type { FieldMapping, MappingType } from '@sandforge/shared';

/** Source/target field metadata for auto-mapping. */
export interface AutoMapFieldInfo {
  apiName: string;
  label: string;
  type: string;
}

/** Auto-mapping suggestion with confidence score. */
export interface AutoMapSuggestion {
  sourceField: string;
  targetField: string;
  type: MappingType;
  confidence: number;
  reason: string;
}

/**
 * Intelligent auto-mapper that matches source and target fields
 * using multiple matching strategies:
 * 1. Exact API name match
 * 2. Normalized name match (case-insensitive, strip suffixes)
 * 3. Label similarity match
 * 4. Type-compatible fallback match
 */
export class AutoFieldMapper {
  /** Minimum confidence threshold to include a suggestion (0-1). */
  private readonly minConfidence: number;

  constructor(minConfidence = 0.4) {
    this.minConfidence = minConfidence;
  }

  /**
   * Generate auto-mapping suggestions between source and target fields.
   * Returns suggestions sorted by confidence (highest first).
   */
  suggest(
    sourceFields: AutoMapFieldInfo[],
    targetFields: AutoMapFieldInfo[],
  ): AutoMapSuggestion[] {
    const suggestions: AutoMapSuggestion[] = [];
    const usedTargets = new Set<string>();

    // Sort source fields so required/important ones are matched first
    const sortedSource = [...sourceFields];

    for (const source of sortedSource) {
      let bestMatch: AutoMapSuggestion | undefined;

      for (const target of targetFields) {
        if (usedTargets.has(target.apiName)) continue;

        const score = this.computeScore(source, target);
        if (score.confidence > (bestMatch?.confidence ?? 0)) {
          bestMatch = score;
        }
      }

      if (bestMatch && bestMatch.confidence >= this.minConfidence) {
        suggestions.push(bestMatch);
        usedTargets.add(bestMatch.targetField);
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Convert suggestions to FieldMapping[] (only those above threshold).
   */
  toMappings(suggestions: AutoMapSuggestion[]): FieldMapping[] {
    return suggestions.map((s) => ({
      sourceField: s.sourceField,
      targetField: s.targetField,
      type: s.type,
    }));
  }

  /**
   * Compute match score between a source and target field.
   */
  private computeScore(
    source: AutoMapFieldInfo,
    target: AutoMapFieldInfo,
  ): AutoMapSuggestion {
    // Strategy 1: Exact API name match
    if (source.apiName === target.apiName) {
      return {
        sourceField: source.apiName,
        targetField: target.apiName,
        type: this.inferType(source, target),
        confidence: 1.0,
        reason: 'exact_name',
      };
    }

    // Strategy 2: Normalized name match (case-insensitive, strip __c, __r)
    const normalizedSource = this.normalize(source.apiName);
    const normalizedTarget = this.normalize(target.apiName);
    if (normalizedSource === normalizedTarget && normalizedSource.length > 0) {
      return {
        sourceField: source.apiName,
        targetField: target.apiName,
        type: this.inferType(source, target),
        confidence: 0.9,
        reason: 'normalized_name',
      };
    }

    // Strategy 3: Label similarity
    const labelSimilarity = this.stringSimilarity(
      source.label.toLowerCase(),
      target.label.toLowerCase(),
    );
    if (labelSimilarity >= 0.8) {
      return {
        sourceField: source.apiName,
        targetField: target.apiName,
        type: this.inferType(source, target),
        confidence: Math.min(0.85, labelSimilarity),
        reason: 'label_match',
      };
    }

    // Strategy 4: Partial name match + type compatibility
    const nameSimilarity = this.stringSimilarity(normalizedSource, normalizedTarget);
    const typeCompatible = this.isTypeCompatible(source.type, target.type);
    if (nameSimilarity >= 0.6 && typeCompatible) {
      return {
        sourceField: source.apiName,
        targetField: target.apiName,
        type: this.inferType(source, target),
        confidence: nameSimilarity * 0.7,
        reason: 'partial_match',
      };
    }

    // No match
    return {
      sourceField: source.apiName,
      targetField: target.apiName,
      type: 'direct',
      confidence: 0,
      reason: 'no_match',
    };
  }

  /** Normalize API name: lowercase, strip __c/__r suffixes, remove underscores. */
  private normalize(name: string): string {
    return name
      .replace(/__c$/i, '')
      .replace(/__r$/i, '')
      .replace(/_/g, '')
      .toLowerCase();
  }

  /** Compute string similarity (Dice coefficient). */
  private stringSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const bigramsA = this.bigrams(a);
    const bigramsB = this.bigrams(b);

    let intersection = 0;
    const bCopy = [...bigramsB];

    for (const bg of bigramsA) {
      const idx = bCopy.indexOf(bg);
      if (idx >= 0) {
        intersection++;
        bCopy.splice(idx, 1);
      }
    }

    return (2 * intersection) / (bigramsA.length + bigramsB.length);
  }

  /** Generate bigrams from a string. */
  private bigrams(str: string): string[] {
    const result: string[] = [];
    for (let i = 0; i < str.length - 1; i++) {
      result.push(str.slice(i, i + 2));
    }
    return result;
  }

  /** Check if two Salesforce field types are compatible. */
  private isTypeCompatible(sourceType: string, targetType: string): boolean {
    if (sourceType === targetType) return true;

    const textTypes = new Set(['string', 'textarea', 'richtext', 'url', 'email', 'phone']);
    const numericTypes = new Set(['double', 'currency', 'percent', 'int', 'integer', 'long']);
    const dateTypes = new Set(['date', 'datetime', 'time']);

    if (textTypes.has(sourceType) && textTypes.has(targetType)) return true;
    if (numericTypes.has(sourceType) && numericTypes.has(targetType)) return true;
    if (dateTypes.has(sourceType) && dateTypes.has(targetType)) return true;

    return false;
  }

  /** Infer the best mapping type based on source/target types. */
  private inferType(source: AutoMapFieldInfo, target: AutoMapFieldInfo): MappingType {
    if (source.apiName === target.apiName && source.type === target.type) {
      return 'direct';
    }
    if (source.apiName !== target.apiName) {
      return 'rename';
    }
    return 'direct';
  }
}
