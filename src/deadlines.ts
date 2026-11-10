import { pluginFailure, type PluginFailureCode } from './errors.js'

/**
 * Separate bounds. `generationMs` limits a model response.
 * `resultWaitMs` limits the dsh approval wait and is not the generation bound.
 */
export interface Deadlines {
  readonly initializationMs: number
  readonly generationMs: number
  readonly resultWaitMs: number
  readonly closeMs: number
}

export const DEFAULT_DEADLINES: Deadlines = {
  initializationMs: 30_000,
  generationMs: 120_000,
  resultWaitMs: 3_600_000,
  closeMs: 5_000,
}

/** Race one operation with a deadline. The timer does not keep the process alive. */
export function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  code: PluginFailureCode,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(pluginFailure(code, message)), timeoutMs)
    timer.unref?.()
  })
  timeout.catch(() => undefined)
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
