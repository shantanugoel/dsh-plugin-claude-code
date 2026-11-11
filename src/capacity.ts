import { pluginFailure } from './errors.js'
import type { NativeEvent } from './sdk-runtime.js'

/**
 * Context window used before the native runtime reports a measurement.
 * This value is a documented fallback. It is not a measured provider limit.
 * The adapter replaces it for a model when the first result message reports
 * that model's `contextWindow`.
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

/** Resolve the context window of one requested model. */
export function contextWindowFor(model: string): number {
  return measured.get(model)?.contextWindow ?? STATIC_CONTEXT_WINDOW_FALLBACK
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
