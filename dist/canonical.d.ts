/**
 * Deterministic JSON for comparisons. Object keys are sorted. Array order
 * stays unchanged. Text is not trimmed.
 */
export declare function canonicalJson(value: unknown): string;
/** Hash one canonical JSON value. The same value always returns the same hash. */
export declare function contentHash(value: unknown): string;
