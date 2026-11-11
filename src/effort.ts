import { ReasoningEffortId, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'

import { pluginFailure } from './errors.js'

/** Official effort levels, from least to greatest. Measured on 2026-11-10. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number]

const EFFORT_NAMES: Record<ClaudeEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

export function isClaudeEffort(value: string): value is ClaudeEffort {
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value)
}

/** Read one request effort. An unknown value is refused. */
export function claudeEffort(value: string | undefined): ClaudeEffort | undefined {
  if (value === undefined) return undefined
  if (!isClaudeEffort(value)) {
    throw pluginFailure('UNSUPPORTED_INPUT', `The reasoning effort "${value}" is not supported.`)
  }
  return value
}

/**
 * Selector metadata for one discovered model.
 * A model that does not report effort support has no selector.
 *
 * The SDK 0.3.322 `ModelInfo` type reports `supportsEffort` and
 * `supportedEffortLevels`. It has no `defaultEffort` field. Do not invent one.
 * A `defaultEffort` would materialize an effort into every request that omits
 * one, and the CLI reports no such value. Absence keeps the provider default.
 */
export function reasoningFor(model: {
  readonly supportsEffort?: boolean
  readonly supportedEffortLevels?: readonly string[]
} | undefined): LlmModelReasoningInfo | undefined {
  if (model?.supportsEffort !== true) return undefined
  const efforts = CLAUDE_EFFORT_LEVELS.filter((level) => model.supportedEffortLevels?.includes(level))
  if (efforts.length === 0) return undefined
  return {
    efforts: efforts.map((level) => ({ id: ReasoningEffortId(level), name: EFFORT_NAMES[level] })),
  }
}

/** Keep only official levels, in the selector order. */
export function recordedEffortLevels(levels: readonly string[] | undefined): readonly ClaudeEffort[] {
  return CLAUDE_EFFORT_LEVELS.filter((level) => levels?.includes(level))
}
