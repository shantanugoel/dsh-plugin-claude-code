import { pluginFailure } from './errors.js'

/**
 * Successful response-level replay data. Store it as `{ response: replayV1 }`.
 * Do not add a `blocks` field.
 */
export interface ReplayV1 {
  readonly format: 'claude-session-v1'
  readonly generationId: string
  readonly cliSessionId: string
  readonly cliVersion: string
  readonly sdkVersion: string
  readonly model: string
  readonly workspace: string
  readonly requestPrefixHash: string
  readonly projectedContentHash: string
  readonly nativeRequestRecord: unknown
  readonly nativeResponseBlocks: readonly unknown[]
  readonly toolNameMap: Readonly<Record<string, string>>
}

/** Refuse the per-block replay shape. Response-level data has no `blocks` field. */
export function rejectBlockReplay(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('blocks' in value)) return
  if (value.blocks === undefined) return
  throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data must not use a blocks field.')
}
