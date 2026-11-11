import { pluginFailure } from './errors.js'
import type { NativeEvent } from './sdk-runtime.js'

/**
 * Context window used when the CLI reports no value for a model.
 * This value is a documented fallback. It is not a measured provider limit.
 * Model discovery reads the window of each model from the CLI. A result message
 * that reports that model's `contextWindow` replaces both values.
 */
export const STATIC_CONTEXT_WINDOW_FALLBACK = 200_000

/** One capacity report from the SDK result message `modelUsage` entry. */
export interface MeasuredModelCapacity {
  /** Maximum combined request and response context in tokens. */
  readonly contextWindow: number
  /** Maximum output tokens of the model. */
  readonly maxOutputTokens: number
  /** Model key that the SDK result message used for this entry. */
  readonly nativeModel: string
}

/**
 * Process-wide capacity records, keyed by the model id this adapter requested.
 * The native result message is the only writer. A measurement stays valid for
 * the process lifetime because it describes the model, not one request.
 */
const measured = new Map<string, MeasuredModelCapacity>()

/** Read the measured capacity of one requested model, when one exists. */
export function measuredModelCapacity(model: string): MeasuredModelCapacity | undefined {
  return measured.get(model)
}

/**
 * Resolve the context window of one requested model.
 * Order: the result-message measurement, the window that model discovery read
 * from the CLI, then the static fallback.
 */
export function contextWindowFor(model: string, discovered?: number): number {
  return measured.get(model)?.contextWindow
    ?? (discovered !== undefined && isPositiveInteger(discovered) ? discovered : STATIC_CONTEXT_WINDOW_FALLBACK)
}

/**
 * Read the context window from one CLI context-usage report.
 * The report has two window fields. Use the smaller valid value, so the
 * reported window is not larger than a value the CLI states.
 */
export function contextWindowFromUsage(usage: {
  readonly maxTokens?: unknown
  readonly rawMaxTokens?: unknown
} | undefined): number | undefined {
  const values = [usage?.maxTokens, usage?.rawMaxTokens]
    .filter((value): value is number => typeof value === 'number' && isPositiveInteger(value))
  return values.length === 0 ? undefined : Math.min(...values)
}

/**
 * Record every `model-usage` event in one native turn.
 * A malformed event is refused. It does not silently change the cache.
 */
export function recordMeasuredModelUsage(events: readonly NativeEvent[]): void {
  for (const event of events) {
    if (event.type !== 'model-usage') continue
    if (event.model.trim() === '' || event.nativeModel.trim() === '') {
      throw pluginFailure('MALFORMED_RESPONSE', 'The native model-usage event has no model id.')
    }
    if (!isPositiveInteger(event.contextWindow) || !isPositiveInteger(event.maxOutputTokens)) {
      throw pluginFailure('MALFORMED_RESPONSE', 'The native model-usage event has invalid capacity values.')
    }
    measured.set(event.model, {
      contextWindow: event.contextWindow,
      maxOutputTokens: event.maxOutputTokens,
      nativeModel: event.nativeModel,
    })
  }
}

/**
 * Remove every measurement. Tests use this function to prove the fallback
 * path. It has no production caller.
 */
export function resetModelCapacityCache(): void {
  measured.clear()
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
