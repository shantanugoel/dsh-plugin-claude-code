import { pluginFailure } from './errors.js'

/** Why a new native generation replaced the earlier generation. */
export const GENERATION_CHANGE_REASONS = [
  'abort',
  'timeout',
  'process-loss',
  'restore',
  'fork',
  'configuration-change',
  'image-budget',
  'history-change',
  'invalid',
] as const

export type GenerationChangeReason = (typeof GENERATION_CHANGE_REASONS)[number]

/**
 * One recorded import. The successful turn stores it in the replay envelope,
 * and the dsh log keeps that envelope with the assistant message.
 * The import is plain text. It does not retain an old native signature.
 */
export interface GenerationChangeV1 {
  readonly reason: GenerationChangeReason
  /** Generation id of the replaced generation, or null without a live generation. */
  readonly fromGenerationId: string | null
  /** CLI session id of the replaced generation when it was known. */
  readonly fromCliSessionId: string | null
  /** Number of projected dsh messages that the import text quotes. */
  readonly importedMessageCount: number
  /** Canonical hash of those projected messages. */
  readonly importedPrefixHash: string
  /** ISO timestamp of the change. */
  readonly createdAt: string
  /** Configuration fields that changed, for reason `configuration-change`. */
  readonly changedFields?: readonly string[]
}

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
  readonly retentionAudit: 'accepted' | 'unavailable'
  /** The recorded import when this turn started a new native generation. */
  readonly generationChange?: GenerationChangeV1
  /**
   * Sanitized names of the tools that this response called outside the dsh
   * tool list. Absent when every call named a dsh tool. No arguments are kept.
   */
  readonly unknownToolNames?: readonly string[]
}

/** Refuse the per-block replay shape. Response-level data has no `blocks` field. */
export function rejectBlockReplay(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('blocks' in value)) return
  if (value.blocks === undefined) return
  throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data must not use a blocks field.')
}

/** Read one response envelope. A missing or changed field is refused. */
export function parseReplayEnvelope(value: unknown): ReplayV1 {
  rejectBlockReplay(value)
  if (!isRecord(value) || !('response' in value)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has no response envelope.')
  }
  return parseReplay(value['response'])
}

export function parseReplay(value: unknown): ReplayV1 {
  if (!isRecord(value)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data is not an object.')
  }
  if (value['format'] !== 'claude-session-v1') {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data uses an unknown format.')
  }
  const nativeResponseBlocks = value['nativeResponseBlocks']
  if (!Array.isArray(nativeResponseBlocks)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has no native response blocks.')
  }
  const toolNameMap = value['toolNameMap']
  if (!isStringRecord(toolNameMap)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has no tool-name map.')
  }
  const retentionAudit = value['retentionAudit']
  if (retentionAudit !== 'accepted' && retentionAudit !== 'unavailable') {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has no retention audit.')
  }
  if (retentionAudit === 'unavailable' && value['nativeRequestRecord'] !== null) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Unavailable retention evidence is stored as a request record.')
  }
  const generationChange = parseGenerationChange(value['generationChange'])
  const unknownToolNames = value['unknownToolNames']
  if (unknownToolNames !== undefined && (!isStringArray(unknownToolNames) || unknownToolNames.length === 0)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data has invalid unknown tool names.')
  }
  return {
    format: 'claude-session-v1',
    generationId: requiredString(value, 'generationId'),
    cliSessionId: requiredString(value, 'cliSessionId'),
    cliVersion: requiredString(value, 'cliVersion'),
    sdkVersion: requiredString(value, 'sdkVersion'),
    model: requiredString(value, 'model'),
    workspace: requiredString(value, 'workspace'),
    requestPrefixHash: requiredString(value, 'requestPrefixHash'),
    projectedContentHash: requiredString(value, 'projectedContentHash'),
    nativeRequestRecord: value['nativeRequestRecord'] ?? null,
    nativeResponseBlocks,
    toolNameMap,
    retentionAudit,
    ...(generationChange === undefined ? {} : { generationChange }),
    ...(unknownToolNames === undefined ? {} : { unknownToolNames: [...unknownToolNames] }),
  }
}

export function parseGenerationChange(value: unknown): GenerationChangeV1 | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The generation change is not an object.')
  }
  const reason = value['reason']
  if (typeof reason !== 'string' || !(GENERATION_CHANGE_REASONS as readonly string[]).includes(reason)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The generation change has an unknown reason.')
  }
  const fromGenerationId = nullableString(value, 'fromGenerationId')
  const fromCliSessionId = nullableString(value, 'fromCliSessionId')
  const importedMessageCount = value['importedMessageCount']
  if (typeof importedMessageCount !== 'number'
    || !Number.isSafeInteger(importedMessageCount)
    || importedMessageCount < 0) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The generation change has an invalid imported message count.')
  }
  const importedPrefixHash = requiredString(value, 'importedPrefixHash')
  const createdAt = requiredString(value, 'createdAt')
  if (!isIsoTimestamp(createdAt)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The generation change has an invalid timestamp.')
  }
  const changedFields = value['changedFields']
  if (changedFields !== undefined && !isStringArray(changedFields)) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'The generation change has invalid changed fields.')
  }
  if (reason === 'configuration-change' && changedFields === undefined) {
    throw pluginFailure('REPLAY_STATE_INVALID', 'A configuration change has no changed fields.')
  }
  return {
    reason: reason as GenerationChangeReason,
    fromGenerationId,
    fromCliSessionId,
    importedMessageCount,
    importedPrefixHash,
    createdAt,
    ...(changedFields === undefined ? {} : { changedFields }),
  }
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw pluginFailure('REPLAY_STATE_INVALID', 'Replay data is missing a required field.')
  }
  return value
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw pluginFailure('REPLAY_STATE_INVALID', `The generation change has an invalid ${key}.`)
  }
  return value
}

function isIsoTimestamp(value: string): boolean {
  const time = Date.parse(value)
  return !Number.isNaN(time) && new Date(time).toISOString() === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'string')
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
}
