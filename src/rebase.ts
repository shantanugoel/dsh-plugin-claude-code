import { LlmError } from '@deepseek-ai/dsh-llm'

import { pluginFailure } from './errors.js'

/** Require a recorded new generation. This does not perform the reset. */
export function rebaseRequired(detail: string): LlmError {
  return pluginFailure('REBASE_REQUIRED', detail)
}
