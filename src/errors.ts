import { LlmError } from '@deepseek-ai/dsh-llm'

/** Stable plugin failure codes. dsh keeps these names on the mapped failure. */
export const PLUGIN_FAILURE_CODES = [
  'INCOMPATIBLE_RUNTIME',
  'AUTH_ROUTE_REFUSED',
  'BILLING_GUARD_UNAVAILABLE',
  'PAID_USAGE_REFUSED',
  'REBASE_REQUIRED',
  'SESSION_BUSY',
  'REPLAY_STATE_INVALID',
  'NATIVE_CONTEXT_MISMATCH',
  'UNSUPPORTED_INPUT',
  'TOOL_RESULT_MISMATCH',
  'MALFORMED_RESPONSE',
  'NATIVE_OUTCOME_UNKNOWN',
] as const

export type PluginFailureCode = (typeof PLUGIN_FAILURE_CODES)[number]

/**
 * Build one non-retryable plugin failure.
 * The message must not include account data, tokens, or request bodies.
 *
 * dsh 0.2.2-rc.2 closed the `LlmError` constructor code type to its built-in
 * set. `LlmError.fromFailure` is the documented path for a provider-chosen
 * code string: it keeps the code as given, and a code outside the built-in
 * retry choices stays non-retryable.
 */
export function pluginFailure(code: PluginFailureCode, message: string): LlmError {
  return LlmError.fromFailure({ code, message })
}

/** True when a value is a plugin failure with this code. */
export function isPluginFailure(error: unknown, code: PluginFailureCode): boolean {
  return error instanceof LlmError && error.code === code
}
