import { type PluginFailureCode } from './errors.js';
/**
 * Separate bounds. `generationMs` limits a model response.
 * `resultWaitMs` limits the dsh approval wait and is not the generation bound.
 */
export interface Deadlines {
    readonly initializationMs: number;
    readonly generationMs: number;
    readonly resultWaitMs: number;
    readonly closeMs: number;
}
export declare const DEFAULT_DEADLINES: Deadlines;
/** Race one operation with a deadline. The timer does not keep the process alive. */
export declare function withDeadline<T>(work: Promise<T>, timeoutMs: number, code: PluginFailureCode, message: string): Promise<T>;
